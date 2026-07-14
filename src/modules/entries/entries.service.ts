import { injectable, inject } from 'tsyringe';
import { PrismaClient, TransactionSourceType, InventoryReferenceType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { EntriesRepository } from './entries.repository';
import {
    NotFoundError,
    AppError,
    ConflictError,
} from '../../core/errors/AppError';
import {
    AuditAction,
    CashbookRole,
    EntryType,
} from '../../core/types';
import {
    CreateEntryDto,
    UpdateEntryDto,
    DeleteEntryDto,
    ReviewDeleteRequestDto,
    EntryQueryDto,
} from './entries.dto';
import { logger } from '../../utils/logger';
import { isDateInPast } from '../../utils/helpers';
import { CashbookPermission, hasPermission } from '../../core/types/permissions';
import { ObligationStatus, ObligationType } from '@prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { generateReceiptPdf } from './receipt.generator';
import { receiptEmailTemplate } from '../../utils/emailTemplates';
import { sendEmail } from '../../config/email';
import {
    cashbookIncrementPayload,
    effectiveCashAmount,
    obligationStatusFromAmounts,
    walletBalanceDelta,
} from '../../core/finance';

@injectable()
export class EntriesService {
    constructor(
        private entriesRepository: EntriesRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
        private inventoryService: InventoryService,
    ) { }

    // ─── List Entries ──────────────────────────────────
    async getEntries(cashbookId: string, query: EntryQueryDto) {
        const { entries, total } = await this.entriesRepository.findByCashbookId(cashbookId, {
            page: query.page,
            limit: query.limit,
            type: query.type,
            categoryId: query.categoryId,
            contactId: query.contactId,
            paymentModeId: query.paymentModeId,
            startDate: query.startDate,
            endDate: query.endDate,
            sortBy: query.sortBy,
            sortOrder: query.sortOrder,
        });

        const totalPages = Math.ceil(total / query.limit);

        const entryIds = entries.map(e => e.id);
        const inventoryTransactions = entryIds.length > 0 ? await this.prisma.inventoryTransaction.findMany({
            where: {
                referenceType: InventoryReferenceType.ENTRY,
                referenceId: { in: entryIds }
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

        const mappedEntries = entries.map(entry => {
            const { accountTransactions, ...rest } = entry as any;
            return {
                ...rest,
                account: accountTransactions?.[0]?.account || null,
                inventoryItems: invMap.get(entry.id) || [],
            };
        });

        return {
            data: mappedEntries,
            pagination: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages,
                hasNext: query.page < totalPages,
                hasPrevious: query.page > 1,
            },
        };
    }

    // ─── Get Single Entry ─────────────────────────────
    async getEntry(entryId: string) {
        const entry = await this.entriesRepository.findById(entryId);
        if (!entry || entry.isDeleted) {
            throw new NotFoundError('Entry');
        }
        const inventoryTransactions = await this.prisma.inventoryTransaction.findMany({
            where: {
                referenceType: InventoryReferenceType.ENTRY,
                referenceId: entryId
            },
            include: {
                item: { select: { id: true, name: true, sku: true, unit: true } }
            }
        });

        const { accountTransactions, ...rest } = entry as any;
        return {
            ...rest,
            account: accountTransactions?.[0]?.account || null,
            inventoryItems: inventoryTransactions,
        };
    }

    // ─── Create Entry ─────────────────────────────────
    async createEntry(cashbookId: string, userId: string, dto: CreateEntryDto) {
        // Get cashbook for backdate check
        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: cashbookId },
        });

        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        const entryDate = new Date(dto.entryDate);

        // Check backdate rule
        if (!cashbook.allowBackdate && isDateInPast(entryDate)) {
            throw new AppError(
                'Backdated entries are not allowed for this cashbook',
                400,
                'BACKDATE_NOT_ALLOWED'
            );
        }

        const amount = new Decimal(dto.amount);

        // Account Logic - Pre-validation
        if (dto.accountId) {
            const account = await this.prisma.account.findUnique({
                where: { id: dto.accountId }
            });

            if (!account || account.workspaceId !== cashbook.workspaceId) {
                throw new AppError('Invalid account selected', 400, 'INVALID_ACCOUNT');
            }

            if (account.archivedAt) {
                throw new AppError('Cannot create entries for an archived account', 400, 'ACCOUNT_ARCHIVED');
            }

            // Currency mismatch check (Issue 4)
            if (account.currency !== cashbook.currency) {
                throw new AppError(
                    `Account currency (${account.currency}) does not match cashbook currency (${cashbook.currency})`,
                    400,
                    'CURRENCY_MISMATCH'
                );
            }
        }

        // Obligation Pre-validation requirements
        if (dto.obligationId) {
            const obligation = await this.prisma.cashbookObligation.findUnique({
                where: { id: dto.obligationId }
            });

            if (!obligation) {
                throw new NotFoundError('Obligation');
            }

            if (obligation.cashbookId !== cashbookId || obligation.workspaceId !== cashbook.workspaceId) {
                throw new AppError('Obligation does not belong to this cashbook', 400, 'INVALID_OBLIGATION');
            }

            if (obligation.archivedAt) {
                throw new AppError('Cannot apply payment to an archived obligation', 400, 'OBLIGATION_ARCHIVED');
            }

            if (obligation.status === ObligationStatus.PAID || obligation.status === ObligationStatus.CANCELLED) {
                throw new AppError(`Cannot apply payment to an obligation that is ${obligation.status.toLowerCase()}`, 400, 'INVALID_OBLIGATION_STATUS');
            }

            if (obligation.type === ObligationType.RECEIVABLE && dto.type !== EntryType.INCOME) {
                throw new AppError('Receivables must be settled with INCOME entries', 400, 'DIRECTION_MISMATCH');
            }

            if (obligation.type === ObligationType.PAYABLE && dto.type !== EntryType.EXPENSE) {
                throw new AppError('Payables must be settled with EXPENSE entries', 400, 'DIRECTION_MISMATCH');
            }

            if (amount.greaterThan(obligation.outstandingAmount)) {
                throw new AppError(`Payment amount ${amount.toString()} exceeds outstanding balance of ${obligation.outstandingAmount.toString()}`, 400, 'OVERPAYMENT');
            }
        }

        // Use transaction for concurrency safety
        const entry = await this.prisma.$transaction(async (tx) => {
            // Read cashbook inside transaction for accurate balanceBefore (Issue 7)
            const lockedCashbook = await tx.cashbook.findUniqueOrThrow({
                where: { id: cashbookId },
            });

            // Create entry
            const newEntry = await tx.entry.create({
                data: {
                    cashbookId,
                    type: dto.type as any,
                    amount,
                    chargeAmount: dto.chargeAmount ? new Decimal(dto.chargeAmount) : null,
                    description: dto.description,
                    categoryId: dto.categoryId || null,
                    contactId: dto.contactId || null,
                    paymentModeId: dto.paymentModeId || null,
                    obligationId: dto.obligationId || null,
                    entryDate,
                    createdById: userId,
                },
                include: {
                    category: true,
                    contact: true,
                    paymentMode: true,
                    createdBy: {
                        select: { id: true, email: true, firstName: true, lastName: true },
                    },
                },
            });

            // Update cashbook: totals always; balance only if not wallet-linked
            const balanceBefore = lockedCashbook.balance;
            const chargeAmount = dto.chargeAmount ? new Decimal(dto.chargeAmount) : new Decimal(0);
            const hasWalletLink = Boolean(dto.accountId);

            const cashbookPayload = cashbookIncrementPayload(
                dto.type,
                amount,
                chargeAmount,
                hasWalletLink,
                'apply',
            );

            await tx.cashbook.update({
                where: { id: cashbookId },
                data: cashbookPayload,
            });

            const balanceAfter = hasWalletLink
                ? balanceBefore
                : balanceBefore.add(walletBalanceDelta(dto.type, amount, chargeAmount));

            if (dto.accountId) {
                await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${dto.accountId}::uuid FOR UPDATE`;

                const lockedAccount = await tx.account.findUniqueOrThrow({
                    where: { id: dto.accountId }
                });

                const walletDelta = walletBalanceDelta(dto.type, amount, chargeAmount);
                if (!lockedAccount.allowNegative && walletDelta.lessThan(0)) {
                    const newAccountBalance = lockedAccount.balance.add(walletDelta);
                    if (newAccountBalance.lessThan(0)) {
                        throw new AppError(`Transaction exceeds account balance. Current balance is ${lockedAccount.balance.toString()}`, 400, 'INSUFFICIENT_FUNDS');
                    }
                }

                await tx.account.update({
                    where: { id: dto.accountId },
                    data: { balance: { increment: walletDelta } }
                });

                await this.upsertCashbookAccountTransaction(tx, {
                    workspaceId: cashbook.workspaceId,
                    accountId: dto.accountId,
                    sourceId: newEntry.id,
                    type: dto.type,
                    amount,
                    chargeAmount: chargeAmount.greaterThan(0) ? chargeAmount : null,
                    description: newEntry.description,
                });
            }

            if (dto.obligationId) {
                // Block inventory on payment entries if obligation already stocked goods
                if (dto.inventoryItems && dto.inventoryItems.length > 0) {
                    const existingOblInv = await tx.inventoryTransaction.count({
                        where: {
                            referenceType: InventoryReferenceType.OBLIGATION,
                            referenceId: dto.obligationId,
                        },
                    });
                    if (existingOblInv > 0) {
                        throw new AppError(
                            'This obligation already has inventory stock movements. Do not attach inventoryItems on the payment entry (avoids double stock-in).',
                            400,
                            'INVENTORY_DOUBLE_APPLY',
                        );
                    }
                }

                await tx.$queryRaw`SELECT id FROM cashbook_obligations WHERE id = ${dto.obligationId}::uuid FOR UPDATE`;

                const lockedObligation = await tx.cashbookObligation.findUniqueOrThrow({
                    where: { id: dto.obligationId }
                });

                if (amount.greaterThan(lockedObligation.outstandingAmount)) {
                    throw new AppError(`Concurrent payment exceeded outstanding balance`, 400, 'OVERPAYMENT');
                }

                const newOutstanding = lockedObligation.outstandingAmount.sub(amount);
                const newStatus = obligationStatusFromAmounts(
                    lockedObligation.totalAmount,
                    newOutstanding,
                    lockedObligation.status,
                ) as ObligationStatus;

                await tx.cashbookObligation.update({
                    where: { id: dto.obligationId },
                    data: {
                        outstandingAmount: newOutstanding,
                        status: newStatus
                    }
                });

                await tx.auditLog.create({
                    data: {
                        userId,
                        workspaceId: cashbook.workspaceId,
                        action: AuditAction.OBLIGATION_PAYMENT_APPLIED,
                        resource: 'obligation',
                        resourceId: dto.obligationId,
                        details: {
                            entryId: newEntry.id,
                            appliedAmount: amount,
                            previousOutstanding: lockedObligation.outstandingAmount,
                            newOutstanding,
                            statusBefore: lockedObligation.status,
                            statusAfter: newStatus
                        } as any
                    }
                });

                const { InvoicingService } = await import('../invoicing/invoicing.service');
                await InvoicingService.syncInvoiceFromObligation(tx, {
                    referenceType: lockedObligation.referenceType,
                    referenceId: lockedObligation.referenceId,
                    outstandingAmount: newOutstanding,
                });
            }

            // Create entry audit
            await tx.entryAudit.create({
                data: {
                    entryId: newEntry.id,
                    userId,
                    action: 'CREATED',
                    newValues: {
                        type: dto.type,
                        amount: dto.amount,
                        chargeAmount: dto.chargeAmount || null,
                        description: dto.description,
                        entryDate: dto.entryDate,
                    },
                },
            });

            // Financial audit log
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    cashbookId,
                    entryId: newEntry.id,
                    action: AuditAction.ENTRY_CREATED,
                    amount,
                    balanceBefore,
                    balanceAfter,
                    details: {
                        type: dto.type,
                        description: dto.description,
                        chargeAmount: dto.chargeAmount || null,
                    },
                },
            });

            // ─── Inventory Integration (non-intrusive) ─────────────
            if (dto.inventoryItems && dto.inventoryItems.length > 0) {
                await this.inventoryService.processEntryInventory(
                    tx,
                    cashbook.workspaceId,
                    newEntry.id,
                    dto.type,
                    amount,
                    dto.inventoryItems,
                    userId,
                    dto.description,
                    cashbook.currency,
                );
            }

            return newEntry;
        });

        // Background Hook: Send Automatic Receipt if paying an Obligation
        if (dto.obligationId && dto.type === EntryType.INCOME) {
            // Unawaited intentionally to preserve API speed and avoid rollback on email failure
            this.sendReceipt(entry.id, userId).catch(err => {
                logger.error(`Failed to send background receipt for entry ${entry.id}:`, err);
            });
        }

        return entry;
    }

    // ─── Update Entry ─────────────────────────────────
    async updateEntry(entryId: string, userId: string, dto: UpdateEntryDto) {
        const entry = await this.entriesRepository.findById(entryId);
        if (!entry || entry.isDeleted) {
            throw new NotFoundError('Entry');
        }

        // Soft immutability: reconciled entries cannot change money-affecting fields
        const financialFieldsTouched =
            dto.type !== undefined ||
            dto.amount !== undefined ||
            dto.chargeAmount !== undefined ||
            dto.accountId !== undefined ||
            dto.obligationId !== undefined ||
            dto.entryDate !== undefined ||
            dto.inventoryItems !== undefined;

        if (entry.isReconciled && financialFieldsTouched) {
            throw new AppError(
                'This entry is reconciled and cannot be modified. Unreconcile it first, or post a correcting entry.',
                400,
                'ENTRY_RECONCILED',
            );
        }

        if (dto.expectedVersion !== undefined && dto.expectedVersion !== entry.version) {
            throw new ConflictError(
                `Entry was modified by another request (expected version ${dto.expectedVersion}, current ${entry.version})`,
            );
        }

        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: entry.cashbookId },
        });

        if (!cashbook) {
            throw new NotFoundError('Cashbook');
        }

        // Backdate check for new date
        if (dto.entryDate) {
            const newDate = new Date(dto.entryDate);
            if (!cashbook.allowBackdate && isDateInPast(newDate)) {
                throw new AppError(
                    'Backdated entries are not allowed for this cashbook',
                    400,
                    'BACKDATE_NOT_ALLOWED'
                );
            }
        }

        const oldValues: Record<string, any> = {};
        const newValues: Record<string, any> = {};
        const changes: Record<string, { from: any; to: any }> = {};

        // Find existing non-voided account transaction, if any
        const existingTx = await this.prisma.accountTransaction.findFirst({
            where: {
                sourceId: entryId,
                sourceType: TransactionSourceType.CASHBOOK_ENTRY,
                voidedAt: null,
            }
        });
        const hasAccountChanged = dto.accountId !== undefined && dto.accountId !== (existingTx?.accountId || null);

        // Track changes
        if (dto.type && dto.type !== entry.type) {
            oldValues.type = entry.type;
            newValues.type = dto.type;
            changes.type = { from: entry.type, to: dto.type };
        }
        if (dto.amount && dto.amount !== entry.amount.toString()) {
            oldValues.amount = entry.amount.toString();
            newValues.amount = dto.amount;
            changes.amount = { from: entry.amount.toString(), to: dto.amount };
        }
        if (dto.chargeAmount !== undefined && dto.chargeAmount !== (entry.chargeAmount?.toString() || null)) {
            oldValues.chargeAmount = entry.chargeAmount?.toString() || null;
            newValues.chargeAmount = dto.chargeAmount;
            changes.chargeAmount = { from: entry.chargeAmount?.toString() || null, to: dto.chargeAmount };
        }
        if (dto.description && dto.description !== entry.description) {
            oldValues.description = entry.description;
            newValues.description = dto.description;
            changes.description = { from: entry.description, to: dto.description };
        }
        if (dto.entryDate) {
            oldValues.entryDate = entry.entryDate.toISOString();
            newValues.entryDate = dto.entryDate;
            changes.entryDate = { from: entry.entryDate.toISOString(), to: dto.entryDate };
        }

        const updated = await this.prisma.$transaction(async (tx) => {
            const lockedCashbook = await tx.cashbook.findUniqueOrThrow({
                where: { id: entry.cashbookId },
            });

            const targetAccountId = dto.accountId !== undefined ? dto.accountId : existingTx?.accountId || null;

            const wasIncome = entry.type === EntryType.INCOME;
            const oldAmount = entry.amount;
            const oldChargeAmount = entry.chargeAmount || new Decimal(0);
            const oldEffectiveAmount = effectiveCashAmount(entry.type, oldAmount, oldChargeAmount);
            const balanceBefore = lockedCashbook.balance;

            // Reverse old cashbook effect
            await tx.cashbook.update({
                where: { id: entry.cashbookId },
                data: cashbookIncrementPayload(
                    entry.type,
                    oldAmount,
                    oldChargeAmount,
                    Boolean(existingTx),
                    'reverse',
                ),
            });

            // Apply new amount
            const newType = dto.type || entry.type;
            const newAmount = dto.amount ? new Decimal(dto.amount) : entry.amount;
            const isIncome = newType === EntryType.INCOME;
            const newChargeAmount = dto.chargeAmount !== undefined
                ? (dto.chargeAmount ? new Decimal(dto.chargeAmount) : new Decimal(0))
                : (entry.chargeAmount || new Decimal(0));
            const newEffectiveAmount = effectiveCashAmount(newType, newAmount, newChargeAmount);

            await tx.cashbook.update({
                where: { id: entry.cashbookId },
                data: cashbookIncrementPayload(
                    newType,
                    newAmount,
                    newChargeAmount,
                    Boolean(targetAccountId),
                    'apply',
                ),
            });

            // Cashbook balance audit: only unlinked entries move it
            let balanceAfter = balanceBefore;
            if (!existingTx) {
                balanceAfter = balanceAfter.sub(walletBalanceDelta(entry.type, oldAmount, oldChargeAmount));
            }
            if (!targetAccountId) {
                balanceAfter = balanceAfter.add(walletBalanceDelta(newType, newAmount, newChargeAmount));
            }

            // Deal with Accounts
            if (existingTx || dto.accountId) {
                const moneyChanged =
                    hasAccountChanged ||
                    oldAmount.toString() !== newAmount.toString() ||
                    wasIncome !== isIncome ||
                    oldChargeAmount.toString() !== newChargeAmount.toString();

                if (existingTx && (moneyChanged || dto.accountId === null)) {
                    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${existingTx.accountId}::uuid FOR UPDATE`;
                    const oldWalletDelta = walletBalanceDelta(entry.type, oldAmount, oldChargeAmount);
                    await tx.account.update({
                        where: { id: existingTx.accountId },
                        data: { balance: { increment: oldWalletDelta.negated() } },
                    });
                }

                if (targetAccountId) {
                    if (moneyChanged || !existingTx) {
                        const targetAccount = await tx.account.findUniqueOrThrow({ where: { id: targetAccountId } });
                        if (targetAccount.archivedAt) {
                            throw new AppError('Cannot modify entries linked to an archived account', 400, 'ACCOUNT_ARCHIVED');
                        }

                        if ((hasAccountChanged || !existingTx) && targetAccount.currency !== lockedCashbook.currency) {
                            throw new AppError(
                                `Account currency (${targetAccount.currency}) does not match cashbook currency (${lockedCashbook.currency})`,
                                400,
                                'CURRENCY_MISMATCH'
                            );
                        }

                        await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${targetAccountId}::uuid FOR UPDATE`;
                        const lockedTarget = await tx.account.findUniqueOrThrow({ where: { id: targetAccountId } });

                        const newWalletDelta = walletBalanceDelta(newType, newAmount, newChargeAmount);
                        if (!lockedTarget.allowNegative && newWalletDelta.lessThan(0)) {
                            const provisional = lockedTarget.balance.add(newWalletDelta);
                            if (provisional.lessThan(0)) {
                                throw new AppError(`Transaction exceeds account balance.`, 400, 'INSUFFICIENT_FUNDS');
                            }
                        }

                        await tx.account.update({
                            where: { id: targetAccountId },
                            data: { balance: { increment: newWalletDelta } },
                        });
                    }

                    if (existingTx && dto.accountId !== null) {
                        await tx.accountTransaction.update({
                            where: { id: existingTx.id },
                            data: {
                                ...(hasAccountChanged && { accountId: targetAccountId as string }),
                                amount: newAmount,
                                chargeAmount: newChargeAmount.greaterThan(0) ? newChargeAmount : null,
                                type: newType as any,
                                description: dto.description || existingTx.description
                            }
                        });
                    } else if (!existingTx) {
                        await this.upsertCashbookAccountTransaction(tx, {
                            workspaceId: cashbook.workspaceId,
                            accountId: targetAccountId,
                            sourceId: entryId,
                            type: newType,
                            amount: newAmount,
                            chargeAmount: newChargeAmount.greaterThan(0) ? newChargeAmount : null,
                            description: dto.description || entry.description,
                        });
                    }
                } else if (existingTx && dto.accountId === null) {
                    // Unlink wallet: void AT (keep audit history)
                    await tx.accountTransaction.update({
                        where: { id: existingTx.id },
                        data: { voidedAt: new Date() },
                    });
                }
            }

            // Deal with Obligations (independent of account logic)
            if (entry.obligationId || dto.obligationId) {
                const { InvoicingService } = await import('../invoicing/invoicing.service');
                const targetObligId = dto.obligationId !== undefined ? dto.obligationId : entry.obligationId;

                // If moving away from an obligation, reverse it
                if (entry.obligationId && dto.obligationId === null) {
                    await tx.$queryRaw`SELECT id FROM cashbook_obligations WHERE id = ${entry.obligationId}::uuid FOR UPDATE`;
                    const oldOblig = await tx.cashbookObligation.findUniqueOrThrow({ where: { id: entry.obligationId } });

                    const newOutstanding = oldOblig.outstandingAmount.add(oldAmount);
                    const cappedOutstanding = newOutstanding.greaterThan(oldOblig.totalAmount)
                        ? oldOblig.totalAmount
                        : newOutstanding;
                    const newStatus = obligationStatusFromAmounts(
                        oldOblig.totalAmount,
                        cappedOutstanding,
                        oldOblig.status,
                    ) as ObligationStatus;

                    await tx.cashbookObligation.update({
                        where: { id: entry.obligationId },
                        data: { outstandingAmount: cappedOutstanding, status: newStatus }
                    });

                    await InvoicingService.syncInvoiceFromObligation(tx, {
                        referenceType: oldOblig.referenceType,
                        referenceId: oldOblig.referenceId,
                        outstandingAmount: cappedOutstanding,
                    });
                } else if (targetObligId) {
                    await tx.$queryRaw`SELECT id FROM cashbook_obligations WHERE id = ${targetObligId}::uuid FOR UPDATE`;
                    const lockedTarget = await tx.cashbookObligation.findUniqueOrThrow({ where: { id: targetObligId } });

                    const changedObligation = entry.obligationId && entry.obligationId !== targetObligId;
                    const isNewAssignment = !entry.obligationId || changedObligation;

                    if (isNewAssignment) {
                        if (lockedTarget.cashbookId !== entry.cashbookId) {
                            throw new AppError('Obligation does not belong to this cashbook', 400, 'INVALID_OBLIGATION');
                        }

                        if (lockedTarget.archivedAt) {
                            throw new AppError('Cannot apply payment to an archived obligation', 400, 'OBLIGATION_ARCHIVED');
                        }

                        if (lockedTarget.status === ObligationStatus.CANCELLED) {
                            throw new AppError('Cannot apply payment to a cancelled obligation', 400, 'INVALID_OBLIGATION_STATUS');
                        }
                    }

                    if (changedObligation) {
                        await tx.$queryRaw`SELECT id FROM cashbook_obligations WHERE id = ${entry.obligationId}::uuid FOR UPDATE`;
                        const oldOblig = await tx.cashbookObligation.findUniqueOrThrow({ where: { id: entry.obligationId as string } });
                        const revOutstanding = oldOblig.outstandingAmount.add(oldAmount);
                        const cappedRevOutstanding = revOutstanding.greaterThan(oldOblig.totalAmount)
                            ? oldOblig.totalAmount
                            : revOutstanding;
                        const revStatus = obligationStatusFromAmounts(
                            oldOblig.totalAmount,
                            cappedRevOutstanding,
                            oldOblig.status,
                        ) as ObligationStatus;

                        await tx.cashbookObligation.update({
                            where: { id: entry.obligationId as string },
                            data: { outstandingAmount: cappedRevOutstanding, status: revStatus }
                        });

                        await InvoicingService.syncInvoiceFromObligation(tx, {
                            referenceType: oldOblig.referenceType,
                            referenceId: oldOblig.referenceId,
                            outstandingAmount: cappedRevOutstanding,
                        });
                    }

                    // Same obligation: net change = oldAmount - newAmount; new obligation: subtract newAmount
                    const adjustment = !changedObligation && entry.obligationId ? oldAmount.sub(newAmount) : newAmount.negated();

                    const provisionalOutstanding = lockedTarget.outstandingAmount.add(adjustment);

                    if (provisionalOutstanding.lessThan(0)) {
                        throw new AppError(`Update would overpay the obligation`, 400, 'OVERPAYMENT');
                    }

                    if (lockedTarget.type === ObligationType.RECEIVABLE && newType !== EntryType.INCOME) {
                        throw new AppError('Receivables must be settled with INCOME entries', 400, 'DIRECTION_MISMATCH');
                    }
                    if (lockedTarget.type === ObligationType.PAYABLE && newType !== EntryType.EXPENSE) {
                        throw new AppError('Payables must be settled with EXPENSE entries', 400, 'DIRECTION_MISMATCH');
                    }

                    const newStatus = obligationStatusFromAmounts(
                        lockedTarget.totalAmount,
                        provisionalOutstanding,
                        lockedTarget.status,
                    ) as ObligationStatus;

                    await tx.cashbookObligation.update({
                        where: { id: targetObligId },
                        data: {
                            outstandingAmount: provisionalOutstanding,
                            status: newStatus
                        }
                    });

                    await InvoicingService.syncInvoiceFromObligation(tx, {
                        referenceType: lockedTarget.referenceType,
                        referenceId: lockedTarget.referenceId,
                        outstandingAmount: provisionalOutstanding,
                    });

                    await tx.auditLog.create({
                        data: {
                            userId,
                            workspaceId: cashbook.workspaceId,
                            action: AuditAction.OBLIGATION_UPDATED,
                            resource: 'obligation',
                            resourceId: targetObligId,
                            details: {
                                entryId,
                                adjustedAmount: adjustment,
                                newOutstanding: provisionalOutstanding,
                            } as any
                        }
                    });
                }
            }

            // Update entry
            const updatedEntry = await tx.entry.update({
                where: { id: entryId },
                data: {
                    ...(dto.type && { type: dto.type as any }),
                    ...(dto.amount && { amount: new Decimal(dto.amount) }),
                    ...(dto.chargeAmount !== undefined ? { chargeAmount: dto.chargeAmount ? new Decimal(dto.chargeAmount) : null } : {}),
                    ...(dto.description && { description: dto.description }),
                    ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
                    ...(dto.contactId !== undefined ? { contactId: dto.contactId } : {}),
                    ...(dto.paymentModeId !== undefined ? { paymentModeId: dto.paymentModeId } : {}),
                    ...(dto.obligationId !== undefined ? { obligationId: dto.obligationId } : {}),
                    ...(dto.entryDate && { entryDate: new Date(dto.entryDate) }),
                    version: { increment: 1 },
                },
                include: {
                    category: true,
                    contact: true,
                    paymentMode: true,
                    createdBy: {
                        select: { id: true, email: true, firstName: true, lastName: true },
                    },
                },
            });

            // Audit trail (immutable record of the edit)
            await tx.entryAudit.create({
                data: {
                    entryId,
                    userId,
                    action: 'UPDATED',
                    changes,
                    oldValues,
                    newValues,
                },
            });

            // Financial audit log
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    cashbookId: entry.cashbookId,
                    entryId,
                    action: AuditAction.ENTRY_UPDATED,
                    amount: newAmount,
                    balanceBefore,
                    balanceAfter,
                    details: { changes },
                },
            });

            // ─── Inventory Integration (reverse old + reapply) ─────
            // Only touch inventory if the caller explicitly sent `inventoryItems`.
            // If dto.inventoryItems is undefined → caller did not intend to change
            // inventory at all, so we must NOT reverse the existing transactions.
            // If dto.inventoryItems is an empty array → caller intentionally cleared
            // all inventory links (reverse existing, apply nothing).
            if (dto.inventoryItems !== undefined) {
                // Reverse existing inventory transactions for this entry
                await this.inventoryService.reverseInventoryForReference(
                    tx,
                    InventoryReferenceType.ENTRY,
                    entryId,
                );

                // Re-apply if new items provided
                if (dto.inventoryItems.length > 0) {
                    await this.inventoryService.processEntryInventory(
                        tx,
                        cashbook.workspaceId,
                        entryId,
                        newType,
                        newAmount,
                        dto.inventoryItems,
                        userId,
                        dto.description || entry.description,
                        cashbook.currency,
                    );
                }
            }

            return updatedEntry;
        });

        return updated;
    }

    // ─── Delete Entry (Owner / with permission) ────────
    async deleteEntry(
        entryId: string,
        userId: string,
        reason: string,
        userRole: CashbookRole
    ) {
        const entry = await this.entriesRepository.findById(entryId);
        if (!entry || entry.isDeleted) {
            throw new NotFoundError('Entry');
        }

        const canDelete = hasPermission(userRole, CashbookPermission.DELETE_ENTRY);
        const canApproveDelete = hasPermission(userRole, CashbookPermission.APPROVE_DELETE);

        // Users who can both delete and approve → direct delete
        if (canDelete && canApproveDelete) {
            await this.performDeletion(entry, userId, reason);
            return { action: 'DELETED', message: 'Entry deleted successfully' };
        }

        // Users who can only delete → create delete request
        if (canDelete) {
            // Check for existing pending request
            const existing = await this.entriesRepository.findPendingDeleteRequest(entryId);
            if (existing) {
                throw new ConflictError('A delete request is already pending for this entry');
            }

            const request = await this.entriesRepository.createDeleteRequest({
                entryId,
                requesterId: userId,
                reason,
            });

            const cashbook = await this.prisma.cashbook.findUnique({
                where: { id: entry.cashbookId },
                select: { workspaceId: true },
            });

            await this.prisma.auditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook?.workspaceId,
                    action: AuditAction.ENTRY_DELETE_REQUESTED,
                    resource: 'entry',
                    resourceId: entryId,
                    details: { reason } as any,
                },
            });

            return { action: 'REQUEST_CREATED', message: 'Delete request submitted for approval', data: request };
        }

        throw new AppError('You do not have permission to delete entries', 403, 'AUTHORIZATION_ERROR');
    }

    // ─── Review Delete Request ─────────────────────────
    async reviewDeleteRequest(
        requestId: string,
        reviewerId: string,
        dto: ReviewDeleteRequestDto
    ) {
        const request = await this.entriesRepository.findDeleteRequestById(requestId);
        if (!request) {
            throw new NotFoundError('Delete request');
        }

        if (request.status !== 'PENDING') {
            throw new AppError('This request has already been reviewed', 400, 'ALREADY_REVIEWED');
        }

        if (request.requesterId === reviewerId) {
            throw new AppError('You cannot review your own delete request', 400, 'SELF_REVIEW');
        }

        await this.entriesRepository.updateDeleteRequest(requestId, {
            status: dto.status,
            reviewerId,
            reviewNote: dto.reviewNote,
        });

        const action = dto.status === 'APPROVED'
            ? AuditAction.ENTRY_DELETE_APPROVED
            : AuditAction.ENTRY_DELETE_REJECTED;

        const cashbook = request.entry?.cashbook;

        await this.prisma.auditLog.create({
            data: {
                userId: reviewerId,
                workspaceId: cashbook?.workspaceId,
                action,
                resource: 'delete_request',
                resourceId: requestId,
                details: {
                    entryId: request.entryId,
                    status: dto.status,
                    reviewNote: dto.reviewNote,
                } as any,
            },
        });

        // If approved, perform the actual deletion
        if (dto.status === 'APPROVED' && request.entry) {
            await this.performDeletion(request.entry, reviewerId, request.reason);
        }

        return { message: `Delete request ${dto.status.toLowerCase()}` };
    }

    // ─── Get Delete Requests ──────────────────────────
    async getDeleteRequests(cashbookId: string, status?: string) {
        return this.entriesRepository.findDeleteRequestsByCashbook(cashbookId, status);
    }

    // ─── Get Entry Audit Trail ─────────────────────────
    async getEntryAuditTrail(entryId: string) {
        const entry = await this.entriesRepository.findById(entryId);
        if (!entry) {
            throw new NotFoundError('Entry');
        }
        return this.entriesRepository.getEntryAudits(entryId);
    }

    // ─── Internal: Perform Deletion ────────────────────
    private async performDeletion(entry: any, userId: string, reason: string) {
        if (entry.isReconciled) {
            throw new AppError(
                'This entry is reconciled and cannot be deleted. Unreconcile it first.',
                400,
                'ENTRY_RECONCILED',
            );
        }

        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: entry.cashbookId },
        });

        if (!cashbook) {
            throw new NotFoundError('Cashbook');
        }

        await this.prisma.$transaction(async (tx) => {
            // Read cashbook inside transaction for accurate balanceBefore
            const lockedCashbook = await tx.cashbook.findUniqueOrThrow({
                where: { id: entry.cashbookId },
            });

            const balanceBefore = lockedCashbook.balance;
            const amount = entry.amount;
            const chargeAmount = entry.chargeAmount || new Decimal(0);

            // Check if there's a linked non-voided account FIRST
            const existingTx = await tx.accountTransaction.findFirst({
                where: {
                    sourceId: entry.id,
                    sourceType: TransactionSourceType.CASHBOOK_ENTRY,
                    voidedAt: null,
                }
            });

            let balanceAfter = balanceBefore;

            // Reverse cashbook activity (+ balance if unlinked)
            await tx.cashbook.update({
                where: { id: entry.cashbookId },
                data: cashbookIncrementPayload(
                    entry.type,
                    amount,
                    chargeAmount,
                    Boolean(existingTx),
                    'reverse',
                ),
            });

            if (!existingTx) {
                balanceAfter = balanceBefore.sub(walletBalanceDelta(entry.type, amount, chargeAmount));
            }

            if (existingTx) {
                await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${existingTx.accountId}::uuid FOR UPDATE`;
                const oldWalletDelta = walletBalanceDelta(entry.type, amount, chargeAmount);
                await tx.account.update({
                    where: { id: existingTx.accountId },
                    data: { balance: { increment: oldWalletDelta.negated() } },
                });

                // Void wallet ledger row (retain audit history)
                await tx.accountTransaction.update({
                    where: { id: existingTx.id },
                    data: { voidedAt: new Date() },
                });
            }

            if (entry.obligationId) {
                await tx.$queryRaw`SELECT id FROM cashbook_obligations WHERE id = ${entry.obligationId}::uuid FOR UPDATE`;
                const lockedObligation = await tx.cashbookObligation.findUniqueOrThrow({ where: { id: entry.obligationId } });

                const newOutstanding = lockedObligation.outstandingAmount.add(amount);
                const cappedOutstanding = newOutstanding.greaterThan(lockedObligation.totalAmount)
                    ? lockedObligation.totalAmount
                    : newOutstanding;
                const newStatus = obligationStatusFromAmounts(
                    lockedObligation.totalAmount,
                    cappedOutstanding,
                    lockedObligation.status,
                ) as ObligationStatus;

                await tx.cashbookObligation.update({
                    where: { id: entry.obligationId },
                    data: {
                        outstandingAmount: cappedOutstanding,
                        status: newStatus
                    }
                });

                await tx.auditLog.create({
                    data: {
                        userId,
                        workspaceId: cashbook.workspaceId,
                        action: AuditAction.OBLIGATION_PAYMENT_REVERSED,
                        resource: 'obligation',
                        resourceId: entry.obligationId,
                        details: {
                            entryId: entry.id,
                            reason,
                            reversedAmount: amount,
                            newOutstanding: cappedOutstanding
                        } as any
                    }
                });

                const { InvoicingService } = await import('../invoicing/invoicing.service');
                await InvoicingService.syncInvoiceFromObligation(tx, {
                    referenceType: lockedObligation.referenceType,
                    referenceId: lockedObligation.referenceId,
                    outstandingAmount: cappedOutstanding,
                });
            }

            // ─── Inventory Integration (reverse on delete) ────────
            await this.inventoryService.reverseInventoryForReference(
                tx,
                InventoryReferenceType.ENTRY,
                entry.id,
            );

            // Soft-delete the entry
            await tx.entry.update({
                where: { id: entry.id },
                data: {
                    isDeleted: true,
                    deletedAt: new Date(),
                    deletedReason: reason,
                    // Clean up relationships
                    attachments: {
                        deleteMany: {}
                    }
                },
            });

            // Entry audit
            await tx.entryAudit.create({
                data: {
                    entryId: entry.id,
                    userId,
                    action: 'DELETED',
                    oldValues: {
                        type: entry.type,
                        amount: entry.amount,
                        description: entry.description,
                    } as any,
                    newValues: {} as any,
                },
            });

            // Workspace/Cashbook Audit
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    action: AuditAction.ENTRY_DELETED,
                    resource: 'entry',
                    resourceId: entry.id,
                    details: {
                        amount: entry.amount,
                        type: entry.type,
                        reason,
                    } as any
                }
            });
            // Financial audit log
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    cashbookId: entry.cashbookId,
                    entryId: entry.id,
                    action: AuditAction.ENTRY_DELETED,
                    amount,
                    balanceBefore,
                    balanceAfter,
                    reason,
                    details: {
                        type: entry.type,
                        description: entry.description,
                    },
                },
            });
        });
    }

    /**
     * Create or revive a cashbook-linked AccountTransaction.
     * Revives a previously voided row for the same (sourceId, accountId) to honor the unique constraint.
     */
    private async upsertCashbookAccountTransaction(
        tx: any,
        data: {
            workspaceId: string;
            accountId: string;
            sourceId: string;
            type: string;
            amount: Decimal;
            chargeAmount: Decimal | null;
            description: string;
        },
    ) {
        const existingAny = await tx.accountTransaction.findFirst({
            where: {
                sourceId: data.sourceId,
                accountId: data.accountId,
                sourceType: TransactionSourceType.CASHBOOK_ENTRY,
            },
        });

        if (existingAny) {
            return tx.accountTransaction.update({
                where: { id: existingAny.id },
                data: {
                    voidedAt: null,
                    type: data.type as any,
                    amount: data.amount,
                    chargeAmount: data.chargeAmount,
                    description: data.description,
                },
            });
        }

        return tx.accountTransaction.create({
            data: {
                workspaceId: data.workspaceId,
                accountId: data.accountId,
                sourceType: TransactionSourceType.CASHBOOK_ENTRY,
                sourceId: data.sourceId,
                type: data.type as any,
                amount: data.amount,
                chargeAmount: data.chargeAmount,
                description: data.description,
            },
        });
    }

    // ─── Receipts ──────────────────────────────────────
    async sendReceipt(entryId: string, userId: string) {
        const entry = await this.prisma.entry.findUnique({
            where: { id: entryId },
            include: {
                cashbook: { select: { workspaceId: true, currency: true } },
                contact: { include: { customerProfile: true } },
                paymentMode: true,
                obligation: true,
            }
        });

        if (!entry) throw new NotFoundError('Entry');
        if (!entry.obligation) throw new AppError('Entry is not linked to an obligation', 400, 'NO_OBLIGATION');
        if (!entry.contact || !entry.contact.email) throw new AppError('No contact email available to send receipt', 400, 'NO_EMAIL');

        const workspaceId = entry.cashbook.workspaceId;

        // Fetch Business Data & Settings
        const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        const settings = await this.prisma.invoiceSettings.findUnique({ where: { workspaceId } });

        const businessName = workspace?.name || 'Business';

        // Prepare PDF/Email Models
        const pdfModel = {
            receiptNumber: entry.id.split('-').pop() || entry.id,
            paymentDate: entry.entryDate,
            amountPaid: entry.amount,
            currency: entry.cashbook.currency,
            paymentMode: entry.paymentMode,
            obligation: {
                title: entry.obligation.title,
                totalAmount: entry.obligation.totalAmount,
                outstandingAmount: entry.obligation.outstandingAmount,
            },
            customer: {
                name: entry.contact.name,
                email: entry.contact.email,
                phone: entry.contact.phone,
                company: entry.contact.company,
                customerProfile: entry.contact.customerProfile,
            }
        };

        const pdfBuffer = await generateReceiptPdf(pdfModel, businessName, settings);

        // Send Email
        const amountStr = entry.amount.toNumber().toLocaleString(undefined, { minimumFractionDigits: 2 });
        const remainingStr = entry.obligation.outstandingAmount.toNumber().toLocaleString(undefined, { minimumFractionDigits: 2 });
        const paymentDateStr = new Date(entry.entryDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

        const html = receiptEmailTemplate({
            customerName: entry.contact.name,
            businessName,
            receiptNumber: pdfModel.receiptNumber,
            obligationName: entry.obligation.title,
            currency: entry.cashbook.currency,
            amountPaid: amountStr,
            paymentDate: paymentDateStr,
            remainingBal: remainingStr,
            logoUrl: settings?.logoUrl || null,
        });

        await sendEmail({
            to: entry.contact.email,
            subject: `Payment Receipt - ${entry.obligation.title}`,
            html,
            attachments: [{
                filename: `Receipt_${pdfModel.receiptNumber}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf',
            }]
        });

        // Log Transparency
        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: 'RECEIPT_SENT' as any,
                resource: 'entry',
                resourceId: entry.id,
                details: {
                    sentTo: entry.contact.email,
                    amount: entry.amount.toString(),
                    remainingBalance: entry.obligation.outstandingAmount.toString(),
                } as any,
            }
        });

        return { success: true };
    }
}
