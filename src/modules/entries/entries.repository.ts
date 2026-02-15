import { injectable, inject } from 'tsyringe';
import { PrismaClient, Prisma } from '@prisma/client';

@injectable()
export class EntriesRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }
    async findById(id: string) {
        return this.prisma.entry.findUnique({
            where: { id },
            include: {
                category: true,
                contact: true,
                paymentMode: true,
                createdBy: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
                attachments: true,
            },
        });
    }

    async findByCashbookId(
        cashbookId: string,
        params: {
            page: number;
            limit: number;
            type?: string;
            categoryId?: string;
            contactId?: string;
            paymentModeId?: string;
            startDate?: string;
            endDate?: string;
            sortBy: string;
            sortOrder: string;
        }
    ) {
        const where: Prisma.EntryWhereInput = {
            cashbookId,
            isDeleted: false,
        };

        if (params.type) where.type = params.type as any;
        if (params.categoryId) where.categoryId = params.categoryId;
        if (params.contactId) where.contactId = params.contactId;
        if (params.paymentModeId) where.paymentModeId = params.paymentModeId;

        if (params.startDate || params.endDate) {
            where.entryDate = {};
            if (params.startDate) where.entryDate.gte = new Date(params.startDate);
            if (params.endDate) where.entryDate.lte = new Date(params.endDate);
        }

        const [entries, total] = await Promise.all([
            this.prisma.entry.findMany({
                where,
                include: {
                    category: { select: { id: true, name: true, color: true } },
                    contact: { select: { id: true, name: true } },
                    paymentMode: { select: { id: true, name: true } },
                    createdBy: {
                        select: { id: true, email: true, firstName: true, lastName: true },
                    },
                    _count: { select: { attachments: true } },
                },
                skip: (params.page - 1) * params.limit,
                take: params.limit,
                orderBy: { [params.sortBy]: params.sortOrder },
            }),
            this.prisma.entry.count({ where }),
        ]);

        return { entries, total };
    }

    async createEntryAudit(data: {
        entryId: string;
        userId: string;
        action: string;
        changes?: any;
        oldValues?: any;
        newValues?: any;
    }) {
        return this.prisma.entryAudit.create({ data: data as any });
    }

    async getEntryAudits(entryId: string) {
        return this.prisma.entryAudit.findMany({
            where: { entryId },
            include: {
                user: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    // ─── Delete Requests ───────────────────────────────
    async createDeleteRequest(data: {
        entryId: string;
        requesterId: string;
        reason: string;
    }) {
        return this.prisma.deleteRequest.create({
            data,
            include: {
                entry: true,
                requester: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
        });
    }

    async findDeleteRequestsByEntry(entryId: string) {
        return this.prisma.deleteRequest.findMany({
            where: { entryId },
            include: {
                requester: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
                reviewer: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findDeleteRequestsByCashbook(cashbookId: string, status?: string) {
        const where: any = {
            entry: { cashbookId },
        };
        if (status) where.status = status;

        return this.prisma.deleteRequest.findMany({
            where,
            include: {
                entry: {
                    select: { id: true, description: true, amount: true, type: true },
                },
                requester: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
                reviewer: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findDeleteRequestById(id: string) {
        return this.prisma.deleteRequest.findUnique({
            where: { id },
            include: {
                entry: {
                    include: {
                        cashbook: true,
                    },
                },
                requester: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
        });
    }

    async updateDeleteRequest(id: string, data: {
        status: string;
        reviewerId: string;
        reviewNote?: string;
    }) {
        return this.prisma.deleteRequest.update({
            where: { id },
            data: {
                status: data.status as any,
                reviewerId: data.reviewerId,
                reviewNote: data.reviewNote,
                reviewedAt: new Date(),
            },
        });
    }

    async findPendingDeleteRequest(entryId: string) {
        return this.prisma.deleteRequest.findFirst({
            where: { entryId, status: 'PENDING' },
        });
    }
}
