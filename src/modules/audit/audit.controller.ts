import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class AuditController {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    async getWorkspaceAuditLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
            const action = req.query.action as string | undefined;

            const where: any = { workspaceId };
            if (action) where.action = action;

            const [logs, total] = await Promise.all([
                this.prisma.auditLog.findMany({
                    where,
                    include: {
                        user: {
                            select: { id: true, email: true, firstName: true, lastName: true },
                        },
                    },
                    skip: (page - 1) * limit,
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                }),
                this.prisma.auditLog.count({ where }),
            ]);

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Audit logs retrieved',
                data: logs,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            next(error);
        }
    }

    async getFinancialAuditLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const cashbookId = req.params.cashbookId as string;
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

            const [logs, total] = await Promise.all([
                this.prisma.financialAuditLog.findMany({
                    where: { cashbookId },
                    include: {
                        user: {
                            select: { id: true, email: true, firstName: true, lastName: true },
                        },
                    },
                    skip: (page - 1) * limit,
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                }),
                this.prisma.financialAuditLog.count({ where: { cashbookId } }),
            ]);

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Financial audit logs retrieved',
                data: logs,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            next(error);
        }
    }
}
