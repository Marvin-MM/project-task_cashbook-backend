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
            const data = await this.service.getTasks(
                req.params.workspaceId as string,
                req.user.userId,
                req.query as any,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Tasks retrieved', data });
        } catch (e) { next(e); }
    }

    async getTask(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTask(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
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

    async listComments(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.listComments(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Comments retrieved', data });
        } catch (e) { next(e); }
    }

    async addComment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.addComment(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Comment added', data });
        } catch (e) { next(e); }
    }

    async deleteComment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteComment(
                req.params.taskId as string,
                req.params.commentId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Comment deleted' });
        } catch (e) { next(e); }
    }

    async listChecklist(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.listChecklist(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Checklist retrieved', data });
        } catch (e) { next(e); }
    }

    async addChecklistItem(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.addChecklistItem(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Checklist item added', data });
        } catch (e) { next(e); }
    }

    async updateChecklistItem(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateChecklistItem(
                req.params.taskId as string,
                req.params.itemId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Checklist item updated', data });
        } catch (e) { next(e); }
    }

    async deleteChecklistItem(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteChecklistItem(
                req.params.taskId as string,
                req.params.itemId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Checklist item deleted' });
        } catch (e) { next(e); }
    }

    async getTaskActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTaskActivity(
                req.params.taskId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Activity retrieved', data });
        } catch (e) { next(e); }
    }
}
