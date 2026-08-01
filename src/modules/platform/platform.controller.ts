import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { PlatformService } from './platform.service';
import { AuthenticatedRequest } from '../../core/types';

const page = (v: unknown) => Math.max(1, Number(v) || 1);
const limit = (v: unknown) => Math.min(100, Math.max(1, Number(v) || 20));

@injectable()
export class PlatformController {
    constructor(private service: PlatformService) { }

    async getStats(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getStats();
            res.status(StatusCodes.OK).json({ success: true, message: 'Platform stats', data });
        } catch (error) {
            next(error);
        }
    }

    async listUsers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.service.listUsers({
                page: page(req.query.page),
                limit: limit(req.query.limit),
                search: req.query.search as string | undefined,
            });
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Users retrieved',
                data: result.data,
                pagination: {
                    page: result.page,
                    limit: result.limit,
                    total: result.total,
                    totalPages: Math.ceil(result.total / result.limit),
                },
            });
        } catch (error) {
            next(error);
        }
    }

    async toggleUserStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.toggleUserStatus(
                req.params.userId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: data.isActive ? 'User activated' : 'User deactivated',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async listWorkspaces(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.service.listWorkspaces({
                page: page(req.query.page),
                limit: limit(req.query.limit),
                search: req.query.search as string | undefined,
            });
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Workspaces retrieved',
                data: result.data,
                pagination: {
                    page: result.page,
                    limit: result.limit,
                    total: result.total,
                    totalPages: Math.ceil(result.total / result.limit),
                },
            });
        } catch (error) {
            next(error);
        }
    }

    async listAuditLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.service.listAuditLogs({
                page: page(req.query.page),
                limit: limit(req.query.limit),
                action: req.query.action as string | undefined,
                workspaceId: req.query.workspaceId as string | undefined,
            });
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Audit logs retrieved',
                data: result.data,
                pagination: {
                    page: result.page,
                    limit: result.limit,
                    total: result.total,
                    totalPages: Math.ceil(result.total / result.limit),
                },
            });
        } catch (error) {
            next(error);
        }
    }

    async listSuperAdmins(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.listSuperAdmins();
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Superadmins are managed by the SUPER_ADMIN_EMAILS environment variable',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    /** Re-sync the database with the env var without waiting for a restart. */
    async reconcileSuperAdmins(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.reconcileSuperAdmins();
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Superadmins reconciled with configuration',
                data,
            });
        } catch (error) {
            next(error);
        }
    }
}
