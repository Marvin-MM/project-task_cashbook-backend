import { getPrismaClient } from '../../config/database';
import { Prisma } from '@prisma/client';

const prisma = getPrismaClient();

export class CashbooksRepository {
    async findById(id: string) {
        return prisma.cashbook.findUnique({
            where: { id },
            include: {
                workspace: true,
                members: {
                    include: {
                        user: {
                            select: { id: true, email: true, firstName: true, lastName: true },
                        },
                    },
                },
                _count: { select: { entries: true, attachments: true } },
            },
        });
    }

    async findByWorkspaceId(workspaceId: string) {
        return prisma.cashbook.findMany({
            where: { workspaceId, isActive: true },
            include: {
                _count: { select: { entries: true, members: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findUserAccessibleCashbooks(workspaceId: string, userId: string) {
        // Get cashbooks where user is a member
        return prisma.cashbook.findMany({
            where: {
                workspaceId,
                isActive: true,
                members: {
                    some: { userId },
                },
            },
            include: {
                members: {
                    where: { userId },
                    select: { role: true },
                },
                _count: { select: { entries: true, members: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async create(data: Prisma.CashbookCreateInput) {
        return prisma.cashbook.create({
            data,
            include: {
                workspace: true,
            },
        });
    }

    async update(id: string, data: Prisma.CashbookUpdateInput) {
        return prisma.cashbook.update({
            where: { id },
            data,
        });
    }

    async softDelete(id: string) {
        return prisma.cashbook.update({
            where: { id },
            data: { isActive: false },
        });
    }

    // ─── Cashbook Members ──────────────────────────────
    async findMember(cashbookId: string, userId: string) {
        return prisma.cashbookMember.findUnique({
            where: { cashbookId_userId: { cashbookId, userId } },
            include: {
                user: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
        });
    }

    async addMember(cashbookId: string, userId: string, role: string) {
        return prisma.cashbookMember.create({
            data: {
                cashbookId,
                userId,
                role: role as any,
            },
            include: {
                user: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
        });
    }

    async updateMemberRole(cashbookId: string, userId: string, role: string) {
        return prisma.cashbookMember.update({
            where: { cashbookId_userId: { cashbookId, userId } },
            data: { role: role as any },
            include: {
                user: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
        });
    }

    async removeMember(cashbookId: string, userId: string) {
        return prisma.cashbookMember.delete({
            where: { cashbookId_userId: { cashbookId, userId } },
        });
    }

    async getMembers(cashbookId: string) {
        return prisma.cashbookMember.findMany({
            where: { cashbookId },
            include: {
                user: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
            orderBy: { joinedAt: 'asc' },
        });
    }

    // ─── Financial Summary ─────────────────────────────
    async getFinancialSummary(cashbookId: string) {
        return prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: {
                id: true,
                name: true,
                currency: true,
                balance: true,
                totalIncome: true,
                totalExpense: true,
            },
        });
    }
}
