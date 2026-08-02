import { injectable, inject } from 'tsyringe';
import { PrismaClient, TransactionSourceType, InventoryReferenceType } from '@prisma/client';
import { AccountTransactionsRepository } from './account-transactions.repository';
import { CreateAccountTransactionBody, UpdateAccountTransactionBody } from './account-transactions.dto';
import { AppError, NotFoundError } from '../../core/errors/AppError';
import { AuditAction, EntryType } from '../../core/types';
import { Decimal } from '@prisma/client/runtime/library';
import { InventoryService } from '../inventory/inventory.service';
import { walletBalanceDelta } from '../../core/finance';
import { withFinancialTransaction } from '../../core/db/transaction';
import { acquireLocks } from '../../core/db/locks';
import { config } from '../../config';
import { PostingService } from '../../core/ledger/posting.service';
import {
    buildDirectWalletJournal,
    walletTxPostingKey,
} from '../../core/ledger/rules/wallet.rules';

@injectable()
export class AccountTransactionsService {
    constructor(
        private repository: AccountTransactionsRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
        private postingService: PostingService,
        private inventoryService: InventoryService,
    ) { }

    async getAllTransactionsByAccount(accountId: string, workspaceId: string, pagination?: { skip: number; take: number }) {
        const [total, transactions] = await this.repository.findAllByAccount(accountId, workspaceId, pagination);

        const txIds = transactions.map(t => t.id);
        const inventoryTransactions = txIds.length > 0 ? await this.prisma.inventoryTransaction.findMany({
            where: {
                referenceType: InventoryReferenceType.ACCOUNT_TRANSACTION,
                referenceId: { in: txIds }
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

        const mappedTransactions = transactions.map(tx => {
            // Flattened so the client reads `sourceCashbookName` rather than
            // reaching through two optional relations for every row.
            const source = (tx as typeof tx & {
                sourceEntry?: { id: string; cashbook: { id: string; name: string } | null } | null;
            }).sourceEntry;

            return {
                ...tx,
                inventoryItems: invMap.get(tx.id) || [],
                sourceEntryId: source?.id ?? null,
                sourceCashbookId: source?.cashbook?.id ?? null,
                sourceCashbookName: source?.cashbook?.name ?? null,
            };
        });

        return [total, mappedTransactions] as const;
    }

    async createDirectTransaction(
        workspaceId: string,
        accountId: string,
        userId: string,
        data: CreateAccountTransactionBody
    ) {
        const amount = new Decimal(data.amount);
        const chargeAmount = data.chargeAmount ? new Decimal(data.chargeAmount) : new Decimal(0);
        const walletDelta = walletBalanceDelta(data.type, amount, chargeAmount);

        return withFinancialTransaction(this.prisma, async (tx) => {
            await acquireLocks(tx, [{ target: 'WALLET_ACCOUNT', ids: [accountId] }]);

            const account = await tx.account.findUnique({ where: { id: accountId } });

            if (!account || account.workspaceId !== workspaceId) {
                throw new NotFoundError('Account');
            }

            if (account.archivedAt) {
                throw new AppError('Cannot create transactions for an archived account', 400, 'ACCOUNT_ARCHIVED');
            }

            if (data.accountCategoryId) {
                const category = await tx.accountCategory.findUnique({
                    where: { id: data.accountCategoryId }
                });
                if (!category || category.workspaceId !== workspaceId) {
                    throw new AppError('Invalid account category provided', 400, 'INVALID_CATEGORY');
                }
            }

            const balanceBefore = account.balance;

            // Negative balance guard
            if (!account.allowNegative && walletDelta.lessThan(0)) {
                const newBalance = balanceBefore.add(walletDelta);
                if (newBalance.lessThan(0)) {
                    throw new AppError(`Transaction exceeds account balance. Current balance is ${balanceBefore.toString()}`, 400, 'INSUFFICIENT_FUNDS');
                }
            }

            const balanceAfter = balanceBefore.add(walletDelta);

            const transactionDate = data.transactionDate ? new Date(data.transactionDate) : new Date();

            const transaction = await tx.accountTransaction.create({
                data: {
                    workspaceId,
                    accountId,
                    sourceType: TransactionSourceType.DIRECT,
                    type: data.type as any,
                    amount,
                    chargeAmount: chargeAmount.greaterThan(0) ? chargeAmount : null,
                    description: data.description,
                    accountCategoryId: data.accountCategoryId,
                    transactionDate,
                }
            });

            // The journal is what moves Account.balance; PostingService is the
            // sole writer of that column.
            if (config.LEDGER_MODE !== 'off') {
                await this.postingService.post(
                    tx,
                    buildDirectWalletJournal({
                        workspaceId,
                        accountId,
                        transactionId: transaction.id,
                        version: transaction.version,
                        type: data.type as 'INCOME' | 'EXPENSE',
                        amount,
                        chargeAmount,
                        description: data.description,
                        transactionDate,
                        currency: account.currency,
                        createdById: userId,
                    }),
                    { applyCaches: config.LEDGER_MODE === 'on', onDuplicate: 'RETURN_EXISTING' },
                );
            }

            // Generic audit log
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.ACCOUNT_TRANSACTION_DIRECT_CREATED as any,
                    resource: 'account_transaction',
                    resourceId: transaction.id,
                    details: {
                        previous_balance: balanceBefore.toString(),
                        new_balance: balanceAfter.toString(),
                        delta: walletDelta.toString(),
                        type: data.type,
                        amount: amount.toString(),
                        ...(chargeAmount.greaterThan(0) ? { chargeAmount: chargeAmount.toString() } : {})
                    } as any
                }
            });

            // Financial audit log (Issue 6)
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId,
                    accountId,
                    action: AuditAction.ACCOUNT_TRANSACTION_DIRECT_CREATED as any,
                    amount,
                    balanceBefore,
                    balanceAfter,
                    details: {
                        accountName: account.name,
                        type: data.type,
                        sourceType: 'DIRECT',
                        transactionId: transaction.id,
                        ...(chargeAmount.greaterThan(0) ? { chargeAmount: chargeAmount.toString() } : {})
                    },
                }
            });

            // ─── Inventory Integration (non-intrusive) ─────────────
            if (data.inventoryItems && data.inventoryItems.length > 0) {
                await this.inventoryService.processAccountTransactionInventory(
                    tx,
                    workspaceId,
                    transaction.id,
                    data.type,
                    amount,
                    data.inventoryItems,
                    userId,
                    data.description,
                    account.currency,
                );
            }

            return transaction;
        });
    }

    async updateDirectTransaction(
        id: string,
        workspaceId: string,
        accountId: string,
        userId: string,
        data: UpdateAccountTransactionBody
    ) {
        return withFinancialTransaction(this.prisma, async (tx) => {
            await acquireLocks(tx, [{ target: 'WALLET_ACCOUNT', ids: [accountId] }]);
            const account = await tx.account.findUnique({ where: { id: accountId } });

            if (!account || account.workspaceId !== workspaceId) {
                throw new NotFoundError('Account');
            }

            const transaction = await tx.accountTransaction.findUnique({ where: { id } });
            if (!transaction || transaction.workspaceId !== workspaceId || transaction.accountId !== accountId) {
                throw new NotFoundError('Account Transaction');
            }

            if (transaction.sourceType !== TransactionSourceType.DIRECT) {
                throw new AppError('Linked transactions can only be updated via cashbook entries.', 403, 'FORBIDDEN');
            }

            if (data.accountCategoryId) {
                const category = await tx.accountCategory.findUnique({ where: { id: data.accountCategoryId } });
                if (!category || category.workspaceId !== workspaceId) {
                    throw new AppError('Invalid account category provided', 400, 'INVALID_CATEGORY');
                }
            }

            if (transaction.voidedAt) {
                throw new AppError('Cannot update a voided transaction', 400, 'TRANSACTION_VOIDED');
            }

            const balanceBefore = account.balance;
            const oldAmount = transaction.amount;
            const oldChargeAmount = transaction.chargeAmount || new Decimal(0);
            const oldWalletDelta = walletBalanceDelta(transaction.type, oldAmount, oldChargeAmount);

            const newType = data.type || transaction.type;
            const newAmount = data.amount ? new Decimal(data.amount) : transaction.amount;
            const newChargeAmount = data.chargeAmount !== undefined
                ? (data.chargeAmount ? new Decimal(data.chargeAmount) : new Decimal(0))
                : (transaction.chargeAmount || new Decimal(0));
            const newWalletDelta = walletBalanceDelta(newType, newAmount, newChargeAmount);

            // Overdraft is checked against the balance net of this transaction's
            // old effect, since the repost reverses it before applying the new one.
            const balanceWithoutTx = balanceBefore.sub(oldWalletDelta);

            if (!account.allowNegative && newWalletDelta.lessThan(0)) {
                const provisional = balanceWithoutTx.add(newWalletDelta);
                if (provisional.lessThan(0)) {
                    throw new AppError('Transaction exceeds account balance.', 400, 'INSUFFICIENT_FUNDS');
                }
            }

            const balanceAfter = balanceWithoutTx.add(newWalletDelta);

            const updatedTransaction = await tx.accountTransaction.update({
                where: { id },
                data: {
                    ...(data.type && { type: data.type as any }),
                    ...(data.amount && { amount: newAmount }),
                    ...(data.chargeAmount !== undefined ? { chargeAmount: data.chargeAmount ? new Decimal(data.chargeAmount) : null } : {}),
                    ...(data.description && { description: data.description }),
                    ...(data.accountCategoryId !== undefined && { accountCategoryId: data.accountCategoryId }),
                    ...(data.transactionDate && { transactionDate: new Date(data.transactionDate) }),
                    version: { increment: 1 },
                }
            });

            // Reverse the previous version's journal and post the new one.
            if (config.LEDGER_MODE !== 'off') {
                await this.postingService.repost(tx, {
                    originalPostingKey: walletTxPostingKey(id, transaction.version),
                    reason: 'Wallet transaction updated',
                    createdById: userId,
                    applyCaches: config.LEDGER_MODE === 'on',
                    next: buildDirectWalletJournal({
                        workspaceId,
                        accountId,
                        transactionId: id,
                        version: updatedTransaction.version,
                        type: updatedTransaction.type as 'INCOME' | 'EXPENSE',
                        amount: updatedTransaction.amount,
                        chargeAmount: updatedTransaction.chargeAmount,
                        description: updatedTransaction.description,
                        transactionDate: updatedTransaction.transactionDate,
                        currency: account.currency,
                        createdById: userId,
                    }),
                });
            }

            // Generic audit log
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.ACCOUNT_TRANSACTION_DIRECT_UPDATED as any,
                    resource: 'account_transaction',
                    resourceId: id,
                    details: {
                        previous_balance: balanceBefore.toString(),
                        new_balance: balanceAfter.toString(),
                        delta: balanceAfter.sub(balanceBefore).toString(),
                        changes: data,
                        ...(newChargeAmount.greaterThan(0) ? { chargeAmount: newChargeAmount.toString() } : {})
                    } as any
                }
            });

            // Financial audit log
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId,
                    accountId,
                    action: AuditAction.ACCOUNT_TRANSACTION_DIRECT_UPDATED as any,
                    amount: newAmount,
                    balanceBefore,
                    balanceAfter,
                    details: {
                        transactionId: id,
                        sourceType: 'DIRECT',
                        changes: data
                    },
                }
            });

            // ─── Inventory Integration (reverse old + reapply) ─────
            await this.inventoryService.reverseInventoryForReference(
                tx,
                InventoryReferenceType.ACCOUNT_TRANSACTION,
                id,
            );

            if (data.inventoryItems && data.inventoryItems.length > 0) {
                await this.inventoryService.processAccountTransactionInventory(
                    tx,
                    workspaceId,
                    id,
                    newType,
                    newAmount,
                    data.inventoryItems,
                    userId,
                    data.description || updatedTransaction.description,
                    account.currency,
                );
            }

            return updatedTransaction;
        });
    }

    async deleteDirectTransaction(
        id: string,
        workspaceId: string,
        accountId: string,
        userId: string
    ) {
        return withFinancialTransaction(this.prisma, async (tx) => {
            await acquireLocks(tx, [{ target: 'WALLET_ACCOUNT', ids: [accountId] }]);
            const account = await tx.account.findUnique({ where: { id: accountId } });

            if (!account || account.workspaceId !== workspaceId) {
                throw new NotFoundError('Account');
            }

            const transaction = await tx.accountTransaction.findUnique({ where: { id } });
            if (!transaction || transaction.workspaceId !== workspaceId || transaction.accountId !== accountId) {
                throw new NotFoundError('Account Transaction');
            }

            if (transaction.sourceType !== TransactionSourceType.DIRECT) {
                throw new AppError('Linked transactions can only be deleted via cashbook entries.', 403, 'FORBIDDEN');
            }

            if (transaction.voidedAt) {
                throw new AppError('Transaction is already voided', 400, 'ALREADY_VOIDED');
            }

            const balanceBefore = account.balance;
            const oldAmount = transaction.amount;
            const chargeAmount = transaction.chargeAmount || new Decimal(0);
            const oldWalletDelta = walletBalanceDelta(transaction.type, oldAmount, chargeAmount);

            // Negative balance guard when reversing an income (cash leaves wallet)
            if (!account.allowNegative && oldWalletDelta.greaterThan(0)) {
                const provisional = balanceBefore.sub(oldWalletDelta);
                if (provisional.lessThan(0)) {
                    throw new AppError('Reversing this transaction would exceed the account balance limit.', 400, 'INSUFFICIENT_FUNDS');
                }
            }

            const balanceAfter = balanceBefore.sub(oldWalletDelta);

            // Post the reversing journal; it is what moves the wallet balance back.
            if (config.LEDGER_MODE !== 'off') {
                await this.postingService.reverse(tx, {
                    workspaceId,
                    originalPostingKey: walletTxPostingKey(id, transaction.version),
                    reason: 'Wallet transaction voided',
                    createdById: userId,
                    applyCaches: config.LEDGER_MODE === 'on',
                });
            }

            // ─── Inventory Integration (reverse on delete) ────────
            await this.inventoryService.reverseInventoryForReference(
                tx,
                InventoryReferenceType.ACCOUNT_TRANSACTION,
                id,
            );

            // Void rather than hard-delete to preserve wallet ledger history
            await tx.accountTransaction.update({
                where: { id },
                data: { voidedAt: new Date() },
            });

            // Generic audit log
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.ACCOUNT_TRANSACTION_DIRECT_DELETED as any,
                    resource: 'account_transaction',
                    resourceId: id,
                    details: {
                        previous_balance: balanceBefore.toString(),
                        new_balance: balanceAfter.toString(),
                        delta: balanceAfter.sub(balanceBefore).toString()
                    } as any
                }
            });

            // Financial audit log
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId,
                    accountId,
                    action: AuditAction.ACCOUNT_TRANSACTION_DIRECT_DELETED as any,
                    amount: oldAmount,
                    balanceBefore,
                    balanceAfter,
                    details: {
                        transactionId: id,
                        sourceType: 'DIRECT',
                    },
                }
            });
        });
    }
}
