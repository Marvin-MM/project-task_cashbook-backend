import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { TimeTrackingService } from './time-tracking.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class TimeTrackingController {
    constructor(private service: TimeTrackingService) {}

    async getTimeEntries(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTimeEntries(
                req.params.workspaceId as string,
                req.user.userId,
                req.query as any,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Time entries retrieved', data });
        } catch (e) { next(e); }
    }

    async getTimeEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTimeEntry(
                req.params.entryId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Time entry retrieved', data });
        } catch (e) { next(e); }
    }

    async createTimeEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createTimeEntry(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Time entry created', data });
        } catch (e) { next(e); }
    }

    async updateTimeEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateTimeEntry(
                req.params.entryId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Time entry updated', data });
        } catch (e) { next(e); }
    }

    async deleteTimeEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteTimeEntry(
                req.params.entryId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Time entry deleted' });
        } catch (e) { next(e); }
    }

    async setTimeEntryLock(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.setTimeEntryLock(
                req.params.entryId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: data.isLocked ? 'Time entry locked' : 'Time entry unlocked',
                data,
            });
        } catch (e) { next(e); }
    }

    async getTimeSummary(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTimeSummary(
                req.params.workspaceId as string,
                req.user.userId,
                req.query as any,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Time summary retrieved', data });
        } catch (e) { next(e); }
    }

    async startTimer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.startTimer(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Timer started', data });
        } catch (e) { next(e); }
    }

    async stopTimer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.stopTimer(
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Timer stopped', data });
        } catch (e) { next(e); }
    }

    async getActiveTimer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getActiveTimer(
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Active timer retrieved', data: data ?? null });
        } catch (e) { next(e); }
    }

    async getWorkSessions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getWorkSessions(
                req.params.workspaceId as string,
                req.user.userId,
                req.query as any,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Work sessions retrieved', data });
        } catch (e) { next(e); }
    }

    async getActiveSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getActiveSession(
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Active session retrieved', data: data ?? null });
        } catch (e) { next(e); }
    }

    async clockIn(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.clockIn(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Clocked in', data });
        } catch (e) { next(e); }
    }

    async clockOut(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.clockOut(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Clocked out', data });
        } catch (e) { next(e); }
    }
}
