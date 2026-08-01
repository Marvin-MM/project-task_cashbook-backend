import { inject, injectable } from 'tsyringe';
import { PrismaClient, Prisma, AccountTransaction, TransactionSourceType } from '@prisma/client';

@injectable()
export class AccountTransactionsRepository {
    // Injected rather than pulled from getPrismaClient(), so this repository
    // honours whichever client the container provides (including in tests).
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    async findById(id: string): Promise<AccountTransaction | null> {
        return this.prisma.accountTransaction.findUnique({
            where: { id }
        });
    }

    async findAllByAccount(accountId: string, workspaceId: string, pagination?: { skip: number; take: number }): Promise<[number, AccountTransaction[]]> {
        // Active ledger only (voided rows retained for audit, excluded from default lists)
        const where = { accountId, workspaceId, voidedAt: null };

        const [total, data] = await Promise.all([
            this.prisma.accountTransaction.count({ where }),
            this.prisma.accountTransaction.findMany({
                where,
                // Business date first; createdAt only breaks ties, so a backdated
                // movement sorts where it belongs in the statement.
                orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
                skip: pagination?.skip,
                take: pagination?.take,
                include: { accountCategory: true }
            })
        ]);

        return [total, data];
    }
}
