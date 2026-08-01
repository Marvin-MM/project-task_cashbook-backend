import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AttendanceService } from './attendance.service';
import { PresenceService } from './presence.service';
import { AttendanceRollupService } from './rollup.service';
import { LeaveService } from './leave.service';
import { PeopleOpsService } from './people-ops.service';
import { AuthenticatedRequest } from '../../core/types';

const ok = (res: Response, message: string, data: unknown) =>
    res.status(StatusCodes.OK).json({ success: true, message, data });

@injectable()
export class AttendanceController {
    constructor(
        private service: AttendanceService,
        private presence: PresenceService,
        private rollup: AttendanceRollupService,
        private leave: LeaveService,
        private peopleOps: PeopleOpsService,
    ) { }

    // ─── Settings ─────────────────────────────────────────
    async getSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Settings retrieved',
                await this.service.getSettings(req.params.workspaceId as string));
        } catch (e) { next(e); }
    }

    async updateSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Settings updated', await this.service.updateSettings(
                req.params.workspaceId as string, req.user.userId, req.body,
            ));
        } catch (e) { next(e); }
    }

    // ─── Sites ────────────────────────────────────────────
    async listSites(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Locations retrieved',
                await this.service.listSites(req.params.workspaceId as string));
        } catch (e) { next(e); }
    }

    async createSite(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            const data = await this.service.createSite(
                req.params.workspaceId as string, req.user.userId, req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Location added', data });
        } catch (e) { next(e); }
    }

    async updateSite(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Location updated', await this.service.updateSite(
                req.params.siteId as string, req.params.workspaceId as string,
                req.user.userId, req.body,
            ));
        } catch (e) { next(e); }
    }

    async deactivateSite(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Location retired', await this.service.deactivateSite(
                req.params.siteId as string, req.params.workspaceId as string, req.user.userId,
            ));
        } catch (e) { next(e); }
    }

    // ─── Schedules ────────────────────────────────────────
    async listSchedules(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Schedules retrieved',
                await this.service.listSchedules(req.params.workspaceId as string));
        } catch (e) { next(e); }
    }

    async createSchedule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            const data = await this.service.createSchedule(
                req.params.workspaceId as string, req.user.userId, req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Schedule set', data });
        } catch (e) { next(e); }
    }

    // ─── Holidays ─────────────────────────────────────────
    async listHolidays(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Holidays retrieved', await this.service.listHolidays(
                req.params.workspaceId as string,
                req.query.year ? Number(req.query.year) : undefined,
            ));
        } catch (e) { next(e); }
    }

    async createHoliday(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            const data = await this.service.createHoliday(
                req.params.workspaceId as string, req.user.userId, req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Holiday added', data });
        } catch (e) { next(e); }
    }

    async deleteHoliday(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            await this.service.deleteHoliday(
                req.params.holidayId as string, req.params.workspaceId as string,
            );
            ok(res, 'Holiday removed', null);
        } catch (e) { next(e); }
    }

    // ─── Presence and the team view ───────────────────────
    async setPresence(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Status updated', await this.presence.setPresence(
                req.params.workspaceId as string, req.user.userId,
                req.body.status, req.body.note,
            ));
        } catch (e) { next(e); }
    }

    async getTeamStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Team status retrieved', await this.service.getTeamStatus(
                req.params.workspaceId as string, req.user.userId,
            ));
        } catch (e) { next(e); }
    }

    // ─── Leave ────────────────────────────────────────────
    async listLeaveTypes(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Leave types retrieved',
                await this.leave.listTypes(req.params.workspaceId as string));
        } catch (e) { next(e); }
    }

    async requestLeave(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            const data = await this.leave.requestLeave(
                req.params.workspaceId as string, req.user.userId, req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Leave requested', data });
        } catch (e) { next(e); }
    }

    async listLeave(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Leave retrieved', await this.leave.listRequests(
                req.params.workspaceId as string, req.user.userId, req.query as any,
            ));
        } catch (e) { next(e); }
    }

    async reviewLeave(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, req.body.approve ? 'Leave approved' : 'Leave declined',
                await this.leave.reviewLeave(
                    req.params.requestId as string, req.params.workspaceId as string,
                    req.user.userId, req.body,
                ));
        } catch (e) { next(e); }
    }

    async withdrawLeave(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Leave withdrawn', await this.leave.withdrawLeave(
                req.params.requestId as string, req.params.workspaceId as string, req.user.userId,
            ));
        } catch (e) { next(e); }
    }

    async cancelLeave(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Leave cancelled', await this.leave.cancelApprovedLeave(
                req.params.requestId as string, req.params.workspaceId as string, req.user.userId,
            ));
        } catch (e) { next(e); }
    }

    // ─── Overtime ─────────────────────────────────────────
    async requestOvertime(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            const data = await this.peopleOps.requestOvertime(
                req.params.workspaceId as string, req.user.userId, req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Overtime requested', data });
        } catch (e) { next(e); }
    }

    async listOvertime(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Overtime retrieved', await this.peopleOps.listOvertime(
                req.params.workspaceId as string, req.user.userId, req.query as any,
            ));
        } catch (e) { next(e); }
    }

    async reviewOvertime(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, req.body.approve ? 'Overtime approved' : 'Overtime declined',
                await this.peopleOps.reviewOvertime(
                    req.params.requestId as string, req.params.workspaceId as string,
                    req.user.userId, req.body,
                ));
        } catch (e) { next(e); }
    }

    // ─── Flags ────────────────────────────────────────────
    async listFlags(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Flags retrieved', await this.peopleOps.listFlags(
                req.params.workspaceId as string, req.user.userId, req.query as any,
            ));
        } catch (e) { next(e); }
    }

    async waiveFlag(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Flag waived', await this.peopleOps.waiveFlag(
                req.params.flagId as string, req.params.workspaceId as string,
                req.user.userId, req.body,
            ));
        } catch (e) { next(e); }
    }

    // ─── Work reports ─────────────────────────────────────
    async submitWorkReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            const data = await this.peopleOps.submitWorkReport(
                req.params.workspaceId as string, req.user.userId, req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Report submitted', data });
        } catch (e) { next(e); }
    }

    async listWorkReports(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, 'Reports retrieved', await this.peopleOps.listWorkReports(
                req.params.workspaceId as string, req.user.userId, req.query as any,
            ));
        } catch (e) { next(e); }
    }

    async reviewWorkReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            ok(res, req.body.approve ? 'Report approved' : 'Report sent back',
                await this.peopleOps.reviewWorkReport(
                    req.params.reportId as string, req.params.workspaceId as string,
                    req.user.userId, req.body,
                ));
        } catch (e) { next(e); }
    }

    // ─── Rollup ───────────────────────────────────────────
    async recompute(req: AuthenticatedRequest, res: Response, next: NextFunction) {
        try {
            const { from, to } = req.query as { from?: string; to?: string };
            if (!from) {
                res.status(StatusCodes.BAD_REQUEST).json({
                    success: false, message: 'A "from" date is required',
                });
                return;
            }
            const days = await this.rollup.recomputeRange(
                req.params.workspaceId as string, from, to ?? from,
            );
            ok(res, `Recomputed ${days} day(s)`, { days });
        } catch (e) { next(e); }
    }
}
