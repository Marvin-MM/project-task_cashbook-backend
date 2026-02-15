import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AuthenticatedRequest } from '../../core/types';
import { NotFoundError, AppError } from '../../core/errors/AppError';
import { UsersRepository } from '../users/users.repository';

@injectable()
export class AdminController {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
        private usersRepository: UsersRepository,
    ) { }

    // List all users (paginated)
    async listUsers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
            const search = req.query.search as string | undefined;

            const { users, total } = await this.usersRepository.findAll({ page, limit, search });

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Users retrieved',
                data: users,
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

    // Toggle user active status
    async toggleUserStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = req.params.userId as string;

            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (!user) throw new NotFoundError('User');

            if (user.id === req.user.userId) {
                throw new AppError('Cannot deactivate your own account', 400, 'SELF_DEACTIVATION');
            }

            const updated = await this.prisma.user.update({
                where: { id: userId },
                data: { isActive: !user.isActive },
                select: { id: true, email: true, isActive: true },
            });

            res.status(StatusCodes.OK).json({
                success: true,
                message: `User ${updated.isActive ? 'activated' : 'deactivated'} successfully`,
                data: updated,
            });
        } catch (error) {
            next(error);
        }
    }

    // Platform statistics
    async getStats(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const [
                totalUsers,
                activeUsers,
                totalWorkspaces,
                totalCashbooks,
                totalEntries,
            ] = await Promise.all([
                this.prisma.user.count(),
                this.prisma.user.count({ where: { isActive: true } }),
                this.prisma.workspace.count({ where: { isActive: true } }),
                this.prisma.cashbook.count({ where: { isActive: true } }),
                this.prisma.entry.count({ where: { isDeleted: false } }),
            ]);

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Platform statistics retrieved',
                data: {
                    users: { total: totalUsers, active: activeUsers },
                    workspaces: totalWorkspaces,
                    cashbooks: totalCashbooks,
                    entries: totalEntries,
                },
            });
        } catch (error) {
            next(error);
        }
    }

    // List all workspaces
    async listWorkspaces(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

            const [workspaces, total] = await Promise.all([
                this.prisma.workspace.findMany({
                    include: {
                        owner: { select: { id: true, email: true, firstName: true, lastName: true } },
                        _count: { select: { members: true, cashbooks: true } },
                    },
                    skip: (page - 1) * limit,
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                }),
                this.prisma.workspace.count(),
            ]);

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Workspaces retrieved',
                data: workspaces,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            });
        } catch (error) {
            next(error);
        }
    }
}
