/**
 * Attendance configuration and the live team view.
 *
 * Policy (settings, sites, schedules, holidays) is HR's; the team view is
 * everybody's, which is why presence and location are separated here rather
 * than in the client. Presence answers "is Jane reachable" and is fine to share
 * widely. Where Jane physically is, and how long she has been there, is not —
 * that stays behind VIEW_ALL_ATTENDANCE.
 */
import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { workspaceUserCan } from '../../core/authz/workspace-access';
import { invalidateClock } from '../../core/time/workspace-clock';
import { crossesMidnight } from '../../core/time/schedule-resolver';
import type {
    AttendanceSettingsPatchDto,
    CreateScheduleDto,
    CreateSiteDto,
    UpdateSiteDto,
} from './attendance.dto';

@injectable()
export class AttendanceService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    private can(workspaceId: string, userId: string, permission: WorkspacePermission) {
        return workspaceUserCan(this.prisma, workspaceId, userId, permission);
    }

    // ─── Settings ─────────────────────────────────────────────

    /** Created on first read so a workspace never has to be "set up" first. */
    async getSettings(workspaceId: string) {
        const existing = await this.prisma.attendanceSettings.findUnique({
            where: { workspaceId },
        });
        if (existing) return existing;
        return this.prisma.attendanceSettings.create({ data: { workspaceId } });
    }

    async updateSettings(workspaceId: string, userId: string, dto: AttendanceSettingsPatchDto) {
        await this.getSettings(workspaceId);
        const updated = await this.prisma.attendanceSettings.update({
            where: { workspaceId },
            data: dto,
        });

        // dayBoundaryMinutes feeds the clock, which is cached for a minute.
        invalidateClock(workspaceId);

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.WORKSPACE_ATTENDANCE_SETTINGS_UPDATED,
                resource: 'attendance_settings',
                resourceId: updated.id,
                details: dto as any,
            },
        });
        return updated;
    }

    // ─── Sites ────────────────────────────────────────────────

    async listSites(workspaceId: string) {
        return this.prisma.attendanceSite.findMany({
            where: { workspaceId },
            include: { task: { select: { id: true, title: true } } },
            orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        });
    }

    async createSite(workspaceId: string, userId: string, dto: CreateSiteDto) {
        if (dto.taskId) {
            const task = await this.prisma.task.findUnique({
                where: { id: dto.taskId },
                select: { workspaceId: true },
            });
            if (!task || task.workspaceId !== workspaceId) throw new NotFoundError('Task');
        }

        try {
            const site = await this.prisma.attendanceSite.create({
                data: { workspaceId, ...dto },
            });
            await this.prisma.auditLog.create({
                data: {
                    userId, workspaceId,
                    action: AuditAction.WORKSPACE_ATTENDANCE_SETTINGS_UPDATED,
                    resource: 'attendance_site',
                    resourceId: site.id,
                    details: { created: dto } as any,
                },
            });
            return site;
        } catch (error: any) {
            if (error?.code === 'P2002') {
                // Either attendance_sites_one_primary or the task already has a
                // site — both are "there can only be one", so say which.
                throw new AppError(
                    dto.taskId
                        ? 'That task already has a location.'
                        : 'There is already a primary location. Clear it first.',
                    409,
                    'SITE_ALREADY_EXISTS',
                );
            }
            throw error;
        }
    }

    async updateSite(siteId: string, workspaceId: string, userId: string, dto: UpdateSiteDto) {
        const site = await this.prisma.attendanceSite.findUnique({ where: { id: siteId } });
        if (!site || site.workspaceId !== workspaceId) throw new NotFoundError('Location');

        const updated = await this.prisma.attendanceSite.update({
            where: { id: siteId },
            data: dto,
        });
        await this.prisma.auditLog.create({
            data: {
                userId, workspaceId,
                action: AuditAction.WORKSPACE_ATTENDANCE_SETTINGS_UPDATED,
                resource: 'attendance_site',
                resourceId: siteId,
                details: dto as any,
            },
        });
        return updated;
    }

    /**
     * Retire a location.
     *
     * Deactivated rather than deleted: sessions point at the site they were
     * recorded from, and deleting it would erase where somebody clocked in.
     */
    async deactivateSite(siteId: string, workspaceId: string, userId: string) {
        return this.updateSite(siteId, workspaceId, userId, { isActive: false, isPrimary: false });
    }

    // ─── Schedules ────────────────────────────────────────────

    async listSchedules(workspaceId: string) {
        return this.prisma.workSchedule.findMany({
            where: { workspaceId, effectiveTo: null },
            include: { user: { select: { id: true, firstName: true, lastName: true } } },
            orderBy: [{ userId: { sort: 'asc', nulls: 'first' } }],
        });
    }

    /**
     * Put a new schedule in force from a date.
     *
     * Supersedes rather than edits: the previous row is closed off at the new
     * one's start. Editing in place would rewrite history — every past
     * late-arrival flag was computed against the hours that applied then.
     */
    async createSchedule(workspaceId: string, userId: string, dto: CreateScheduleDto) {
        if (dto.userId) {
            const membership = await this.prisma.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId, userId: dto.userId } },
            });
            if (!membership) throw new NotFoundError('Workspace member');
        }

        const effectiveFrom = new Date(`${dto.effectiveFrom}T00:00:00.000Z`);

        return this.prisma.$transaction(async (tx) => {
            await tx.workSchedule.updateMany({
                where: {
                    workspaceId,
                    userId: dto.userId ?? null,
                    effectiveTo: null,
                },
                data: { effectiveTo: effectiveFrom },
            });

            const schedule = await tx.workSchedule.create({
                data: {
                    workspaceId,
                    userId: dto.userId ?? null,
                    name: dto.name ?? 'Standard hours',
                    workingDays: dto.workingDays,
                    startTime: dto.startTime,
                    endTime: dto.endTime,
                    crossesMidnight: crossesMidnight(dto.startTime, dto.endTime),
                    graceMinutes: dto.graceMinutes ?? 10,
                    earlyOutGraceMinutes: dto.earlyOutGraceMinutes ?? 10,
                    breakMinutes: dto.breakMinutes ?? 0,
                    breakPaid: dto.breakPaid ?? false,
                    expectedMinutesPerDay: dto.expectedMinutesPerDay,
                    clockInWindowStart: dto.clockInWindowStart ?? null,
                    clockInWindowEnd: dto.clockInWindowEnd ?? null,
                    clockOutWindowStart: dto.clockOutWindowStart ?? null,
                    effectiveFrom,
                    createdById: userId,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId, workspaceId,
                    action: AuditAction.WORKSPACE_ATTENDANCE_SETTINGS_UPDATED,
                    resource: 'work_schedule',
                    resourceId: schedule.id,
                    details: { forUserId: dto.userId ?? null } as any,
                },
            });
            return schedule;
        });
    }

    // ─── Holidays ─────────────────────────────────────────────

    async listHolidays(workspaceId: string, year?: number) {
        const where: Record<string, unknown> = { workspaceId };
        if (year) {
            where.date = {
                gte: new Date(`${year}-01-01T00:00:00.000Z`),
                lte: new Date(`${year}-12-31T00:00:00.000Z`),
            };
        }
        return this.prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });
    }

    async createHoliday(workspaceId: string, userId: string, dto: { date: string; name: string }) {
        try {
            return await this.prisma.holiday.create({
                data: {
                    workspaceId,
                    date: new Date(`${dto.date}T00:00:00.000Z`),
                    name: dto.name,
                    createdById: userId,
                },
            });
        } catch (error: any) {
            if (error?.code === 'P2002') {
                throw new AppError('That date is already a holiday.', 409, 'HOLIDAY_EXISTS');
            }
            throw error;
        }
    }

    async deleteHoliday(holidayId: string, workspaceId: string) {
        const deleted = await this.prisma.holiday.deleteMany({
            where: { id: holidayId, workspaceId },
        });
        if (deleted.count === 0) throw new NotFoundError('Holiday');
    }

    // ─── The live team view ───────────────────────────────────

    /**
     * Who is around right now.
     *
     * Presence is shared with everyone (subject to the workspace setting);
     * location, distance and how long somebody has been clocked in are only
     * included for people who can see everyone's attendance. Filtering in the
     * query rather than the client means the data never reaches a browser that
     * should not have it.
     */
    async getTeamStatus(workspaceId: string, userId: string) {
        const [settings, canSeeDetail] = await Promise.all([
            this.getSettings(workspaceId),
            this.can(workspaceId, userId, WorkspacePermission.VIEW_ALL_ATTENDANCE),
        ]);

        if (!settings.presenceVisibleToAllMembers && !canSeeDetail) {
            // The workspace has turned presence sharing off; you still see
            // yourself, so the page has something to render.
            return this.presenceRows(workspaceId, canSeeDetail, userId);
        }
        return this.presenceRows(workspaceId, canSeeDetail);
    }

    private async presenceRows(workspaceId: string, includeDetail: boolean, onlyUserId?: string) {
        const sessions = await this.prisma.workSession.findMany({
            where: {
                workspaceId,
                clockOut: null,
                ...(onlyUserId ? { userId: onlyUserId } : {}),
            },
            select: {
                id: true,
                userId: true,
                presenceStatus: true,
                presenceChangedAt: true,
                clockIn: includeDetail,
                clockInLocationLabel: includeDetail,
                clockInWithinGeofence: includeDetail,
                user: { select: { id: true, firstName: true, lastName: true, email: true } },
                clockInTask: { select: { id: true, title: true } },
            },
            orderBy: { clockIn: 'desc' },
        });

        return sessions.map((session) => ({
            userId: session.userId,
            user: session.user,
            presenceStatus: session.presenceStatus,
            presenceChangedAt: session.presenceChangedAt,
            task: session.clockInTask,
            ...(includeDetail
                ? {
                    sessionId: session.id,
                    clockIn: session.clockIn,
                    location: session.clockInLocationLabel,
                    withinGeofence: session.clockInWithinGeofence,
                }
                : {}),
        }));
    }
}
