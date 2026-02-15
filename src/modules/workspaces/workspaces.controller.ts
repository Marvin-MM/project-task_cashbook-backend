import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { WorkspacesService } from './workspaces.service';
import { AuthenticatedRequest, ApiResponse } from '../../core/types';

@injectable()
export class WorkspacesController {
    constructor(private workspacesService: WorkspacesService) { }

    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaces = await this.workspacesService.getUserWorkspaces(req.user.userId);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Workspaces retrieved successfully',
                data: workspaces,
            });
        } catch (error) {
            next(error);
        }
    }

    async getOne(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspace = await this.workspacesService.getWorkspace(req.params.workspaceId as string, req.user.userId);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Workspace retrieved successfully',
                data: workspace,
            });
        } catch (error) {
            next(error);
        }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspace = await this.workspacesService.createBusinessWorkspace(req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'Business workspace created successfully',
                data: workspace,
            });
        } catch (error) {
            next(error);
        }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspace = await this.workspacesService.updateWorkspace(
                req.params.workspaceId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Workspace updated successfully',
                data: workspace,
            });
        } catch (error) {
            next(error);
        }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.workspacesService.deleteWorkspace(req.params.workspaceId as string, req.user.userId);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Workspace deleted successfully',
            });
        } catch (error) {
            next(error);
        }
    }
}
