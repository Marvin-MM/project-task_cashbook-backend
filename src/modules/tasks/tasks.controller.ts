import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { TasksService } from './tasks.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class TasksController {
    constructor(private service: TasksService) {}

    async getTasks(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTasks(req.params.workspaceId as string, req.query as any);
            res.status(StatusCodes.OK).json({ success: true, message: 'Tasks retrieved', data });
        } catch (e) { next(e); }
    }

    async getTask(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTask(
                req.params.taskId as string,
                req.params.workspaceId as string,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Task retrieved', data });
        } catch (e) { next(e); }
    }

    async createTask(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createTask(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Task created', data });
        } catch (e) { next(e); }
    }

    async updateTask(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateTask(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Task updated', data });
        } catch (e) { next(e); }
    }

    async changeStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.changeStatus(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Task status updated', data });
        } catch (e) { next(e); }
    }

    async deleteTask(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteTask(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Task deleted' });
        } catch (e) { next(e); }
    }

    async assignUsers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.assignUsers(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Users assigned', data });
        } catch (e) { next(e); }
    }

    async unassignUser(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.unassignUser(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.params.userId as string,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'User unassigned' });
        } catch (e) { next(e); }
    }
}
