import { injectable, inject } from 'tsyringe';
import { Prisma, PrismaClient, ObligationStatus, ObligationType, InventoryReferenceType } from '@prisma/client';
import { ObligationsRepository } from './obligations.repository';
import {
    CreateObligationDto,
    UpdateObligationDto,
    ObligationQueryDto,
} from './obligations.dto';
import { NotFoundError, AppError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { Decimal } from '@prisma/client/runtime/library';
import { InventoryService } from '../inventory/inventory.service';
import { config } from '../../config';
import { PostingService } from '../../core/ledger/posting.service';
import {
    buildObligationJournal,
    buildObligationWriteOffJournal,
} from '../../core/ledger/rules/obligation.rules';
import { withFinancialTransaction } from '../../core/db/transaction';
import { acquireLocks } from '../../core/db/locks';

@injectable()
export class ObligationsService {
    constructor(
        private obligationsRepo: ObligationsRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
        private inventoryService: InventoryService,
        private postingService: PostingService,
    ) { }

    // ─── List Obligations ──────────────────────────────
    async getObligations(cashbookId: string, query: ObligationQueryDto) {
        const { obligations, total } = await this.obligationsRepo.findByCashbookId(cashbookId, query);
        const totalPages = Math.ceil(total / query.limit);

        const obligationIds = obligations.map(o => o.id);
        const inventoryTransactions = obligationIds.length > 0 ? await this.prisma.inventoryTransaction.findMany({
            where: {
                referenceType: InventoryReferenceType.OBLIGATION,
                referenceId: { in: obligationIds }
            },
            include: {
                item: { select: { id: true, name: true, sku: true, unit: true } }
            }
        }) : [];

        const invMap = new Map();
        inventoryTransactions.forEach(it => {
            if (!invMap.has(it.referenceId)) invMap.set(it.referenceId, []);
            invMap.get(it.referenceId).push(it);
        });

        const mappedObligations = obligations.map(o => ({
            ...o,
            inventoryItems: invMap.get(o.id) || [],
        }));

        return {
            data: mappedObligations,
            pagination: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages,
                hasNext: query.page < totalPages,
                hasPrevious: query.page > 1,
            }
        };
    }

    // ─── Get Single Obligation ─────────────────────────
    async getObligation(id: string, cashbookId: string) {
        const obligation = await this.obligationsRepo.findById(id);
        if (!obligation) throw new NotFoundError('Obligation');

        // Verify obligation belongs to the cashbook the user has access to
        if (obligation.cashbookId !== cashbookId) {
            throw new NotFoundError('Obligation');
        }

        const inventoryTransactions = await this.prisma.inventoryTransaction.findMany({
            where: {
                referenceType: InventoryReferenceType.OBLIGATION,
                referenceId: id
            },
            include: {
                item: { select: { id: true, name: true, sku: true, unit: true } }
            }
        });

        return {
            ...obligation,
            inventoryItems: inventoryTransactions,
        };
    }

    // ─── Create Obligation ─────────────────────────────
    async createObligation(cashbookId: string, userId: string, dto: CreateObligationDto) {
        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: { workspaceId: true, isActive: true, currency: true }
        });

        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        if (dto.contactId) {
            const contact = await this.prisma.contact.findFirst({
                where: { id: dto.contactId, workspaceId: cashbook.workspaceId }
            });
            if (!contact) {
                throw new AppError('Contact not found or does not belong to this workspace', 404, 'NOT_FOUND');
            }
        }

        const amount = new Decimal(dto.totalAmount);

        const obligation = await this.prisma.$transaction(async (tx) => {
            const newObligation = await tx.cashbookObligation.create({
                data: {
                    workspaceId: cashbook.workspaceId,
                    cashbookId,
                    type: dto.type as any,
                    title: dto.title,
                    description: dto.description || null,
                    totalAmount: amount,
                    outstandingAmount: amount, // Initialize to total amount
                    status: ObligationStatus.OPEN,
                    dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
                    contactId: dto.contactId || null,
                }
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    action: AuditAction.OBLIGATION_CREATED,
                    resource: 'obligation',
                    resourceId: newObligation.id,
                    details: {
                        type: dto.type,
                        totalAmount: dto.totalAmount,
                        title: dto.title
                    } as any
                }
            });

            // Put the receivable/payable on the balance sheet, offset by a
            // deferred account so the P&L stays cash-basis. See obligation.rules.
            if (config.LEDGER_MODE !== 'off') {
                await this.postingService.post(
                    tx,
                    buildObligationJournal({
                        workspaceId: cashbook.workspaceId,
                        cashbookId,
                        obligationId: newObligation.id,
                        version: newObligation.version,
                        type: newObligation.type as 'RECEIVABLE' | 'PAYABLE',
                        totalAmount: amount,
                        title: newObligation.title,
                        entryDate: newObligation.dueDate ?? newObligation.createdAt,
                        currency: cashbook.currency,
                        createdById: userId,
                        contactId: newObligation.contactId,
                    }),
                    {
                        applyCaches: config.LEDGER_MODE === 'on',
                        onDuplicate: 'RETURN_EXISTING',
                    },
                );
            }

            // ─── Inventory Integration ──────────────────────────────
            // For PAYABLE obligations (goods purchases), stock-in the items
            if (dto.inventoryItems && dto.inventoryItems.length > 0 && dto.type === ObligationType.PAYABLE) {
                await this.inventoryService.processObligationInventory(
                    tx,
                    cashbook.workspaceId,
                    newObligation.id,
                    amount,
                    dto.inventoryItems,
                    userId,
                    dto.description || dto.title,
                    cashbook.currency,
                );
            }

            return newObligation;
        });

        return obligation;
    }

    // ─── Update Obligation ─────────────────────────────
    async updateObligation(id: string, cashbookId: string, userId: string, dto: UpdateObligationDto) {
        const existing = await this.obligationsRepo.findById(id);
        if (!existing || existing.archivedAt) {
            throw new NotFoundError('Obligation');
        }

        // Verify obligation belongs to the cashbook the user has access to
        if (existing.cashbookId !== cashbookId) {
            throw new NotFoundError('Obligation');
        }

        const updated = await this.prisma.$transaction(async (tx) => {
            const obligation = await tx.cashbookObligation.update({
                where: { id },
                data: {
                    ...(dto.title && { title: dto.title }),
                    ...(dto.description !== undefined && { description: dto.description }),
                    ...(dto.dueDate !== undefined && { dueDate: dto.dueDate ? new Date(dto.dueDate) : null }),
                }
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId: obligation.workspaceId,
                    action: AuditAction.OBLIGATION_UPDATED,
                    resource: 'obligation',
                    resourceId: id,
                    details: dto as any
                }
            });

            return obligation;
        });

        return updated;
    }

    // ─── Archive Obligation ────────────────────────────

    /**
     * Cancel an obligation and take whatever is still owed off the books.
     *
     * The write-off covers only the OUTSTANDING amount, not the original total:
     * reversing the opening journal would undo the full amount and drive AR
     * negative by whatever had already been collected. Amounts already settled —
     * and the revenue recognized against them — stay exactly as they were.
     *
     * This is the single path used by both invoice voiding and obligation
     * archiving, so a receivable can never be cancelled in one place while
     * remaining on the balance sheet.
     */
    async cancelObligation(
        obligationId: string,
        cashbookId: string,
        userId: string,
        reason: string,
    ) {
        const existing = await this.prisma.cashbookObligation.findUnique({
            where: { id: obligationId },
            select: { cashbookId: true },
        });
        if (!existing || existing.cashbookId !== cashbookId) {
            throw new NotFoundError('Obligation');
        }

        return withFinancialTransaction(this.prisma, async (tx) => {
            await acquireLocks(tx, [{ target: 'OBLIGATION', ids: [obligationId] }]);
            return this.cancelObligationInTx(tx, obligationId, userId, reason);
        });
    }

    /**
     * The cancellation core, for callers that already hold a transaction —
     * notably invoice voiding, which must cancel the obligation and void the
     * invoice atomically.
     *
     * Assumes the obligation row is already locked when called from a context
     * where concurrent settlement is possible.
     */
    async cancelObligationInTx(
        tx: Prisma.TransactionClient,
        obligationId: string,
        userId: string,
        reason: string,
    ) {
        const obligation = await tx.cashbookObligation.findUniqueOrThrow({
            where: { id: obligationId },
        });

        if (obligation.status === ObligationStatus.CANCELLED) {
            return obligation;
        }

        const cashbook = await tx.cashbook.findUniqueOrThrow({
            where: { id: obligation.cashbookId },
            select: { currency: true },
        });

        const outstanding = new Decimal(obligation.outstandingAmount);

        // Nothing owed means nothing to write off — cancelling a fully settled
        // obligation is bookkeeping housekeeping only.
        if (config.LEDGER_MODE !== 'off' && outstanding.greaterThan(0)) {
            await this.postingService.post(
                tx,
                buildObligationWriteOffJournal({
                    workspaceId: obligation.workspaceId,
                    cashbookId: obligation.cashbookId,
                    obligationId: obligation.id,
                    type: obligation.type as 'RECEIVABLE' | 'PAYABLE',
                    outstandingAmount: outstanding,
                    title: obligation.title,
                    entryDate: new Date(),
                    currency: cashbook.currency,
                    createdById: userId,
                    contactId: obligation.contactId,
                    reason,
                }),
                {
                    applyCaches: config.LEDGER_MODE === 'on',
                    onDuplicate: 'RETURN_EXISTING',
                },
            );
        }

        const updated = await tx.cashbookObligation.update({
            where: { id: obligationId },
            data: {
                status: ObligationStatus.CANCELLED,
                outstandingAmount: new Decimal(0),
            },
        });

        await tx.auditLog.create({
            data: {
                userId,
                workspaceId: obligation.workspaceId,
                action: AuditAction.OBLIGATION_CANCELLED,
                resource: 'obligation',
                resourceId: obligationId,
                details: {
                    reason,
                    writtenOff: outstanding.toString(),
                    previousStatus: obligation.status,
                } as any,
            },
        });

        return updated;
    }

    async archiveObligation(id: string, cashbookId: string, userId: string) {
        const existing = await this.obligationsRepo.findById(id);
        if (!existing) {
            throw new NotFoundError('Obligation');
        }

        // Verify obligation belongs to the cashbook the user has access to
        if (existing.cashbookId !== cashbookId) {
            throw new NotFoundError('Obligation');
        }

        if (existing.status !== ObligationStatus.OPEN && existing.status !== ObligationStatus.CANCELLED && existing.status !== ObligationStatus.PAID) {
            // we permit archiving PAID and CANCELLED, but not PARTIAL as it's mid-settlement
            throw new AppError('Cannot archive an obligation that is partially paid', 400, 'INVALID_STATUS');
        }

        if (existing.archivedAt) {
            throw new AppError('Obligation is already archived', 400, 'ALREADY_ARCHIVED');
        }

        const updated = await withFinancialTransaction(this.prisma, async (tx) => {
            await acquireLocks(tx, [{ target: 'OBLIGATION', ids: [id] }]);

            // Archiving an OPEN obligation means we are not collecting it, so
            // its receivable must come off the books too. Without this the
            // balance sheet would keep an asset nobody expects to realize, and
            // the AR control check would drift.
            if (existing.status === ObligationStatus.OPEN) {
                await this.cancelObligationInTx(tx, id, userId, 'Archived while still open');
            }

            const obligation = await tx.cashbookObligation.update({
                where: { id },
                data: { archivedAt: new Date() }
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId: obligation.workspaceId,
                    action: AuditAction.OBLIGATION_ARCHIVED,
                    resource: 'obligation',
                    resourceId: id,
                }
            });

            return obligation;
        });

        return updated;
    }

    // ─── Reporting ──────────────────────────────────────────

    async getOutstandingReceivables(cashbookId: string) {
        const aggregations = await this.prisma.cashbookObligation.aggregate({
            where: {
                cashbookId,
                type: ObligationType.RECEIVABLE,
                status: { in: [ObligationStatus.OPEN, ObligationStatus.PARTIAL] },
                archivedAt: null
            },
            _sum: { outstandingAmount: true },
            _count: { id: true }
        });
        return {
            totalAmount: aggregations._sum.outstandingAmount || new Decimal(0),
            count: aggregations._count.id
        };
    }

    async getOutstandingPayables(cashbookId: string) {
        const aggregations = await this.prisma.cashbookObligation.aggregate({
            where: {
                cashbookId,
                type: ObligationType.PAYABLE,
                status: { in: [ObligationStatus.OPEN, ObligationStatus.PARTIAL] },
                archivedAt: null
            },
            _sum: { outstandingAmount: true },
            _count: { id: true }
        });
        return {
            totalAmount: aggregations._sum.outstandingAmount || new Decimal(0),
            count: aggregations._count.id
        };
    }
}
