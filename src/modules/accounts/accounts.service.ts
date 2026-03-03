import { injectable, inject } from 'tsyringe';
import { PrismaClient, TransactionSourceType, EntryType } from '@prisma/client';
import { AccountsRepository } from './accounts.repository';
import { CreateAccountBody, UpdateAccountBody, ArchiveAccountBody } from './accounts.dto';
import { AppError, NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { Decimal } from '@prisma/client/runtime/library';

@injectable()
export class AccountsService {
    constructor(
        private repository: AccountsRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    async createAccount(workspaceId: string, userId: string, data: CreateAccountBody) {
        return this.prisma.$transaction(async (tx) => {
            // Validate accountType belongs to workspace
            const accountType = await tx.accountType.findUnique({
                where: { id: data.accountTypeId }
            });

            if (!accountType || accountType.workspaceId !== workspaceId) {
                throw new AppError('Invalid account type provided', 400, 'INVALID_ACCOUNT_TYPE');
            }

            const { initialBalance, ...accountData } = data;
            const initialAmount = new Decimal(initialBalance || '0');
            const hasInitialBalance = !initialAmount.equals(0);

            const account = await tx.account.create({
                data: {
                    workspaceId,
                    ...accountData,
                    balance: initialAmount,
                },
                include: { accountType: true }
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.ACCOUNT_CREATED,
                    resource: 'account',
                    resourceId: account.id,
                    details: { name: account.name, type: accountType.name, currency: account.currency, initialBalance: hasInitialBalance ? initialAmount.toString() : '0' } as any
                }
            });

            // If an initial balance is provided, create a direct transaction to back it up
            if (hasInitialBalance) {
                const isIncome = initialAmount.greaterThan(0);
                const absAmount = initialAmount.abs();
                const transactionType = isIncome ? EntryType.INCOME : EntryType.EXPENSE;

                const transaction = await tx.accountTransaction.create({
                    data: {
                        workspaceId,
                        accountId: account.id,
                        sourceType: TransactionSourceType.DIRECT,
                        type: transactionType,
                        amount: absAmount,
                        description: 'Initial Balance',
                    }
                });

                // Generic audit log for this opening transaction
                await tx.auditLog.create({
                    data: {
                        userId,
                        workspaceId,
                        action: AuditAction.ACCOUNT_TRANSACTION_DIRECT_CREATED as any,
                        resource: 'account_transaction',
                        resourceId: transaction.id,
                        details: {
                            previous_balance: '0',
                            new_balance: initialAmount.toString(),
                            delta: initialAmount.toString(),
                            type: transactionType,
                            amount: absAmount.toString()
                        } as any
                    }
                });

                // Financial audit log
                await tx.financialAuditLog.create({
                    data: {
                        userId,
                        workspaceId,
                        accountId: account.id,
                        action: AuditAction.ACCOUNT_TRANSACTION_DIRECT_CREATED as any,
                        amount: absAmount,
                        balanceBefore: new Decimal(0),
                        balanceAfter: initialAmount,
                        details: {
                            accountName: account.name,
                            type: transactionType,
                            sourceType: 'DIRECT',
                            transactionId: transaction.id,
                            isInitialBalance: true
                        },
                    }
                });
            }

            return account;
        });
    }

    async getWorkspaceAccounts(workspaceId: string) {
        return this.repository.findAllByWorkspace(workspaceId);
    }

    async getAccountById(id: string, workspaceId: string) {
        const account = await this.repository.findById(id);
        if (!account || account.workspaceId !== workspaceId) {
            throw new NotFoundError('Account');
        }
        return account;
    }

    async updateAccount(id: string, workspaceId: string, userId: string, data: UpdateAccountBody) {
        return this.prisma.$transaction(async (tx) => {
            const account = await tx.account.findUnique({
                where: { id },
                include: { accountType: true }
            });

            if (!account || account.workspaceId !== workspaceId) {
                throw new NotFoundError('Account');
            }

            const updated = await tx.account.update({
                where: { id },
                data,
                include: { accountType: true }
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.ACCOUNT_UPDATED,
                    resource: 'account',
                    resourceId: account.id,
                    details: { old: { name: account.name, allowNegative: account.allowNegative }, new: data } as any
                }
            });

            return updated;
        });
    }

    async setAccountArchiveStatus(id: string, workspaceId: string, userId: string, data: ArchiveAccountBody) {
        return this.prisma.$transaction(async (tx) => {
            const account = await tx.account.findUnique({
                where: { id },
                include: { accountType: true }
            });

            if (!account || account.workspaceId !== workspaceId) {
                throw new NotFoundError('Account');
            }

            if (account.balance.toNumber() !== 0 && data.archive) {
                throw new AppError('Cannot archive an account with a non-zero balance.', 400, 'ARCHIVE_RESTRICTED');
            }

            const updated = await tx.account.update({
                where: { id },
                data: { archivedAt: data.archive ? new Date() : null },
                include: { accountType: true }
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: data.archive ? AuditAction.ACCOUNT_ARCHIVED : AuditAction.ACCOUNT_UNARCHIVED,
                    resource: 'account',
                    resourceId: account.id,
                    details: { status: data.archive ? 'archived' : 'active' } as any
                }
            });

            return updated;
        });
    }

    async deleteAccount(id: string, workspaceId: string, userId: string) {
        return this.prisma.$transaction(async (tx) => {
            const account = await tx.account.findUnique({
                where: { id },
                include: { accountType: true }
            });

            if (!account || account.workspaceId !== workspaceId) {
                throw new NotFoundError('Account');
            }

            // Prevent deletion if transactions exist
            const transactionsCount = await tx.accountTransaction.count({
                where: { accountId: id }
            });

            if (transactionsCount > 0) {
                throw new AppError('Cannot delete account because it has recorded transactions. Please archive it instead.', 400, 'DELETE_RESTRICTED');
            }

            await tx.account.delete({ where: { id } });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.ACCOUNT_DELETED,
                    resource: 'account',
                    resourceId: id,
                    details: { name: account.name } as any
                }
            });
        });
    }

    async calculateNetWorth(workspaceId: string) {
        const accounts = await this.repository.findAllByWorkspace(workspaceId);

        // Per-currency accumulators
        const byCurrency: Record<string, { assets: Decimal; liabilities: Decimal }> = {};

        const breakdown: {
            accountId: string;
            name: string;
            type: string;
            classification: string;
            balance: string;
            currency: string;
        }[] = [];

        accounts.forEach(account => {
            // Skip archived or explicitly excluded accounts
            if (account.archivedAt || account.excludeFromTotal) return;

            const classification = account.accountType.classification;
            const currency = account.currency;

            breakdown.push({
                accountId: account.id,
                name: account.name,
                type: account.accountType.name,
                classification,
                balance: account.balance.toString(),
                currency,
            });

            // Initialize currency bucket if needed
            if (!byCurrency[currency]) {
                byCurrency[currency] = { assets: new Decimal(0), liabilities: new Decimal(0) };
            }

            // Standard approach: Net Worth = Assets - Liabilities
            if (classification === 'ASSET') {
                byCurrency[currency].assets = byCurrency[currency].assets.add(account.balance);
            } else if (classification === 'LIABILITY') {
                byCurrency[currency].liabilities = byCurrency[currency].liabilities.add(account.balance);
            }
        });

        // Build per-currency summary
        const currencies = Object.entries(byCurrency).map(([currency, totals]) => ({
            currency,
            assets: totals.assets.toString(),
            liabilities: totals.liabilities.toString(),
            netWorth: totals.assets.sub(totals.liabilities).toString(),
        }));

        return {
            currencies,
            breakdown,
        };
    }
}
