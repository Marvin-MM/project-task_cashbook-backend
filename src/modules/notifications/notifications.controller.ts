import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { NotificationsService } from './notifications.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class NotificationsController {
    constructor(private service: NotificationsService) {}

    async getNotifications(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getUserNotifications(
                req.user.userId,
                req.params.workspaceId as string,
                req.query as any,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Notifications retrieved', data });
        } catch (e) { next(e); }
    }

    async markAsRead(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.markAsRead(
                req.user.userId,
                req.params.workspaceId as string,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Notifications marked as read' });
        } catch (e) { next(e); }
    }

    async markAllRead(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.markAllRead(req.user.userId, req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'All notifications marked as read' });
        } catch (e) { next(e); }
    }

    async deleteNotification(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteNotification(
                req.params.notificationId as string,
                req.user.userId,
                req.params.workspaceId as string,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Notification deleted' });
        } catch (e) { next(e); }
    }
}
