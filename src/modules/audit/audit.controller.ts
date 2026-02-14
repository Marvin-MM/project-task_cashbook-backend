import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AuthenticatedRequest } from '../../core/types';
import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();

export class AuditController {
    async getWorkspaceAuditLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
            const action = req.query.action as string | undefined;

            const where: any = { workspaceId };
            if (action) where.action = action;

            const [logs, total] = await Promise.all([
                prisma.auditLog.findMany({
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
                prisma.auditLog.count({ where }),
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
                prisma.financialAuditLog.findMany({
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
                prisma.financialAuditLog.count({ where: { cashbookId } }),
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
