import { injectable, inject } from 'tsyringe';
import { PrismaClient, InvoiceStatus, ContactType, ObligationStatus, ObligationType, ProductServiceType, InventoryReferenceType, InventoryTransactionType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { InvoicingRepository } from './invoicing.repository';
import { AppError, NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { generateInvoicePdf } from './pdf.generator';
import { sendEmail } from '../../config/email';
import {
    CreateInvoiceDto,
    UpdateInvoiceDto,
    InvoiceQueryDto,
    UpdateInvoiceSettingsDto,
} from './invoicing.dto';

@injectable()
export class InvoicingService {
    constructor(
        private repository: InvoicingRepository,
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

        // Server-side calculations
        const { items, subtotal, taxAmount, discountAmount, totalAmount, amountDue } =
            await this.calculateInvoiceTotals(workspaceId, dto.items, dto.discountAmount);

        // Block negative totals
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
                },
            });

            // Create invoice items
            await tx.invoiceItem.createMany({
                data: items.map(item => ({
                    invoiceId: inv.id,
                    productServiceId: item.productServiceId || null,
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

        // Validate customer if changing
        if (dto.customerId) {
            const customer = await this.prisma.contact.findUnique({ where: { id: dto.customerId } });
            if (!customer || customer.workspaceId !== workspaceId || customer.type !== ContactType.CUSTOMER) {
                throw new AppError('Invalid customer', 400, 'INVALID_CUSTOMER');
            }
        }

        // Validate duplication if changing invoice number
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

            // Replace items
            await this.prisma.$transaction(async (tx) => {
                await tx.invoiceItem.deleteMany({ where: { invoiceId } });
                await tx.invoiceItem.createMany({
                    data: items.map(item => ({
                        invoiceId,
                        productServiceId: item.productServiceId || null,
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
                ...calculatedData,
            },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.INVOICE_UPDATED, resource: 'invoice', resourceId: invoiceId },
        });

        return this.repository.findById(updated.id);
    }

    // ═══════════════════════════════════════════════════════
    // ─── Send Invoice ──────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async sendInvoice(invoiceId: string, workspaceId: string, userId: string, cashbookId: string) {
        const invoice = await this.repository.findById(invoiceId);
        if (!invoice || invoice.workspaceId !== workspaceId) {
            throw new NotFoundError('Invoice');
        }

        if (invoice.status !== InvoiceStatus.DRAFT) {
            throw new AppError('Only DRAFT invoices can be sent', 400, 'INVALID_STATUS');
        }

        // Validate cashbook
        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: { id: true, workspaceId: true, isActive: true },
        });
        if (!cashbook || cashbook.workspaceId !== workspaceId || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        await this.prisma.$transaction(async (tx) => {
            // 1. Update invoice status to SENT
            await tx.invoice.update({
                where: { id: invoiceId },
                data: { status: InvoiceStatus.SENT },
            });

            // 2. Create RECEIVABLE obligation
            await tx.cashbookObligation.create({
                data: {
                    workspaceId,
                    cashbookId,
                    type: ObligationType.RECEIVABLE,
                    title: `Invoice ${invoice.invoiceNumber}`,
                    description: `Receivable for invoice ${invoice.invoiceNumber} - ${invoice.customer.name}`,
                    totalAmount: invoice.totalAmount,
                    outstandingAmount: invoice.amountDue,
                    status: ObligationStatus.OPEN,
                    dueDate: invoice.dueDate,
                    contactId: invoice.customerId,
                    referenceType: 'INVOICE',
                    referenceId: invoiceId,
                },
            });

            // 3. Inventory stock-out for PRODUCT items
            const productItems = invoice.items.filter(
                item => item.productService?.type === ProductServiceType.PRODUCT
            );
            if (productItems.length > 0) {
                for (const item of productItems) {
                    // Find inventory item by product name or linked productServiceId
                    // We use a raw query to find inventory items matching the product
                    const inventoryItems = await tx.inventoryItem.findMany({
                        where: {
                            workspaceId,
                            name: item.name,
                            isActive: true,
                        },
                        include: { stock: true },
                    });

                    if (inventoryItems.length > 0) {
                        const invItem = inventoryItems[0];
                        const qty = Math.round(Number(item.quantity));
                        if (qty > 0) {
                            await tx.inventoryTransaction.create({
                                data: {
                                    workspaceId,
                                    itemId: invItem.id,
                                    transactionType: InventoryTransactionType.SALE,
                                    quantity: -qty,
                                    unitCost: invItem.stock?.averageCost || new Decimal(0),
                                    totalCost: (invItem.stock?.averageCost || new Decimal(0)).mul(qty),
                                    sellingPrice: item.unitPrice,
                                    referenceType: InventoryReferenceType.INVOICE,
                                    referenceId: invoiceId,
                                    notes: `Stock-out for invoice ${invoice.invoiceNumber}`,
                                    createdById: userId,
                                },
                            });

                            // Update stock
                            if (invItem.stock) {
                                await tx.inventoryStock.update({
                                    where: { itemId: invItem.id },
                                    data: {
                                        quantityOnHand: { decrement: qty },
                                    },
                                });
                            }
                        }
                    }
                }
            }

            // 4. Audit
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.INVOICE_SENT, resource: 'invoice', resourceId: invoiceId },
            });
        });

        // 5. Generate PDF and send email (outside transaction, queued)
        try {
            if (invoice.customer.email) {
                const settings = await this.repository.getInvoiceSettings(workspaceId);
                const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
                const pdfBuffer = await generateInvoicePdf(invoice, settings, workspace?.name || 'Business');

                await sendEmail({
                    to: invoice.customer.email,
                    subject: `Invoice ${invoice.invoiceNumber} from ${workspace?.name || 'Business'}`,
                    html: `
                        <h2>Invoice ${invoice.invoiceNumber}</h2>
                        <p>Dear ${invoice.customer.name},</p>
                        <p>Please find attached your invoice for <strong>${invoice.currency} ${invoice.totalAmount}</strong>.</p>
                        <p>Due date: <strong>${new Date(invoice.dueDate).toLocaleDateString()}</strong></p>
                        ${invoice.notes ? `<p>${invoice.notes}</p>` : ''}
                        <p>Thank you for your business!</p>
                    `,
                    attachments: [{
                        filename: `${invoice.invoiceNumber}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf',
                    }],
                });
            }
        } catch (error) {
            // Email failure should not block the send operation
            // The invoice is already marked as SENT and obligation created
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

        // Cannot void if payments have been made
        if (new Decimal(invoice.amountPaid).greaterThan(0)) {
            throw new AppError('Cannot void an invoice with payments applied. Refund payments first.', 400, 'HAS_PAYMENTS');
        }

        await this.prisma.$transaction(async (tx) => {
            // Update invoice status
            await tx.invoice.update({
                where: { id: invoiceId },
                data: { status: InvoiceStatus.VOID },
            });

            // Cancel linked obligation if exists
            if (invoice.status === InvoiceStatus.SENT || invoice.status === InvoiceStatus.OVERDUE) {
                await tx.cashbookObligation.updateMany({
                    where: {
                        referenceType: 'INVOICE',
                        referenceId: invoiceId,
                        status: { not: ObligationStatus.CANCELLED },
                    },
                    data: { status: ObligationStatus.CANCELLED },
                });
            }

            // Reverse inventory transactions if any
            await this.reverseInvoiceInventory(tx, invoiceId, workspaceId);

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

        // Only DRAFT or VOID invoices can be deleted
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

        // Enrich with customer names
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
            // Create default settings
            settings = await this.prisma.invoiceSettings.create({
                data: { workspaceId },
            });
        }
        return settings;
    }

    async updateSettings(workspaceId: string, userId: string, dto: UpdateInvoiceSettingsDto) {
        // Upsert settings
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

    // ═══════════════════════════════════════════════════════
    // ─── Payment Sync (called from Entries hook) ───────────
    // ═══════════════════════════════════════════════════════

    /**
     * Called after an Entry payment is applied to an obligation that references an invoice.
     * Updates the invoice's amount_paid, amount_due, and status.
     * Runs inside the caller's transaction.
     */
    static async syncInvoicePayment(tx: any, obligationReferenceId: string, newOutstanding: Decimal) {
        const invoice = await tx.invoice.findUnique({
            where: { id: obligationReferenceId },
        });
        if (!invoice) return; // Not an invoice-linked obligation

        const totalAmount = new Decimal(invoice.totalAmount);
        const amountPaid = totalAmount.sub(newOutstanding);
        const amountDue = newOutstanding;

        let newStatus: InvoiceStatus;
        if (amountDue.lessThanOrEqualTo(0)) {
            newStatus = InvoiceStatus.PAID;
        } else if (amountPaid.greaterThan(0)) {
            newStatus = InvoiceStatus.PARTIALLY_PAID;
        } else {
            newStatus = invoice.status; // keep current
        }

        await tx.invoice.update({
            where: { id: obligationReferenceId },
            data: { amountPaid, amountDue, status: newStatus },
        });
    }

    // ═══════════════════════════════════════════════════════
    // ─── Helpers ───────────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    private async calculateInvoiceTotals(
        workspaceId: string,
        items: Array<{
            productServiceId?: string;
            name: string;
            description?: string;
            quantity: string;
            unitPrice: string;
            taxId?: string;
        }>,
        discountAmountStr?: string,
    ) {
        let subtotal = new Decimal(0);
        let totalTax = new Decimal(0);
        const discountAmount = discountAmountStr ? new Decimal(discountAmountStr) : new Decimal(0);

        const calculatedItems: Array<{
            productServiceId?: string;
            name: string;
            description?: string;
            quantity: Decimal;
            unitPrice: Decimal;
            taxId?: string;
            taxRate: Decimal;
            taxAmount: Decimal;
            total: Decimal;
        }> = [];

        // Collect all non-compound taxes first for compound calculation base
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

                    if (tax.isCompound) {
                        // Compound tax: calculated on (subtotal + non-compound taxes)
                        // We'll recalculate this in a second pass
                        taxAmount = new Decimal(0); // placeholder
                    } else {
                        taxAmount = lineTotal.mul(taxRate).div(100);
                    }
                }
            }

            subtotal = subtotal.add(lineTotal);

            calculatedItems.push({
                productServiceId: item.productServiceId,
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

        // Second pass: calculate compound taxes
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

        totalTax = calculatedItems.reduce((sum, i) => sum.add(i.taxAmount), new Decimal(0));
        const totalAmount = subtotal.sub(discountAmount).add(totalTax);
        const amountDue = totalAmount; // no payments yet

        return {
            items: calculatedItems,
            subtotal,
            taxAmount: totalTax,
            discountAmount,
            totalAmount,
            amountDue,
        };
    }

    private async reverseInvoiceInventory(tx: any, invoiceId: string, workspaceId: string) {
        const invTransactions = await tx.inventoryTransaction.findMany({
            where: {
                referenceType: InventoryReferenceType.INVOICE,
                referenceId: invoiceId,
            },
        });

        for (const t of invTransactions) {
            const qty = Math.abs(t.quantity);
            // Restore stock
            await tx.inventoryStock.update({
                where: { itemId: t.itemId },
                data: { quantityOnHand: { increment: qty } },
            });
        }

        // Delete the inventory transactions
        await tx.inventoryTransaction.deleteMany({
            where: {
                referenceType: InventoryReferenceType.INVOICE,
                referenceId: invoiceId,
            },
        });
    }
}
