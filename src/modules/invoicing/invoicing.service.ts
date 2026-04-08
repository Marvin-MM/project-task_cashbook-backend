import { injectable, inject } from 'tsyringe';
import { PrismaClient, InvoiceStatus, ContactType, ObligationStatus, ObligationType, InventoryReferenceType, InventoryTransactionType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { InvoicingRepository } from './invoicing.repository';
import { AppError, NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { generateInvoicePdf } from './pdf.generator';
import { sendEmail } from '../../config/email';
import { invoiceEmailTemplate } from '../../utils/emailTemplates';
import { InventoryService } from '../inventory/inventory.service';
import {
    CreateInvoiceDto,
    UpdateInvoiceDto,
    InvoiceQueryDto,
    UpdateInvoiceSettingsDto,
} from './invoicing.dto';
import sharp from 'sharp';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../../config/cloudflare';
import { config } from '../../config';

// ─── Internal type for calculated line items ───────────────────────────────────
interface CalculatedItem {
    productServiceId?: string;
    inventoryItemId?: string;  // resolved from productService.inventoryItemId or item-level override
    name: string;
    description?: string;
    quantity: Decimal;
    unitPrice: Decimal;
    taxId?: string;
    taxRate: Decimal;
    taxAmount: Decimal;
    total: Decimal;
}

@injectable()
export class InvoicingService {
    constructor(
        private repository: InvoicingRepository,
        private inventoryService: InventoryService,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    // ═══════════════════════════════════════════════════════
    // ─── Create Invoice (DRAFT) ────────────────────────────
    // ═══════════════════════════════════════════════════════

    async createInvoice(workspaceId: string, userId: string, dto: CreateInvoiceDto) {
        // Validate customer
        const customer = await this.prisma.contact.findUnique({
            where: { id: dto.customerId },
            include: { customerProfile: true },
        });
        if (!customer || customer.workspaceId !== workspaceId || !customer.isActive) {
            throw new NotFoundError('Customer');
        }
        if (customer.type !== ContactType.CUSTOMER) {
            throw new AppError('Contact must be of type CUSTOMER to create an invoice', 400, 'INVALID_CUSTOMER_TYPE');
        }

        // Validate cashbook
        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: dto.cashbookId },
            select: { id: true, workspaceId: true, isActive: true },
        });
        if (!cashbook || cashbook.workspaceId !== workspaceId || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        // Generate invoice number if not provided
        const invoiceNumber = dto.invoiceNumber || await this.repository.getNextInvoiceNumber(workspaceId);

        // Check for duplicate invoice number
        const existingInvoice = await this.prisma.invoice.findUnique({
            where: { workspaceId_invoiceNumber: { workspaceId, invoiceNumber } },
        });
        if (existingInvoice) {
            throw new AppError('Invoice number already exists', 409, 'DUPLICATE_INVOICE_NUMBER');
        }

        // Validate due date >= issue date
        if (new Date(dto.dueDate) < new Date(dto.issueDate)) {
            throw new AppError('Due date must be on or after the issue date', 400, 'INVALID_DUE_DATE');
        }

        // Server-side calculations (resolves inventoryItemId via product service link)
        const { items, subtotal, taxAmount, discountAmount, totalAmount, amountDue } =
            await this.calculateInvoiceTotals(workspaceId, dto.items, dto.discountAmount);

        if (totalAmount.lessThan(0)) {
            throw new AppError('Invoice total cannot be negative', 400, 'NEGATIVE_TOTAL');
        }

        const invoice = await this.prisma.$transaction(async (tx) => {
            const inv = await tx.invoice.create({
                data: {
                    workspaceId,
                    customerId: dto.customerId,
                    invoiceNumber,
                    status: InvoiceStatus.DRAFT,
                    issueDate: new Date(dto.issueDate),
                    dueDate: new Date(dto.dueDate),
                    currency: dto.currency || 'UGX',
                    subtotal,
                    discountAmount,
                    taxAmount,
                    totalAmount,
                    amountPaid: new Decimal(0),
                    amountDue,
                    notes: dto.notes || null,
                    footer: dto.footer || null,
                    createdById: userId,
                    // Cast to any: cashbookId is a new schema field not yet in the stale Prisma client.
                    cashbookId: dto.cashbookId,
                } as any,
            });

            // Create invoice items — including the resolved inventoryItemId snapshot
            await tx.invoiceItem.createMany({
                data: items.map(item => ({
                    invoiceId: inv.id,
                    productServiceId: item.productServiceId || null,
                    inventoryItemId: item.inventoryItemId || null,
                    name: item.name,
                    description: item.description || null,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    taxId: item.taxId || null,
                    taxRate: item.taxRate,
                    taxAmount: item.taxAmount,
                    total: item.total,
                })),
            });

            await tx.auditLog.create({
                data: {
                    userId, workspaceId,
                    action: AuditAction.INVOICE_CREATED,
                    resource: 'invoice',
                    resourceId: inv.id,
                    details: { invoiceNumber, customerId: dto.customerId, totalAmount: totalAmount.toString() } as any,
                },
            });

            return inv;
        });

        return this.repository.findById(invoice.id);
    }

    // ═══════════════════════════════════════════════════════
    // ─── Update Invoice (DRAFT only) ───────────────────────
    // ═══════════════════════════════════════════════════════

    async updateInvoice(invoiceId: string, workspaceId: string, userId: string, dto: UpdateInvoiceDto) {
        const existing = await this.repository.findById(invoiceId);
        if (!existing || existing.workspaceId !== workspaceId) {
            throw new NotFoundError('Invoice');
        }

        if (existing.status !== InvoiceStatus.DRAFT) {
            throw new AppError('Only DRAFT invoices can be edited', 400, 'INVOICE_NOT_EDITABLE');
        }

        if (dto.customerId) {
            const customer = await this.prisma.contact.findUnique({ where: { id: dto.customerId } });
            if (!customer || customer.workspaceId !== workspaceId || customer.type !== ContactType.CUSTOMER) {
                throw new AppError('Invalid customer', 400, 'INVALID_CUSTOMER');
            }
        }

        if (dto.invoiceNumber && dto.invoiceNumber !== existing.invoiceNumber) {
            const dup = await this.prisma.invoice.findUnique({
                where: { workspaceId_invoiceNumber: { workspaceId, invoiceNumber: dto.invoiceNumber } },
            });
            if (dup) throw new AppError('Invoice number already exists', 409, 'DUPLICATE_INVOICE_NUMBER');
        }

        let calculatedData: any = {};
        if (dto.items) {
            const { items, subtotal, taxAmount, discountAmount, totalAmount, amountDue } =
                await this.calculateInvoiceTotals(workspaceId, dto.items, dto.discountAmount);

            if (totalAmount.lessThan(0)) {
                throw new AppError('Invoice total cannot be negative', 400, 'NEGATIVE_TOTAL');
            }

            calculatedData = { subtotal, taxAmount, discountAmount, totalAmount, amountDue };

            await this.prisma.$transaction(async (tx) => {
                await tx.invoiceItem.deleteMany({ where: { invoiceId } });
                await tx.invoiceItem.createMany({
                    data: items.map(item => ({
                        invoiceId,
                        productServiceId: item.productServiceId || null,
                        inventoryItemId: item.inventoryItemId || null,
                        name: item.name,
                        description: item.description || null,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        taxId: item.taxId || null,
                        taxRate: item.taxRate,
                        taxAmount: item.taxAmount,
                        total: item.total,
                    })),
                });
            });
        }

        const updated = await this.prisma.invoice.update({
            where: { id: invoiceId },
            data: {
                ...(dto.customerId && { customerId: dto.customerId }),
                ...(dto.invoiceNumber && { invoiceNumber: dto.invoiceNumber }),
                ...(dto.issueDate && { issueDate: new Date(dto.issueDate) }),
                ...(dto.dueDate && { dueDate: new Date(dto.dueDate) }),
                ...(dto.currency && { currency: dto.currency }),
                ...(dto.notes !== undefined && { notes: dto.notes }),
                ...(dto.footer !== undefined && { footer: dto.footer }),
                // Ignore TypeScript error during migration via any cast when picking fields
                ...({} as any),
                ...(dto.cashbookId && { cashbookId: dto.cashbookId }),
                ...calculatedData,
            } as any,
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.INVOICE_UPDATED, resource: 'invoice', resourceId: invoiceId },
        });

        return this.repository.findById(updated.id);
    }

    // ═══════════════════════════════════════════════════════
    // ─── Send Invoice ──────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async sendInvoice(invoiceId: string, workspaceId: string, userId: string) {
        const invoice = await this.repository.findById(invoiceId);
        if (!invoice || invoice.workspaceId !== workspaceId) {
            throw new NotFoundError('Invoice');
        }

        if (invoice.status !== InvoiceStatus.DRAFT) {
            throw new AppError('Only DRAFT invoices can be sent', 400, 'INVALID_STATUS');
        }

        const cashbookId = (invoice as any).cashbookId;
        if (!cashbookId) {
            throw new AppError('Invoice is not linked to a cashbook', 400, 'MISSING_CASHBOOK');
        }

        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: { id: true, workspaceId: true, isActive: true },
        });
        if (!cashbook || cashbook.workspaceId !== workspaceId || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        await this.prisma.$transaction(async (tx) => {
            // 1. Mark invoice as SENT
            await tx.invoice.update({
                where: { id: invoiceId },
                data: { status: InvoiceStatus.SENT },
            });

            // 2. Create a RECEIVABLE obligation linked back to this invoice
            await tx.cashbookObligation.create({
                data: {
                    workspaceId,
                    cashbookId,
                    type: ObligationType.RECEIVABLE,
                    title: `Invoice ${invoice.invoiceNumber}`,
                    description: `Receivable for invoice ${invoice.invoiceNumber} — ${invoice.customer.name}`,
                    totalAmount: invoice.totalAmount,
                    outstandingAmount: invoice.amountDue,
                    status: ObligationStatus.OPEN,
                    dueDate: invoice.dueDate,
                    contactId: invoice.customerId,
                    referenceType: 'INVOICE',
                    referenceId: invoiceId,
                },
            });

            // 3. Stock-out for every invoice line item that has a resolved inventoryItemId.
            //    We use the proper processStockOut path to ensure:
            //      - SELECT FOR UPDATE locking (no concurrent stock race)
            //      - Correct FIFO/LIFO/WAC COGS resolution
            //      - LotConsumption audit trail for FIFO/LIFO items
            //      - Negative-stock guard respects item's allowNegativeStock flag
            for (const lineItem of invoice.items) {
                if (!lineItem.inventoryItemId) continue; // service or free-text item — skip

                const qty = Math.round(Number(lineItem.quantity));
                if (qty <= 0) continue;

                await this.inventoryService.processStockOut(
                    workspaceId,
                    lineItem.inventoryItemId,
                    InventoryTransactionType.SALE,
                    qty,
                    userId,
                    InventoryReferenceType.INVOICE,
                    invoiceId,
                    `Stock-out for invoice ${invoice.invoiceNumber}`,
                    tx,                          // run inside same transaction
                    new Decimal(lineItem.unitPrice), // selling price for margin reporting
                );
            }

            // 4. Audit log
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.INVOICE_SENT, resource: 'invoice', resourceId: invoiceId },
            });
        });

        // 5. Generate ephemeral PDF and send professional email (outside transaction — failure is non-blocking)
        try {
            if (invoice.customer.email) {
                const [settings, workspace] = await Promise.all([
                    this.repository.getInvoiceSettings(workspaceId),
                    this.prisma.workspace.findUnique({ where: { id: workspaceId } }),
                ]);

                // Fetch the freshly-sent invoice with inventory item data for PDF
                const invoiceForPdf = await this.prisma.invoice.findUnique({
                    where: { id: invoiceId },
                    include: {
                        customer: {
                            select: { id: true, name: true, email: true, phone: true, company: true, customerProfile: true },
                        },
                        items: {
                            include: {
                                inventoryItem: { select: { name: true, sku: true, unit: true } },
                                tax: { select: { id: true, name: true, rate: true } },
                            },
                            orderBy: { id: 'asc' },
                        },
                    },
                });

                const businessName = workspace?.name || 'Business';
                const pdfBuffer = await generateInvoicePdf(
                    invoiceForPdf as any,
                    settings,
                    businessName,
                );

                // Build items summary for email body (≤5 shown inline, rest noted)
                const itemsSummary = (invoiceForPdf?.items || []).map(item => ({
                    name: item.name,
                    quantity: String(item.quantity),
                    total: Number(item.total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                }));

                const htmlBody = invoiceEmailTemplate({
                    customerName: invoice.customer.name,
                    businessName,
                    invoiceNumber: invoice.invoiceNumber,
                    currency: invoice.currency,
                    totalAmount: Number(invoice.totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                    dueDate: new Date(invoice.dueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                    itemsSummary,
                    notes: invoice.notes,
                    logoUrl: settings?.logoUrl || null,
                });

                await sendEmail({
                    to: invoice.customer.email,
                    subject: `Invoice ${invoice.invoiceNumber} from ${businessName}`,
                    html: htmlBody,
                    attachments: [{
                        filename: `${invoice.invoiceNumber}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf',
                    }],
                });
            }
        } catch (_err) {
            // Email / PDF failure must not roll back the send operation.
            // Invoice is already SENT and obligation already created.
        }

        return this.repository.findById(invoiceId);
    }

    // ═══════════════════════════════════════════════════════
    // ─── Void Invoice ──────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async voidInvoice(invoiceId: string, workspaceId: string, userId: string) {
        const invoice = await this.repository.findById(invoiceId);
        if (!invoice || invoice.workspaceId !== workspaceId) {
            throw new NotFoundError('Invoice');
        }

        if (invoice.status === InvoiceStatus.VOID) {
            throw new AppError('Invoice is already voided', 400, 'ALREADY_VOIDED');
        }

        if (new Decimal(invoice.amountPaid).greaterThan(0)) {
            throw new AppError(
                'Cannot void an invoice with payments applied. Refund payments first.',
                400,
                'HAS_PAYMENTS'
            );
        }

        await this.prisma.$transaction(async (tx) => {
            // 1. Mark invoice VOID
            await tx.invoice.update({
                where: { id: invoiceId },
                data: { status: InvoiceStatus.VOID },
            });

            // 2. Cancel the linked RECEIVABLE obligation if there is one
            if (
                invoice.status === InvoiceStatus.SENT ||
                invoice.status === InvoiceStatus.OVERDUE ||
                invoice.status === InvoiceStatus.PARTIALLY_PAID
            ) {
                await tx.cashbookObligation.updateMany({
                    where: {
                        referenceType: 'INVOICE',
                        referenceId: invoiceId,
                        status: { not: ObligationStatus.CANCELLED },
                    },
                    data: { status: ObligationStatus.CANCELLED },
                });
            }

            // 3. Reverse inventory stock-outs via RETURN_IN (proper lot restoration for FIFO/LIFO)
            await this.reverseInvoiceInventory(tx, invoice, workspaceId, userId);

            // 4. Audit
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.INVOICE_VOIDED, resource: 'invoice', resourceId: invoiceId },
            });
        });

        return this.repository.findById(invoiceId);
    }

    // ═══════════════════════════════════════════════════════
    // ─── Delete Invoice ────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async deleteInvoice(invoiceId: string, workspaceId: string, userId: string) {
        const invoice = await this.repository.findById(invoiceId);
        if (!invoice || invoice.workspaceId !== workspaceId) {
            throw new NotFoundError('Invoice');
        }

        if (invoice.status !== InvoiceStatus.DRAFT && invoice.status !== InvoiceStatus.VOID) {
            throw new AppError('Only DRAFT or VOID invoices can be deleted', 400, 'CANNOT_DELETE');
        }

        if (new Decimal(invoice.amountPaid).greaterThan(0)) {
            throw new AppError('Cannot delete an invoice with payments applied', 400, 'HAS_PAYMENTS');
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.invoiceItem.deleteMany({ where: { invoiceId } });
            await tx.invoice.delete({ where: { id: invoiceId } });

            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.INVOICE_DELETED, resource: 'invoice', resourceId: invoiceId },
            });
        });
    }

    // ═══════════════════════════════════════════════════════
    // ─── Get / List ────────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async getInvoice(invoiceId: string, workspaceId: string) {
        const invoice = await this.repository.findById(invoiceId);
        if (!invoice || invoice.workspaceId !== workspaceId) throw new NotFoundError('Invoice');
        return invoice;
    }

    async listInvoices(workspaceId: string, query: InvoiceQueryDto) {
        const page = Number(query.page) || 1;
        const limit = Number(query.limit) || 20;
        const skip = (page - 1) * limit;

        const { invoices, total } = await this.repository.findByWorkspace(workspaceId, {
            skip,
            take: limit,
            status: query.status as InvoiceStatus | undefined,
            customerId: query.customerId,
            startDate: query.startDate,
            endDate: query.endDate,
            sortBy: query.sortBy || 'createdAt',
            sortOrder: query.sortOrder || 'desc',
        });

        const totalPages = Math.ceil(total / limit);
        return {
            data: invoices,
            pagination: {
                page, limit, total, totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1,
            },
        };
    }

    // ═══════════════════════════════════════════════════════
    // ─── Reporting ─────────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async getOverdueInvoices(workspaceId: string) {
        return this.repository.findOverdueInvoices(workspaceId);
    }

    async getInvoiceSummary(workspaceId: string) {
        const [totalReceivables, overdueCount, statusCounts] = await Promise.all([
            this.prisma.invoice.aggregate({
                where: { workspaceId, status: { in: [InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE] } },
                _sum: { amountDue: true },
            }),
            this.prisma.invoice.count({
                where: { workspaceId, status: { in: [InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID] }, dueDate: { lt: new Date() } },
            }),
            this.prisma.invoice.groupBy({
                by: ['status'],
                where: { workspaceId },
                _count: { id: true },
                _sum: { totalAmount: true },
            }),
        ]);

        return {
            totalReceivables: totalReceivables._sum.amountDue?.toString() || '0',
            overdueCount,
            byStatus: statusCounts.map(s => ({
                status: s.status,
                count: s._count.id,
                totalAmount: s._sum.totalAmount?.toString() || '0',
            })),
        };
    }

    async getCustomerOutstanding(workspaceId: string) {
        const results = await this.prisma.invoice.groupBy({
            by: ['customerId'],
            where: {
                workspaceId,
                status: { in: [InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE] },
            },
            _sum: { amountDue: true },
            _count: { id: true },
        });

        const customerIds = results.map(r => r.customerId);
        const customers = await this.prisma.contact.findMany({
            where: { id: { in: customerIds } },
            select: { id: true, name: true, email: true },
        });
        const customerMap = new Map(customers.map(c => [c.id, c]));

        return results.map(r => ({
            customer: customerMap.get(r.customerId) || { id: r.customerId, name: 'Unknown' },
            outstandingAmount: r._sum.amountDue?.toString() || '0',
            invoiceCount: r._count.id,
        }));
    }

    // ═══════════════════════════════════════════════════════
    // ─── Invoice Settings ──────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async getSettings(workspaceId: string) {
        let settings = await this.repository.getInvoiceSettings(workspaceId);
        if (!settings) {
            settings = await this.prisma.invoiceSettings.create({ data: { workspaceId } });
        }
        return settings;
    }

    async updateSettings(workspaceId: string, userId: string, dto: UpdateInvoiceSettingsDto) {
        const settings = await this.prisma.invoiceSettings.upsert({
            where: { workspaceId },
            create: { workspaceId, ...dto },
            update: dto,
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.INVOICE_SETTINGS_UPDATED, resource: 'invoice_settings', resourceId: settings.id },
        });

        return settings;
    }

    async uploadLogo(workspaceId: string, userId: string, file: Express.Multer.File) {
        // 1. Process image via Sharp: Resize if huge, compress layout, convert explicitly to PNG
        const processedBuffer = await sharp(file.buffer)
            .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
            .png({ quality: 85, compressionLevel: 9 })
            .toBuffer();

        // 2. Ship to Cloudflare R2
        const fileName = `logos/${workspaceId}-${Date.now()}.png`;

        await r2Client.send(new PutObjectCommand({
            Bucket: config.CF_R2_BUCKET_NAME,
            Key: fileName,
            Body: processedBuffer,
            ContentType: 'image/png',
        }));

        const logoUrl = `${config.CF_R2_PUBLIC_URL}/${fileName}`;

        // 3. Reflect onto Database
        const settings = await this.prisma.invoiceSettings.upsert({
            where: { workspaceId },
            create: { workspaceId, logoUrl },
            update: { logoUrl },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.INVOICE_SETTINGS_UPDATED, resource: 'invoice_settings', resourceId: settings.id },
        });

        return settings;
    }

    // ═══════════════════════════════════════════════════════
    // ─── Payment Sync (called from Entries hook) ───────────
    // ═══════════════════════════════════════════════════════

    /**
     * Called after an Entry payment is applied to an obligation that references an invoice.
     * Updates the invoice's amount_paid, amount_due, and status.
     * Must run inside the caller's Prisma transaction.
     */
    static async syncInvoicePayment(tx: any, obligationReferenceId: string, newOutstanding: Decimal) {
        const invoice = await tx.invoice.findUnique({ where: { id: obligationReferenceId } });
        if (!invoice) return;

        const totalAmount = new Decimal(invoice.totalAmount);
        const amountPaid = totalAmount.sub(newOutstanding);
        const amountDue = newOutstanding;

        let newStatus: InvoiceStatus;
        if (amountDue.lessThanOrEqualTo(0)) {
            newStatus = InvoiceStatus.PAID;
        } else if (amountPaid.greaterThan(0)) {
            newStatus = InvoiceStatus.PARTIALLY_PAID;
        } else {
            newStatus = invoice.status;
        }

        await tx.invoice.update({
            where: { id: obligationReferenceId },
            data: { amountPaid, amountDue, status: newStatus },
        });
    }

    // ═══════════════════════════════════════════════════════
    // ─── Private Helpers ───────────────────────────────────
    // ═══════════════════════════════════════════════════════

    /**
     * Calculate all invoice totals server-side using Decimal.js precision.
     *
     * Also auto-resolves inventoryItemId from the linked ProductService so that
     * sendInvoice can reliably determine which physical stock item to decrement
     * without any fragile name-matching.
     */
    private async calculateInvoiceTotals(
        workspaceId: string,
        items: Array<{
            productServiceId?: string;
            inventoryItemId?: string;  // can also be provided explicitly on free-text goods lines
            name: string;
            description?: string;
            quantity: string;
            unitPrice: string;
            taxId?: string;
        }>,
        discountAmountStr?: string,
    ): Promise<{
        items: CalculatedItem[];
        subtotal: Decimal;
        taxAmount: Decimal;
        discountAmount: Decimal;
        totalAmount: Decimal;
        amountDue: Decimal;
    }> {
        let subtotal = new Decimal(0);
        const discountAmount = discountAmountStr ? new Decimal(discountAmountStr) : new Decimal(0);
        const calculatedItems: CalculatedItem[] = [];

        for (const item of items) {
            const qty = new Decimal(item.quantity);
            const price = new Decimal(item.unitPrice);
            const lineTotal = qty.mul(price);

            let taxRate = new Decimal(0);
            let taxAmount = new Decimal(0);
            let taxId: string | undefined;

            if (item.taxId) {
                const tax = await this.prisma.tax.findUnique({ where: { id: item.taxId } });
                if (tax && tax.workspaceId === workspaceId && tax.isActive) {
                    taxRate = new Decimal(tax.rate);
                    taxId = tax.id;
                    // Compound taxes deferred to second pass
                    taxAmount = tax.isCompound ? new Decimal(0) : lineTotal.mul(taxRate).div(100);
                }
            }

            // ── Resolve inventoryItemId ───────────────────────────────
            // Priority: 1) explicit override on the line item
            //           2) productService.inventoryItemId
            //           3) null (service or free-text item — no stock affected)
            let resolvedInventoryItemId: string | undefined = item.inventoryItemId;

            if (!resolvedInventoryItemId && item.productServiceId) {
                const ps = await this.prisma.productService.findUnique({
                    where: { id: item.productServiceId },
                    select: { inventoryItemId: true, workspaceId: true },
                });
                if (ps && ps.workspaceId === workspaceId && ps.inventoryItemId) {
                    resolvedInventoryItemId = ps.inventoryItemId;
                }
            }

            subtotal = subtotal.add(lineTotal);

            calculatedItems.push({
                productServiceId: item.productServiceId,
                inventoryItemId: resolvedInventoryItemId,
                name: item.name,
                description: item.description,
                quantity: qty,
                unitPrice: price,
                taxId,
                taxRate,
                taxAmount,
                total: lineTotal.add(taxAmount),
            });
        }

        // Second pass: resolve compound taxes (tax on line total + non-compound taxes)
        const nonCompoundTax = calculatedItems.reduce((sum, i) => sum.add(i.taxAmount), new Decimal(0));
        for (const item of calculatedItems) {
            if (item.taxId) {
                const tax = await this.prisma.tax.findUnique({ where: { id: item.taxId } });
                if (tax && tax.isCompound) {
                    const base = item.quantity.mul(item.unitPrice).add(nonCompoundTax);
                    item.taxAmount = base.mul(item.taxRate).div(100);
                    item.total = item.quantity.mul(item.unitPrice).add(item.taxAmount);
                }
            }
        }

        const totalTax = calculatedItems.reduce((sum, i) => sum.add(i.taxAmount), new Decimal(0));
        const totalAmount = subtotal.sub(discountAmount).add(totalTax);

        return {
            items: calculatedItems,
            subtotal,
            taxAmount: totalTax,
            discountAmount,
            totalAmount,
            amountDue: totalAmount,
        };
    }

    /**
     * Reverse inventory stock-outs when an invoice is voided.
     *
     * Uses processStockIn (RETURN_IN) instead of raw stock increments so that:
     * - WAC average cost is recalculated correctly
     * - A new lot is created for FIFO/LIFO items at the same unit cost as the original sale
     * This preserves full audit trail integrity.
     */
    private async reverseInvoiceInventory(tx: any, invoice: any, workspaceId: string, userId: string) {
        // Only reverse if this invoice was ever sent (stock-out happened on SENT transition)
        if (
            invoice.status !== InvoiceStatus.SENT &&
            invoice.status !== InvoiceStatus.OVERDUE &&
            invoice.status !== InvoiceStatus.PARTIALLY_PAID
        ) {
            return;
        }

        // Find every inventory transaction created for this invoice
        const invTransactions = await tx.inventoryTransaction.findMany({
            where: {
                referenceType: InventoryReferenceType.INVOICE,
                referenceId: invoice.id,
                transactionType: InventoryTransactionType.SALE,
            },
        });

        for (const t of invTransactions) {
            const qty = Math.abs(Number(t.quantity));
            if (qty <= 0) continue;

            // RETURN_IN: stock-in at the same unit cost as the original outflow (COGS cost)
            await this.inventoryService.processStockIn(
                workspaceId,
                t.itemId,
                InventoryTransactionType.RETURN_IN,
                qty,
                new Decimal(t.unitCost), // restore at the COGS unit cost recorded on the SALE
                userId,
                InventoryReferenceType.INVOICE,
                invoice.id,
                `Inventory reversal for voided invoice ${invoice.invoiceNumber}`,
                tx,
            );
        }
    }
}
