import { injectable, inject } from 'tsyringe';
import {
    Prisma,
    AttendanceFlagType,
    PresenceStatus,
    PrismaClient,
    TimeEntrySource,
    WorkSessionStatus,
} from '@prisma/client';
import { TimeTrackingRepository } from './time-tracking.repository';
import { NotFoundError, AuthorizationError, AppError, ConflictError } from '../../core/errors/AppError';
import { WorkspaceClock, clockFor, invalidateClock, toDateColumn } from '../../core/time/workspace-clock';
import { resolveSchedule } from '../../core/time/schedule-resolver';
import { evaluateGeofence, type GeofenceEnforcement } from '../../core/time/geo';
import { PresenceService } from '../attendance/presence.service';
import { workspaceUserCan } from '../../core/authz/workspace-access';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { AuditAction, WorkspaceRole } from '../../core/types';
import {
    CreateTimeEntryDto,
    UpdateTimeEntryDto,
    StartTimerDto,
    ClockInDto,
    ClockOutDto,
    TimeEntryQueryDto,
    WorkSessionQueryDto,
    LockTimeEntryDto,
    TimeSummaryQueryDto,
    AttendanceSettingsDto,
    CreateWorkSessionDto,
    UpdateWorkSessionDto,
} from './time-tracking.dto';

/** Compute duration in whole minutes (server-side only — never from client). */
function computeMinutes(start: Date, end: Date): number {
    return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
}

function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
    const earthRadiusMeters = 6_371_000;
    const toRadians = (degrees: number) => degrees * Math.PI / 180;
    const dLat = toRadians(b.latitude - a.latitude);
    const dLon = toRadians(b.longitude - a.longitude);
    const lat1 = toRadians(a.latitude);
    const lat2 = toRadians(b.latitude);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusMeters * Math.asin(Math.sqrt(h));
}

@injectable()
export class TimeTrackingService {
    constructor(
        private repo: TimeTrackingRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
        private presenceService: PresenceService,
    ) {}

    // ─── Helpers ──────────────────────────────────────────────
    private async assertWorkspaceMember(workspaceId: string, userId: string) {
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws || !ws.isActive) throw new NotFoundError('Workspace');
        if (ws.ownerId === userId) return;
        const m = await this.prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId } },
        });
        if (!m) throw new AuthorizationError('You are not a member of this workspace');
    }

    /**
     * One helper used to answer every "is this person in charge" question here,
     * hard-coded to `owner || ADMIN`. It covered several genuinely different
     * grants, which is why they are now named separately: HR must configure
     * attendance without being able to reassign project work, and a project
     * manager must log time for their team without being able to change the
     * organisation's working hours.
     */
    private can(workspaceId: string, userId: string, permission: WorkspacePermission) {
        return workspaceUserCan(this.prisma, workspaceId, userId, permission);
    }

    /** See other people's sessions, entries and totals. */
    private isWorkspaceManager(workspaceId: string, userId: string): Promise<boolean> {
        return this.can(workspaceId, userId, WorkspacePermission.VIEW_ALL_ATTENDANCE);
    }

    private async assertCan(
        workspaceId: string,
        userId: string,
        permission: WorkspacePermission,
        message: string,
    ) {
        if (!(await this.can(workspaceId, userId, permission))) {
            throw new AuthorizationError(message);
        }
    }

    private async assertUserInWorkspace(workspaceId: string, targetUserId: string) {
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws || !ws.isActive) throw new NotFoundError('Workspace');
        if (ws.ownerId === targetUserId) return;
        const membership = await this.prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        });
        if (!membership) {
            throw new AppError('User is not a member of this workspace', 400, 'USER_NOT_IN_WORKSPACE');
        }
    }

    private async getWorkspaceAttendancePolicy(workspaceId: string) {
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: {
                id: true,
                isActive: true,
                timezone: true,
                enforceClockWindows: true,
                attendanceLocationName: true,
                attendanceLatitude: true,
                attendanceLongitude: true,
                attendanceRadiusMeters: true,
                attendanceClockInStart: true,
                attendanceClockInEnd: true,
                attendanceClockOutStart: true,
            },
        });
        if (!workspace || !workspace.isActive) throw new NotFoundError('Workspace');
        return workspace;
    }

    /**
     * Check the arrival window, in the WORKSPACE's zone.
     *
     * This used to read `new Date().getHours()` — the server container's zone —
     * against times the schema described as "local". Deployed in UTC, a Kampala
     * workspace configured to allow 08:00-09:30 really allowed 11:00-12:30 EAT.
     *
     * Advisory by default. Refusing a late clock-in means a late employee
     * records no attendance at all, which is worse for everyone than recording
     * it as late; an owner who genuinely wants the hard door opts in with
     * `enforceClockWindows`.
     *
     * Deliberately says nothing about lateness. The window is a question of
     * PERMISSION — when you may clock in at all — and is a different thing from
     * whether you were late, which is measured against the shift start plus its
     * grace period. Conflating them gave the system two contradictory
     * definitions of "late": this path measured from the window closing, while
     * the rollup measured from the scheduled start.
     */
    private assertClockInWindow(
        policy: Awaited<ReturnType<TimeTrackingService['getWorkspaceAttendancePolicy']>>,
        clock: WorkspaceClock,
        at: Date,
        schedule?: { clockInWindowStart: string | null; clockInWindowEnd: string | null },
    ): void {
        // The schedule owns the window now; the workspace columns are the
        // fallback for a workspace that has not been migrated to one yet.
        const start = schedule?.clockInWindowStart ?? policy.attendanceClockInStart;
        const end = schedule?.clockInWindowEnd ?? policy.attendanceClockInEnd;
        if (!start || !end) return;

        const businessDate = clock.businessDate(at);
        const opensAt = clock.atLocalTime(businessDate, start);
        const closesAt = clock.atLocalTime(businessDate, end);

        if (at >= opensAt && at <= closesAt) return;

        if (policy.enforceClockWindows) {
            throw new AppError(
                `You can only clock in between ${start} and ${end}`,
                400,
                'OUTSIDE_ATTENDANCE_TIME_WINDOW',
            );
        }
    }

    /**
     * Minutes late, measured the ONE way the whole system measures it: past the
     * scheduled start, past the grace period.
     *
     * Shared with the rollup rather than reimplemented, so a badge raised at
     * clock-in and the figure on the day never disagree.
     */
    private lateMinutes(
        at: Date,
        schedule: { startUtc: Date | null; graceMinutes: number; isWorkingDay: boolean },
    ): number {
        // Nobody is late for a day they were not expected on.
        if (!schedule.isWorkingDay || !schedule.startUtc) return 0;
        const due = new Date(schedule.startUtc.getTime() + schedule.graceMinutes * 60_000);
        return at > due ? WorkspaceClock.minutesBetween(due, at) : 0;
    }

    /**
     * Whether a clock-out is earlier than the workspace would like.
     *
     * Never throws. Nothing may refuse a clock-out: when it could, a session
     * whose window had passed became impossible to close, and because the
     * one-open-session rule is global that single stuck row locked the person
     * out of clocking in to every other organisation they belong to, with no
     * remedy short of editing the database.
     */
    private evaluateEarlyClockOut(
        policy: Awaited<ReturnType<TimeTrackingService['getWorkspaceAttendancePolicy']>>,
        clock: WorkspaceClock,
        at: Date,
        businessDate: Date,
        schedule?: { clockOutWindowStart: string | null },
    ): { minutesEarly: number } {
        const start = schedule?.clockOutWindowStart ?? policy.attendanceClockOutStart;
        if (!start) return { minutesEarly: 0 };

        const earliest = clock.atLocalTime(clock.localDate(businessDate), start);
        return {
            minutesEarly: at < earliest ? WorkspaceClock.minutesBetween(at, earliest) : 0,
        };
    }

    /**
     * Every site this person may clock in from right now.
     *
     * Workspace-level sites, plus the site attached to a task they are assigned
     * to — which is what "clock in from where the job is" means. A task site
     * belonging to someone else's task is deliberately not offered.
     */
    private async candidateSites(workspaceId: string, userId: string, taskId?: string) {
        const settings = await this.prisma.attendanceSettings.findUnique({
            where: { workspaceId },
            select: { geofenceEnforcement: true, allowTaskSiteClockIn: true },
        });

        const sites = await this.prisma.attendanceSite.findMany({
            where: {
                workspaceId,
                isActive: true,
                OR: [
                    { taskId: null },
                    ...(settings?.allowTaskSiteClockIn && taskId
                        ? [{
                            taskId,
                            task: { assignments: { some: { userId } } },
                        }]
                        : []),
                ],
            },
            select: {
                id: true, name: true, latitude: true, longitude: true,
                radiusMeters: true, taskId: true,
            },
        });

        return { sites, enforcement: settings?.geofenceEnforcement ?? 'WARN' };
    }

    /**
     * Check a position against the workspace geofence.
     *
     * `enforce` is true for clock-in and false for clock-out. A clock-out is
     * never refused for being off-site: GPS drifts badly indoors, and somebody
     * who has already left the building would otherwise be unable to close
     * their session at all. Off-site departures are recorded, not blocked.
     */
    private evaluateAttendanceLocation(
        policy: Awaited<ReturnType<TimeTrackingService['getWorkspaceAttendancePolicy']>>,
        actual: { latitude?: number; longitude?: number },
        enforce: boolean,
    ): { withinFence: boolean | null } {
        if (
            policy.attendanceLatitude == null ||
            policy.attendanceLongitude == null ||
            policy.attendanceRadiusMeters == null
        ) {
            return { withinFence: null };
        }
        if (actual.latitude == null || actual.longitude == null) {
            if (enforce) {
                throw new AppError(
                    'Location is required to clock in for this workspace',
                    400,
                    'ATTENDANCE_LOCATION_REQUIRED',
                );
            }
            return { withinFence: null };
        }
        const distance = distanceMeters(
            { latitude: policy.attendanceLatitude, longitude: policy.attendanceLongitude },
            { latitude: actual.latitude, longitude: actual.longitude },
        );
        const withinFence = distance <= policy.attendanceRadiusMeters;
        if (!withinFence && enforce) {
            throw new AppError(
                `You must be within ${policy.attendanceRadiusMeters} meters of the approved location to clock in`,
                400,
                'OUTSIDE_ATTENDANCE_LOCATION',
            );
        }
        return { withinFence };
    }

    private async assertNoOverlappingWorkSession(
        userId: string,
        start: Date,
        end: Date,
        excludeId?: string,
    ) {
        const overlap = await this.prisma.workSession.findFirst({
            where: {
                userId,
                id: excludeId ? { not: excludeId } : undefined,
                AND: [
                    { clockIn: { lt: end } },
                    {
                        OR: [
                            { clockOut: null },
                            { clockOut: { gt: start } },
                        ],
                    },
                ],
            },
        });
        if (overlap) {
            throw new ConflictError('This work session overlaps with another session for the user');
        }
    }

    private async assertProjectMemberOrManager(projectId: string, workspaceId: string, userId: string) {
        // Delivery, not attendance: whoever runs projects may log against any of
        // them, and HR — who can see everyone's hours — may not.
        if (await this.can(workspaceId, userId, WorkspacePermission.MANAGE_PROJECTS)) return;
        const membership = await this.prisma.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId } },
        });
        if (!membership) {
            throw new AuthorizationError('You must be a project member to track time on this project');
        }
    }

    private async resolveTimeTarget(
        workspaceId: string,
        userId: string,
        requestedTaskId?: string | null,
        requestedProjectId?: string | null,
        archivedMessage = 'Cannot track time on an archived project',
    ) {
        let taskId = requestedTaskId ?? null;
        let projectId = requestedProjectId ?? null;

        if (taskId) {
            const task = await this.prisma.task.findUnique({
                where: { id: taskId },
                include: {
                    assignments: { select: { userId: true } },
                    project: { select: { id: true, status: true } },
                },
            });
            if (!task || task.workspaceId !== workspaceId) throw new NotFoundError('Task');
            if (projectId && task.projectId !== projectId) {
                throw new AppError('Task does not belong to the selected project', 400, 'TASK_PROJECT_MISMATCH');
            }
            if (!projectId && task.projectId) projectId = task.projectId;
            if (task.project?.status === 'ARCHIVED') {
                throw new AppError(archivedMessage, 400, 'PROJECT_ARCHIVED');
            }
            if (!task.projectId && !(await this.can(workspaceId, userId, WorkspacePermission.MANAGE_TASKS))) {
                const isTaskParticipant = task.createdById === userId || task.assignments.some((a) => a.userId === userId);
                if (!isTaskParticipant) {
                    throw new AuthorizationError('You can only track time on tasks you created or are assigned to');
                }
            }
        }

        if (projectId) {
            const project = await this.prisma.project.findUnique({ where: { id: projectId } });
            if (!project || project.workspaceId !== workspaceId) throw new NotFoundError('Project');
            if (project.status === 'ARCHIVED') {
                throw new AppError(archivedMessage, 400, 'PROJECT_ARCHIVED');
            }
            await this.assertProjectMemberOrManager(projectId, workspaceId, userId);
        }

        return { taskId, projectId };
    }

    // ─── Time Entries ─────────────────────────────────────────
    async getTimeEntries(workspaceId: string, userId: string, query: TimeEntryQueryDto) {
        const isWorkspaceManager = await this.isWorkspaceManager(workspaceId, userId);
        const { entries, total, page, limit } = await this.repo.findTimeEntries(
            workspaceId,
            query,
            { userId, isWorkspaceManager },
        );
        const totalPages = Math.ceil(total / limit);
        return {
            data: entries,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1,
            },
        };
    }

    async getTimeEntry(entryId: string, workspaceId: string, userId: string) {
        const entry = await this.repo.findTimeEntryById(entryId);
        if (!entry || entry.workspaceId !== workspaceId) throw new NotFoundError('Time entry');
        if (entry.userId !== userId && !(await this.isWorkspaceManager(workspaceId, userId))) {
            throw new AuthorizationError('You can only view your own time entries');
        }
        return entry;
    }

    async createTimeEntry(workspaceId: string, userId: string, dto: CreateTimeEntryDto) {
        await this.assertWorkspaceMember(workspaceId, userId);

        const startTime = new Date(dto.startTime);
        const endTime = dto.endTime ? new Date(dto.endTime) : null;

        if (dto.source === TimeEntrySource.TIMER) {
            throw new AppError('Timer entries must be started through the timer endpoint', 400, 'INVALID_TIME_SOURCE');
        }
        if (!endTime) {
            throw new AppError('Manual time entries require an endTime', 400, 'INVALID_TIME_RANGE');
        }
        if (endTime && endTime <= startTime) {
            throw new AppError('endTime must be after startTime', 400, 'INVALID_TIME_RANGE');
        }

        const { taskId, projectId } = await this.resolveTimeTarget(
            workspaceId,
            userId,
            dto.taskId,
            dto.projectId,
            'Cannot log time on an archived project',
        );

        // Overlap check (only for completed manual entries)
        if (endTime) {
            const overlap = await this.repo.findOverlappingEntry(userId, workspaceId, startTime, endTime);
            if (overlap) throw new ConflictError('This time range overlaps with an existing time entry');
        }

        const durationMinutes = endTime ? computeMinutes(startTime, endTime) : null;
        const clock = await clockFor(this.prisma, workspaceId);

        const entry = await this.prisma.$transaction(async (tx) => {
            const e = await tx.timeEntry.create({
                data: {
                    userId,
                    // Self-logged today. On-behalf entry is a phase 4 grant, and
                    // this column is what will tell the two apart.
                    createdById: userId,
                    workspaceId,
                    taskId,
                    projectId,
                    startTime,
                    endTime,
                    businessDate: clock.businessDateColumn(startTime),
                    durationMinutes,
                    source: dto.source ?? TimeEntrySource.MANUAL,
                    description: dto.description ?? null,
                    billable: dto.billable ?? true,
                },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TIME_ENTRY_CREATED,
                    resource: 'time_entry',
                    resourceId: e.id,
                    details: { taskId, projectId } as any,
                },
            });
            return e;
        });

        return entry;
    }

    /** Owner of entry, or workspace manager, may modify. */
    private async assertCanModifyEntry(entryId: string, workspaceId: string, userId: string) {
        const entry = await this.repo.findTimeEntryById(entryId);
        if (!entry || entry.workspaceId !== workspaceId) throw new NotFoundError('Time entry');
        if (entry.userId === userId) return entry;
        if (await this.can(workspaceId, userId, WorkspacePermission.EDIT_OTHERS_TIME)) return entry;
        throw new AuthorizationError('You can only modify your own time entries');
    }

    async updateTimeEntry(entryId: string, workspaceId: string, userId: string, dto: UpdateTimeEntryDto) {
        const entry = await this.assertCanModifyEntry(entryId, workspaceId, userId);

        if ((entry as any).isLocked && entry.userId === userId
            && !(await this.can(workspaceId, userId, WorkspacePermission.EDIT_OTHERS_TIME))) {
            throw new AppError('This time entry is locked. Ask a workspace admin to unlock it.', 400, 'TIME_ENTRY_LOCKED');
        }

        const startTime = dto.startTime ? new Date(dto.startTime) : entry.startTime;
        const endTime   = dto.endTime !== undefined
            ? (dto.endTime ? new Date(dto.endTime) : null)
            : entry.endTime;

        if (endTime && endTime <= startTime) {
            throw new AppError('endTime must be after startTime', 400, 'INVALID_TIME_RANGE');
        }

        let taskId = dto.taskId !== undefined ? dto.taskId : entry.taskId;
        let projectId = dto.projectId !== undefined ? dto.projectId : entry.projectId;
        if (dto.taskId !== undefined && dto.projectId === undefined) {
            projectId = null;
        }

        const resolved = await this.resolveTimeTarget(
            workspaceId,
            entry.userId,
            taskId,
            projectId,
            'Cannot link time to an archived project',
        );
        taskId = resolved.taskId;
        projectId = resolved.projectId;

        if (!taskId && !projectId) {
            throw new AppError('Either taskId or projectId is required', 400, 'INVALID_TIME_TARGET');
        }
        if (entry.source === TimeEntrySource.MANUAL && !endTime) {
            throw new AppError('Manual time entries require an endTime', 400, 'INVALID_TIME_RANGE');
        }

        if (endTime) {
            const overlap = await this.repo.findOverlappingEntry(
                entry.userId,
                workspaceId,
                startTime,
                endTime,
                entryId,
            );
            if (overlap) throw new ConflictError('Updated time range overlaps with an existing entry');
        }

        const durationMinutes = endTime ? computeMinutes(startTime, endTime) : null;

        const updated = await this.prisma.timeEntry.update({
            where: { id: entryId },
            data: {
                description: dto.description,
                startTime,
                endTime,
                durationMinutes,
                ...(dto.taskId !== undefined && { taskId }),
                ...(dto.projectId !== undefined && { projectId }),
                ...(dto.billable !== undefined && { billable: dto.billable }),
            },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.TIME_ENTRY_UPDATED, resource: 'time_entry', resourceId: entryId },
        });

        return updated;
    }

    async setTimeEntryLock(
        entryId: string,
        workspaceId: string,
        userId: string,
        dto: LockTimeEntryDto,
    ) {
        await this.assertCan(
            workspaceId, userId, WorkspacePermission.EDIT_OTHERS_TIME,
            'You cannot lock or unlock time entries in this workspace',
        );
        const entry = await this.repo.findTimeEntryById(entryId);
        if (!entry || entry.workspaceId !== workspaceId) throw new NotFoundError('Time entry');

        const updated = await this.prisma.timeEntry.update({
            where: { id: entryId },
            data: { isLocked: dto.isLocked },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: dto.isLocked ? AuditAction.TIME_ENTRY_LOCKED : AuditAction.TIME_ENTRY_UNLOCKED,
                resource: 'time_entry',
                resourceId: entryId,
            },
        });

        return updated;
    }

    /**
     * Aggregate hours for reports (group by project | user | day | task).
     */
    async getTimeSummary(workspaceId: string, userId: string, query: TimeSummaryQueryDto) {
        const canSeeEveryone = await this.isWorkspaceManager(workspaceId, userId);
        const scopedUserId = canSeeEveryone ? (query.userId ?? null) : userId;

        // Group on business_date, NOT a UTC slice of startTime. Under Kampala a
        // 22:30 UTC entry is 01:30 the next LOCAL day, and slicing the ISO
        // string filed it under the wrong one — the same class of bug the
        // business_date column was added to end.
        const groupExpr = {
            user: Prisma.sql`te.user_id::text`,
            task: Prisma.sql`te.task_id::text`,
            day: Prisma.sql`te.business_date::text`,
            project: Prisma.sql`te.project_id::text`,
        // Whitelisted rather than interpolated: groupBy arrives from the query
        // string and must never reach SQL as text.
        }[query.groupBy ?? 'project'] ?? Prisma.sql`te.project_id::text`;

        const filters = [
            Prisma.sql`te.workspace_id = ${workspaceId}::uuid`,
            Prisma.sql`te.end_time IS NOT NULL`,
            Prisma.sql`te.duration_minutes IS NOT NULL`,
        ];
        if (scopedUserId) filters.push(Prisma.sql`te.user_id = ${scopedUserId}::uuid`);
        if (query.projectId) filters.push(Prisma.sql`te.project_id = ${query.projectId}::uuid`);
        if (query.billableOnly) filters.push(Prisma.sql`te.billable = true`);
        if (query.dateFrom) {
            filters.push(Prisma.sql`te.business_date >= ${query.dateFrom.slice(0, 10)}::date`);
        }
        if (query.dateTo) {
            filters.push(Prisma.sql`te.business_date <= ${query.dateTo.slice(0, 10)}::date`);
        }

        // GROUPING SETS returns the buckets and the grand total in one trip,
        // so the totals cannot disagree with the rows beneath them.
        const rows = await this.prisma.$queryRaw<Array<{
            group_key: string | null;
            minutes: bigint | null;
            billable_minutes: bigint | null;
            entry_count: bigint;
            is_total: number;
        }>>`
            SELECT ${groupExpr}                                              AS group_key,
                   SUM(te.duration_minutes)                                  AS minutes,
                   SUM(te.duration_minutes) FILTER (WHERE te.billable)       AS billable_minutes,
                   COUNT(*)                                                  AS entry_count,
                   GROUPING(${groupExpr})                                    AS is_total
            FROM time_entries te
            WHERE ${Prisma.join(filters, ' AND ')}
            GROUP BY GROUPING SETS ((${groupExpr}), ())
            ORDER BY is_total, minutes DESC NULLS LAST
            LIMIT 500
        `;

        const total = rows.find((row) => Number(row.is_total) === 1);
        const buckets = rows.filter((row) => Number(row.is_total) === 0);

        // Labels in a second pass, keyed by the ids the query returned — the
        // alternative is joining three tables into every grouping.
        const labels = await this.resolveSummaryLabels(
            query.groupBy ?? 'project',
            buckets.map((row) => row.group_key),
        );

        const num = (value: bigint | null) => Number(value ?? 0);
        const totalMinutes = num(total?.minutes ?? null);
        const billableMinutes = num(total?.billable_minutes ?? null);

        return {
            groupBy: query.groupBy,
            totalMinutes,
            billableMinutes,
            nonBillableMinutes: totalMinutes - billableMinutes,
            // Overtime is deliberately absent. It is a property of the working
            // DAY, not of an individual time entry — it lives on WorkSession
            // and AttendanceDay, measured against the shift's scheduled end.
            // Duplicating a flag onto entries would create a second source of
            // truth for the same number.
            entryCount: Number(total?.entry_count ?? 0),
            groups: buckets.map((row) => ({
                key: row.group_key ?? 'none',
                label: labels.get(row.group_key ?? '') ?? 'Unassigned',
                minutes: num(row.minutes),
                billableMinutes: num(row.billable_minutes),
                count: Number(row.entry_count),
            })),
        };
    }

    /** Turn the grouped ids into names the user recognises. */
    private async resolveSummaryLabels(
        groupBy: 'user' | 'task' | 'day' | 'project',
        keys: Array<string | null>,
    ): Promise<Map<string, string>> {
        const ids = keys.filter((key): key is string => Boolean(key));
        if (groupBy === 'day') return new Map(ids.map((key) => [key, key]));
        if (ids.length === 0) return new Map();

        if (groupBy === 'user') {
            const users = await this.prisma.user.findMany({
                where: { id: { in: ids } },
                select: { id: true, firstName: true, lastName: true },
            });
            return new Map(users.map((user) => [
                user.id,
                `${user.firstName} ${user.lastName}`.trim(),
            ]));
        }
        if (groupBy === 'task') {
            const tasks = await this.prisma.task.findMany({
                where: { id: { in: ids } },
                select: { id: true, title: true },
            });
            return new Map(tasks.map((task) => [task.id, task.title]));
        }
        const projects = await this.prisma.project.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
        });
        return new Map(projects.map((project) => [project.id, project.name]));
    }

    async deleteTimeEntry(entryId: string, workspaceId: string, userId: string) {
        const entry = await this.assertCanModifyEntry(entryId, workspaceId, userId);
        if ((entry as any).isLocked && entry.userId === userId
            && !(await this.can(workspaceId, userId, WorkspacePermission.EDIT_OTHERS_TIME))) {
            throw new AppError('This time entry is locked', 400, 'TIME_ENTRY_LOCKED');
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.timeEntry.delete({ where: { id: entryId } });
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.TIME_ENTRY_DELETED, resource: 'time_entry', resourceId: entryId },
            });
        });
    }

    // ─── Attendance Settings ─────────────────────────────────
    async getAttendanceSettings(workspaceId: string, userId: string) {
        await this.assertWorkspaceMember(workspaceId, userId);
        return this.getWorkspaceAttendancePolicy(workspaceId);
    }

    async updateAttendanceSettings(workspaceId: string, userId: string, dto: AttendanceSettingsDto) {
        await this.assertCan(
            workspaceId, userId, WorkspacePermission.MANAGE_ATTENDANCE,
            'You cannot change attendance settings in this workspace',
        );

        const cleared =
            dto.attendanceLatitude === null &&
            dto.attendanceLongitude === null &&
            dto.attendanceRadiusMeters === null;

        // Build time-window patch (always partial — admin can update independently of location)
        const timeWindowPatch = {
            ...(dto.attendanceClockInStart !== undefined && { attendanceClockInStart: dto.attendanceClockInStart }),
            ...(dto.attendanceClockInEnd !== undefined && { attendanceClockInEnd: dto.attendanceClockInEnd }),
            ...(dto.attendanceClockOutStart !== undefined && { attendanceClockOutStart: dto.attendanceClockOutStart }),
            ...(dto.enforceClockWindows !== undefined && { enforceClockWindows: dto.enforceClockWindows }),
            ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        };

        const updated = await this.prisma.workspace.update({
            where: { id: workspaceId },
            data: cleared
                ? {
                    attendanceLocationName: dto.attendanceLocationName ?? null,
                    attendanceLatitude: null,
                    attendanceLongitude: null,
                    attendanceRadiusMeters: null,
                    ...timeWindowPatch,
                }
                : {
                    ...(dto.attendanceLocationName !== undefined && {
                        attendanceLocationName: dto.attendanceLocationName,
                    }),
                    ...(dto.attendanceLatitude !== undefined && {
                        attendanceLatitude: dto.attendanceLatitude,
                    }),
                    ...(dto.attendanceLongitude !== undefined && {
                        attendanceLongitude: dto.attendanceLongitude,
                    }),
                    ...(dto.attendanceRadiusMeters !== undefined && {
                        attendanceRadiusMeters: dto.attendanceRadiusMeters,
                    }),
                    ...timeWindowPatch,
                },
            select: {
                id: true,
                attendanceLocationName: true,
                attendanceLatitude: true,
                attendanceLongitude: true,
                attendanceRadiusMeters: true,
                attendanceClockInStart: true,
                attendanceClockInEnd: true,
                attendanceClockOutStart: true,
                enforceClockWindows: true,
                timezone: true,
            },
        });

        // The clock is cached for a minute; a timezone change must take effect now.
        invalidateClock(workspaceId);

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.WORKSPACE_ATTENDANCE_SETTINGS_UPDATED,
                resource: 'workspace',
                resourceId: workspaceId,
                details: updated as any,
            },
        });

        return updated;
    }


    // ─── Timer ────────────────────────────────────────────────
    async startTimer(workspaceId: string, userId: string, dto: StartTimerDto) {
        await this.assertWorkspaceMember(workspaceId, userId);

        const { taskId, projectId } = await this.resolveTimeTarget(
            workspaceId,
            userId,
            dto.taskId,
            dto.projectId,
            'Cannot track time on an archived project',
        );

        const clock = await clockFor(this.prisma, workspaceId);
        const startedAt = new Date();

        // The re-check is for the error message; time_entries_one_open_timer is
        // what actually serializes two concurrent starts.
        try {
            const entry = await this.prisma.$transaction(async (tx) => {
                const active = await tx.timeEntry.findFirst({
                    where: { userId, workspaceId, endTime: null, source: TimeEntrySource.TIMER },
                });
                if (active) {
                    throw new ConflictError(
                        'You already have an active timer running. Stop it before starting a new one.',
                    );
                }

                const created = await tx.timeEntry.create({
                    data: {
                        userId,
                        createdById: userId,
                        workspaceId,
                        taskId,
                        projectId,
                        startTime: startedAt,
                        businessDate: clock.businessDateColumn(startedAt),
                        source: TimeEntrySource.TIMER,
                        description: dto.description ?? null,
                    },
                });
                await tx.auditLog.create({
                    data: {
                        userId,
                        workspaceId,
                        action: AuditAction.TIME_ENTRY_CREATED,
                        resource: 'time_entry',
                        resourceId: created.id,
                        details: { taskId, projectId, source: TimeEntrySource.TIMER, timerAction: 'start' } as any,
                    },
                });
                return created;
            });
            return entry;
        } catch (err: any) {
            if (err?.code === 'P2002' || err?.code === '23505') {
                throw new ConflictError(
                    'You already have an active timer running. Stop it before starting a new one.',
                );
            }
            throw err;
        }
    }

    async stopTimer(workspaceId: string, userId: string) {
        await this.assertWorkspaceMember(workspaceId, userId);

        const active = await this.repo.findActiveTimer(userId, workspaceId);
        if (!active) throw new NotFoundError('Active timer');

        const endTime = new Date();
        const durationMinutes = computeMinutes(active.startTime, endTime);

        const overlap = await this.repo.findOverlappingEntry(
            userId,
            workspaceId,
            active.startTime,
            endTime,
            active.id,
        );
        if (overlap) {
            throw new ConflictError('This timer overlaps with an existing time entry. Edit the overlapping entry first.');
        }

        const updated = await this.prisma.$transaction(async (tx) => {
            const stopped = await tx.timeEntry.update({
                where: { id: active.id },
                data: { endTime, durationMinutes },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TIME_ENTRY_UPDATED,
                    resource: 'time_entry',
                    resourceId: active.id,
                    details: { timerAction: 'stop', durationMinutes } as any,
                },
            });
            return stopped;
        });

        return updated;
    }

    async getActiveTimer(workspaceId: string, userId: string) {
        return this.repo.findActiveTimer(userId, workspaceId);
    }

    // ─── Work Sessions ────────────────────────────────────────
    async getWorkSessions(workspaceId: string, userId: string, query: WorkSessionQueryDto) {
        const isWorkspaceManager = await this.isWorkspaceManager(workspaceId, userId);
        const { sessions, total, page, limit } = await this.repo.findWorkSessions(
            workspaceId,
            query,
            { userId, isWorkspaceManager },
        );
        const totalPages = Math.ceil(total / limit);
        return {
            data: sessions,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1,
            },
        };
    }

    async getActiveSession(workspaceId: string, userId: string) {
        return this.repo.findActiveSession(userId, workspaceId);
    }

    async clockIn(workspaceId: string, userId: string, dto: ClockInDto) {
        await this.assertWorkspaceMember(workspaceId, userId);
        const policy = await this.getWorkspaceAttendancePolicy(workspaceId);
        const clock = await clockFor(this.prisma, workspaceId);
        const at = new Date();

        const businessDate = clock.businessDate(at);
        const schedule = await resolveSchedule(this.prisma, workspaceId, userId, businessDate, clock);

        this.assertClockInWindow(policy, clock, at, schedule);
        const minutesLate = this.lateMinutes(at, schedule);

        // Sites first: a task site is a legitimate place to start, and the
        // legacy single-geofence columns are only consulted when no site has
        // been configured yet.
        const { sites, enforcement } = await this.candidateSites(workspaceId, userId, dto.taskId);
        let verdict = evaluateGeofence(
            sites,
            dto.latitude != null && dto.longitude != null
                ? { latitude: dto.latitude, longitude: dto.longitude }
                : null,
            enforcement as GeofenceEnforcement,
        );
        if (sites.length === 0) {
            const legacy = this.evaluateAttendanceLocation(policy, dto, true);
            verdict = { ...verdict, withinFence: legacy.withinFence ?? true };
        } else if (!verdict.ok) {
            throw new AppError(
                'You are not close enough to an approved location to clock in',
                400,
                'OUTSIDE_ATTENDANCE_LOCATION',
            );
        }
        const withinFence = verdict.withinFence;
        const matchedSite = sites.find((site) => site.id === verdict.siteId);

        const settings = await this.prisma.attendanceSettings.findUnique({
            where: { workspaceId },
            select: { flagsEnabled: true },
        });
        const flagsEnabled = settings?.flagsEnabled !== false;

        // Cheap pre-check purely for the error message: it can name the other
        // workspace, which the unique-index path below cannot. Correctness does
        // not depend on it — see the P2002 handler.
        const existing = await this.prisma.workSession.findFirst({
            where: { userId, clockOut: null },
            include: { workspace: { select: { id: true, name: true } } },
        });
        if (existing) throw this.alreadyClockedIn(existing, workspaceId);

        try {
            return await this.prisma.$transaction(async (tx) => {
                const session = await tx.workSession.create({
                    data: {
                        userId,
                        workspaceId,
                        clockIn: at,
                        businessDate: toDateColumn(businessDate),
                        status: WorkSessionStatus.OPEN,
                        // Everyone starts available; changing it is deliberate.
                        presenceStatus: PresenceStatus.AVAILABLE,
                        presenceChangedAt: at,
                        description: dto.description ?? null,
                        clockInLatitude: dto.latitude ?? null,
                        clockInLongitude: dto.longitude ?? null,
                        clockInLocationLabel: dto.locationLabel ?? matchedSite?.name ?? null,
                        clockInWithinGeofence: withinFence,
                        clockInSiteId: verdict.siteId,
                        clockInTaskId: matchedSite?.taskId ?? null,
                        clockInDistanceMeters: verdict.distanceMeters,
                        // Snapshot of the hours as they stood today. Editing the
                        // schedule later must not make this session late.
                        scheduleId: schedule.scheduleId,
                        scheduledStartUtc: schedule.startUtc,
                        scheduledEndUtc: schedule.endUtc,
                        scheduledMinutes: schedule.expectedMinutes,
                        graceMinutesApplied: schedule.graceMinutes,
                    },
                });
                await this.presenceService.openInitialInterval(tx, session);

                // Raised here, not left to the nightly rollup, so the badge is
                // visible the moment it is earned. Idempotent by partial unique
                // index, so the rollup re-raising it later is a no-op — and a
                // waived flag is never resurrected.
                if (minutesLate > 0 && flagsEnabled) {
                    await tx.attendanceFlag.createMany({
                        data: [{
                            workspaceId,
                            userId,
                            businessDate: toDateColumn(businessDate),
                            type: AttendanceFlagType.LATE_IN,
                            minutes: minutesLate,
                        }],
                        skipDuplicates: true,
                    });
                }
                await tx.auditLog.create({
                    data: {
                        userId,
                        workspaceId,
                        action: AuditAction.WORK_SESSION_CLOCKED_IN,
                        resource: 'work_session',
                        resourceId: session.id,
                        details: {
                            businessDate: clock.businessDate(at),
                            timezone: clock.timezone,
                            minutesLate,
                            clockInLatitude: dto.latitude ?? null,
                            clockInLongitude: dto.longitude ?? null,
                            locationLabel: dto.locationLabel ?? null,
                            withinGeofence: withinFence,
                        } as any,
                    },
                });
                return session;
            });
        } catch (error: any) {
            // work_sessions_one_open_per_user. This is the real guard — the
            // pre-check above is two statements under READ COMMITTED and does
            // not serialize two concurrent requests. Before migration 0008 the
            // index did not exist, so this branch was unreachable.
            if (error?.code === 'P2002') {
                const open = await this.prisma.workSession.findFirst({
                    where: { userId, clockOut: null },
                    include: { workspace: { select: { id: true, name: true } } },
                });
                throw open
                    ? this.alreadyClockedIn(open, workspaceId)
                    : new ConflictError('You are already clocked in.');
            }
            throw error;
        }
    }

    private alreadyClockedIn(
        open: { workspaceId: string; workspace: { name: string } },
        attemptedWorkspaceId: string,
    ): ConflictError {
        return new ConflictError(
            open.workspaceId !== attemptedWorkspaceId
                ? `You are already clocked in to ${open.workspace.name}. Clock out there first, or close that session from your profile.`
                : 'You are already clocked in. Clock out before clocking in again.',
        );
    }

    /**
     * End the caller's open session in this workspace.
     *
     * Nothing here may reject: no time window, no geofence, no workspace
     * setting. An open session that cannot be closed is not merely a local
     * annoyance — the one-open-session rule is global, so it locks the person
     * out of every other organisation too.
     */
    async clockOut(workspaceId: string, userId: string, dto: ClockOutDto) {
        await this.assertWorkspaceMember(workspaceId, userId);
        const policy = await this.getWorkspaceAttendancePolicy(workspaceId);
        const clock = await clockFor(this.prisma, workspaceId);

        const session = await this.repo.findActiveSession(userId, workspaceId);
        if (!session) throw new NotFoundError('Active work session');

        const { withinFence } = this.evaluateAttendanceLocation(policy, dto, false);
        const clockOut = new Date();
        const totalMinutes = computeMinutes(session.clockIn, clockOut);
        const businessDate = clock.localDate(session.businessDate);
        const schedule = await resolveSchedule(
            this.prisma, workspaceId, userId, businessDate, clock,
        );
        const { minutesEarly } = this.evaluateEarlyClockOut(
            policy, clock, clockOut, session.businessDate, schedule,
        );

        // Overtime is two numbers, not one. `raw` is always measured — a person
        // who stayed late and a company with no record of it is an argument
        // nobody can settle — while `counted` is what totals and pay use, and
        // is zero unless the workspace tracks overtime.
        const scheduledEnd = session.scheduledEndUtc ?? schedule.endUtc;
        const rawOvertimeMinutes = scheduledEnd && clockOut > scheduledEnd
            ? WorkspaceClock.minutesBetween(scheduledEnd, clockOut)
            : 0;
        const settings = await this.prisma.attendanceSettings.findUnique({
            where: { workspaceId },
            select: { overtimeTrackingEnabled: true, flagsEnabled: true },
        });
        const countedOvertimeMinutes = settings?.overtimeTrackingEnabled ? rawOvertimeMinutes : 0;
        const flagsEnabled = settings?.flagsEnabled !== false;

        return this.prisma.$transaction(async (tx) => {
            const { breakMinutes } = await this.presenceService.closeIntervals(
                tx, session.id, clockOut, schedule.breakPaid,
            );

            // Conditional on still being open, so a concurrent auto-close or
            // admin force-close cannot be overwritten.
            const claimed = await tx.workSession.updateMany({
                where: { id: session.id, clockOut: null },
                data: {
                    clockOut,
                    totalMinutes,
                    breakMinutes,
                    workedMinutes: Math.max(0, totalMinutes - breakMinutes),
                    rawOvertimeMinutes,
                    countedOvertimeMinutes,
                    status: WorkSessionStatus.CLOSED,
                    // Cleared because the CHECK requires it: presence cannot
                    // outlive the session it belongs to.
                    presenceStatus: null,
                    description: dto.description ?? session.description,
                    clockOutLatitude: dto.latitude ?? null,
                    clockOutLongitude: dto.longitude ?? null,
                    clockOutLocationLabel: dto.locationLabel ?? null,
                    clockOutWithinGeofence: withinFence,
                    earlyOutReason: minutesEarly > 0 ? (dto.earlyOutReason ?? null) : null,
                },
            });
            if (claimed.count === 0) {
                throw new ConflictError(
                    'That session was already closed. Refresh to see how it was recorded.',
                );
            }

            // Session-scoped, so two shifts in one day can each be flagged —
            // that is why the index is on (session_id, type) rather than on the
            // business date.
            if (flagsEnabled) {
                const flags: Array<{ type: AttendanceFlagType; minutes: number | null }> = [];
                if (minutesEarly > 0) {
                    flags.push({ type: AttendanceFlagType.EARLY_OUT, minutes: minutesEarly });
                }
                if (withinFence === false) {
                    flags.push({ type: AttendanceFlagType.OUT_OF_GEOFENCE, minutes: null });
                }
                if (flags.length > 0) {
                    await tx.attendanceFlag.createMany({
                        data: flags.map((flag) => ({
                            workspaceId,
                            userId,
                            businessDate: session.businessDate,
                            sessionId: session.id,
                            type: flag.type,
                            minutes: flag.minutes,
                        })),
                        skipDuplicates: true,
                    });
                }
            }

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.WORK_SESSION_CLOCKED_OUT,
                    resource: 'work_session',
                    resourceId: session.id,
                    details: {
                        totalMinutes,
                        minutesEarly,
                        clockOutLatitude: dto.latitude ?? null,
                        clockOutLongitude: dto.longitude ?? null,
                        locationLabel: dto.locationLabel ?? null,
                        withinGeofence: withinFence,
                    } as any,
                },
            });

            return tx.workSession.findUniqueOrThrow({ where: { id: session.id } });
        });
    }

    /**
     * Close whatever session the caller has open, wherever it is.
     *
     * The escape hatch for the cross-organisation lockout. Deliberately scoped
     * to the caller rather than exposed as a `force` flag on another
     * workspace's clock-in: a request authenticated against workspace A has no
     * business writing minutes into workspace B's attendance record, but the
     * person themselves always may.
     */
    async closeMyOpenSession(userId: string) {
        const open = await this.prisma.workSession.findFirst({
            where: { userId, clockOut: null },
            include: { workspace: { select: { id: true, name: true } } },
        });
        if (!open) throw new NotFoundError('Open work session');

        const clockOut = new Date();
        const totalMinutes = computeMinutes(open.clockIn, clockOut);

        return this.prisma.$transaction(async (tx) => {
            // Break minutes are not netted off here: this path exists to
            // unstick somebody, and the schedule that applied may belong to a
            // workspace they can no longer read. The rollup recomputes it.
            await this.presenceService.closeIntervals(tx, open.id, clockOut, true);
            const claimed = await tx.workSession.updateMany({
                where: { id: open.id, clockOut: null },
                data: {
                    clockOut,
                    totalMinutes,
                    workedMinutes: totalMinutes,
                    status: WorkSessionStatus.CLOSED,
                    // Required by work_sessions_presence_matches_state.
                    presenceStatus: null,
                    closedById: userId,
                    closureReason: 'USER_SWITCH',
                },
            });
            if (claimed.count === 0) {
                throw new ConflictError('That session was already closed.');
            }
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId: open.workspaceId,
                    action: AuditAction.WORK_SESSION_CLOCKED_OUT,
                    resource: 'work_session',
                    resourceId: open.id,
                    details: { totalMinutes, closureReason: 'USER_SWITCH' } as any,
                },
            });
            return tx.workSession.findUniqueOrThrow({ where: { id: open.id } });
        });
    }

    async createWorkSession(workspaceId: string, userId: string, dto: CreateWorkSessionDto) {
        // Writing attendance under someone else's name.
        await this.assertCan(
            workspaceId, userId, WorkspacePermission.LOG_TIME_ON_BEHALF,
            'You cannot record attendance for other people in this workspace',
        );
        await this.assertUserInWorkspace(workspaceId, dto.userId);

        const clockIn = new Date(dto.clockIn);
        const clockOut = new Date(dto.clockOut);
        if (clockOut <= clockIn) {
            throw new AppError('clockOut must be after clockIn', 400, 'INVALID_WORK_SESSION_RANGE');
        }
        await this.assertNoOverlappingWorkSession(dto.userId, clockIn, clockOut);

        const totalMinutes = computeMinutes(clockIn, clockOut);
        const clock = await clockFor(this.prisma, workspaceId);
        const created = await this.prisma.$transaction(async (tx) => {
            const session = await tx.workSession.create({
                data: {
                    userId: dto.userId,
                    workspaceId,
                    clockIn,
                    clockOut,
                    businessDate: clock.businessDateColumn(clockIn),
                    // A manually entered session is complete by definition; the
                    // CHECK constraint requires status to match clockOut.
                    status: WorkSessionStatus.ADMIN_CLOSED,
                    totalMinutes,
                    description: dto.description ?? null,
                    clockInLatitude: dto.clockInLatitude ?? null,
                    clockInLongitude: dto.clockInLongitude ?? null,
                    clockInLocationLabel: dto.clockInLocationLabel ?? null,
                    clockOutLatitude: dto.clockOutLatitude ?? null,
                    clockOutLongitude: dto.clockOutLongitude ?? null,
                    clockOutLocationLabel: dto.clockOutLocationLabel ?? null,
                    adjustedById: userId,
                    adjustedAt: new Date(),
                    adjustmentReason: dto.adjustmentReason,
                },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.WORK_SESSION_CREATED,
                    resource: 'work_session',
                    resourceId: session.id,
                    details: {
                        targetUserId: dto.userId,
                        totalMinutes,
                        adjustmentReason: dto.adjustmentReason,
                    } as any,
                },
            });
            return session;
        });

        return created;
    }

    async updateWorkSession(
        sessionId: string,
        workspaceId: string,
        userId: string,
        dto: UpdateWorkSessionDto,
    ) {
        await this.assertCan(
            workspaceId, userId, WorkspacePermission.EDIT_OTHERS_TIME,
            'You cannot adjust attendance for other people in this workspace',
        );
        const existing = await this.prisma.workSession.findUnique({ where: { id: sessionId } });
        if (!existing || existing.workspaceId !== workspaceId) throw new NotFoundError('Work session');

        const targetUserId = dto.userId ?? existing.userId;
        await this.assertUserInWorkspace(workspaceId, targetUserId);

        const clockIn = dto.clockIn ? new Date(dto.clockIn) : existing.clockIn;
        const clockOut = dto.clockOut ? new Date(dto.clockOut) : existing.clockOut;
        if (!clockOut) {
            throw new AppError('Adjusted work sessions must include clockOut', 400, 'INVALID_WORK_SESSION_RANGE');
        }
        if (clockOut <= clockIn) {
            throw new AppError('clockOut must be after clockIn', 400, 'INVALID_WORK_SESSION_RANGE');
        }
        await this.assertNoOverlappingWorkSession(targetUserId, clockIn, clockOut, sessionId);

        const totalMinutes = computeMinutes(clockIn, clockOut);
        const clock = await clockFor(this.prisma, workspaceId);
        const updated = await this.prisma.$transaction(async (tx) => {
            const session = await tx.workSession.update({
                where: { id: sessionId },
                data: {
                    userId: targetUserId,
                    clockIn,
                    clockOut,
                    // Moving clockIn can move the day the minutes belong to.
                    businessDate: clock.businessDateColumn(clockIn),
                    // An adjustment always supplies a clockOut, so a session
                    // that was open is now closed — and the CHECK constraint
                    // requires status to say so. An already-closed session keeps
                    // its own provenance; the adjustment is recorded separately
                    // in adjustedById/adjustmentReason.
                    status: existing.status === WorkSessionStatus.OPEN
                        ? WorkSessionStatus.ADMIN_CLOSED
                        : existing.status,
                    // An adjustment always supplies a clockOut, so presence must
                    // go with it — see work_sessions_presence_matches_state.
                    presenceStatus: null,
                    totalMinutes,
                    workedMinutes: totalMinutes,
                    description: dto.description !== undefined ? dto.description : existing.description,
                    clockInLatitude: dto.clockInLatitude !== undefined ? dto.clockInLatitude : existing.clockInLatitude,
                    clockInLongitude: dto.clockInLongitude !== undefined ? dto.clockInLongitude : existing.clockInLongitude,
                    clockInLocationLabel: dto.clockInLocationLabel !== undefined ? dto.clockInLocationLabel : existing.clockInLocationLabel,
                    clockOutLatitude: dto.clockOutLatitude !== undefined ? dto.clockOutLatitude : existing.clockOutLatitude,
                    clockOutLongitude: dto.clockOutLongitude !== undefined ? dto.clockOutLongitude : existing.clockOutLongitude,
                    clockOutLocationLabel: dto.clockOutLocationLabel !== undefined ? dto.clockOutLocationLabel : existing.clockOutLocationLabel,
                    adjustedById: userId,
                    adjustedAt: new Date(),
                    adjustmentReason: dto.adjustmentReason,
                },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.WORK_SESSION_UPDATED,
                    resource: 'work_session',
                    resourceId: sessionId,
                    details: {
                        targetUserId,
                        totalMinutes,
                        adjustmentReason: dto.adjustmentReason,
                    } as any,
                },
            });
            return session;
        });

        return updated;
    }
}
