import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
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

            const account = await tx.account.create({
                data: {
                    workspaceId,
                    ...data
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
                    details: { name: account.name, type: accountType.name, currency: account.currency } as any
                }
            });

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
