import { injectable, inject } from 'tsyringe';
import { PrismaClient, TimeEntrySource } from '@prisma/client';
import { TimeTrackingRepository } from './time-tracking.repository';
import { NotFoundError, AuthorizationError, AppError, ConflictError } from '../../core/errors/AppError';
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
} from './time-tracking.dto';

/** Compute duration in whole minutes (server-side only — never from client). */
function computeMinutes(start: Date, end: Date): number {
    return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
}

@injectable()
export class TimeTrackingService {
    constructor(
        private repo: TimeTrackingRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
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

    private async isWorkspaceManager(workspaceId: string, userId: string): Promise<boolean> {
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws) return false;
        if (ws.ownerId === userId) return true;
        const m = await this.prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId } },
        });
        return m?.role === WorkspaceRole.ADMIN;
    }

    private async assertProjectMemberOrManager(projectId: string, workspaceId: string, userId: string) {
        if (await this.isWorkspaceManager(workspaceId, userId)) return;
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
            if (!task.projectId && !(await this.isWorkspaceManager(workspaceId, userId))) {
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

        const entry = await this.prisma.$transaction(async (tx) => {
            const e = await tx.timeEntry.create({
                data: {
                    userId,
                    workspaceId,
                    taskId,
                    projectId,
                    startTime,
                    endTime,
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
        if (await this.isWorkspaceManager(workspaceId, userId)) return entry;
        throw new AuthorizationError('You can only modify your own time entries');
    }

    async updateTimeEntry(entryId: string, workspaceId: string, userId: string, dto: UpdateTimeEntryDto) {
        const entry = await this.assertCanModifyEntry(entryId, workspaceId, userId);

        if ((entry as any).isLocked && entry.userId === userId && !(await this.isWorkspaceManager(workspaceId, userId))) {
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
        if (!(await this.isWorkspaceManager(workspaceId, userId))) {
            throw new AuthorizationError('Only workspace admins can lock or unlock time entries');
        }
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
        const isWorkspaceManager = await this.isWorkspaceManager(workspaceId, userId);
        const where: any = {
            workspaceId,
            endTime: { not: null },
            durationMinutes: { not: null },
        };
        if (isWorkspaceManager) {
            if (query.userId) where.userId = query.userId;
        } else {
            where.userId = userId;
        }
        if (query.projectId) where.projectId = query.projectId;
        if (query.billableOnly) where.billable = true;
        if (query.dateFrom || query.dateTo) {
            where.startTime = {};
            if (query.dateFrom) where.startTime.gte = new Date(query.dateFrom);
            if (query.dateTo) where.startTime.lte = new Date(query.dateTo);
        }

        const entries = await this.prisma.timeEntry.findMany({
            where,
            select: {
                durationMinutes: true,
                billable: true,
                startTime: true,
                userId: true,
                projectId: true,
                taskId: true,
                user: { select: { id: true, firstName: true, lastName: true } },
                project: { select: { id: true, name: true } },
                task: { select: { id: true, title: true } },
            },
        });

        let totalMinutes = 0;
        let billableMinutes = 0;
        const buckets = new Map<string, {
            key: string;
            label: string;
            minutes: number;
            billableMinutes: number;
            count: number;
        }>();

        for (const e of entries) {
            const mins = e.durationMinutes || 0;
            totalMinutes += mins;
            if (e.billable) billableMinutes += mins;

            let key = 'unassigned';
            let label = 'Unassigned';
            switch (query.groupBy) {
                case 'user':
                    key = e.userId;
                    label = [e.user?.firstName, e.user?.lastName].filter(Boolean).join(' ') || e.userId;
                    break;
                case 'task':
                    key = e.taskId || 'none';
                    label = e.task?.title || 'No task';
                    break;
                case 'day':
                    key = e.startTime.toISOString().slice(0, 10);
                    label = key;
                    break;
                case 'project':
                default:
                    key = e.projectId || 'none';
                    label = e.project?.name || 'No project';
                    break;
            }

            if (!buckets.has(key)) {
                buckets.set(key, { key, label, minutes: 0, billableMinutes: 0, count: 0 });
            }
            const b = buckets.get(key)!;
            b.minutes += mins;
            if (e.billable) b.billableMinutes += mins;
            b.count += 1;
        }

        return {
            groupBy: query.groupBy,
            totalMinutes,
            billableMinutes,
            nonBillableMinutes: totalMinutes - billableMinutes,
            entryCount: entries.length,
            groups: Array.from(buckets.values()).sort((a, b) => b.minutes - a.minutes),
        };
    }

    async deleteTimeEntry(entryId: string, workspaceId: string, userId: string) {
        const entry = await this.assertCanModifyEntry(entryId, workspaceId, userId);
        if ((entry as any).isLocked && entry.userId === userId && !(await this.isWorkspaceManager(workspaceId, userId))) {
            throw new AppError('This time entry is locked', 400, 'TIME_ENTRY_LOCKED');
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.timeEntry.delete({ where: { id: entryId } });
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.TIME_ENTRY_DELETED, resource: 'time_entry', resourceId: entryId },
            });
        });
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

        // Transaction + re-check to reduce race on concurrent starts
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
                        workspaceId,
                        taskId,
                        projectId,
                        startTime: new Date(),
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

        // Prevent duplicate sessions with a serializable-safe check
        const existing = await this.repo.findActiveSession(userId, workspaceId);
        if (existing) throw new ConflictError('You are already clocked in. Clock out before clocking in again.');

        const session = await this.prisma.$transaction(async (tx) => {
            // Double-check inside the transaction to guard against race conditions
            const check = await tx.workSession.findFirst({
                where: { userId, workspaceId, clockOut: null },
            });
            if (check) throw new ConflictError('You are already clocked in.');

            const s = await tx.workSession.create({
                data: {
                    userId,
                    workspaceId,
                    clockIn: new Date(),
                    description: dto.description ?? null,
                },
            });
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.WORK_SESSION_CLOCKED_IN, resource: 'work_session', resourceId: s.id },
            });
            return s;
        });

        return session;
    }

    async clockOut(workspaceId: string, userId: string, dto: ClockOutDto) {
        await this.assertWorkspaceMember(workspaceId, userId);

        const session = await this.repo.findActiveSession(userId, workspaceId);
        if (!session) throw new NotFoundError('Active work session');

        const clockOut = new Date();
        const totalMinutes = computeMinutes(session.clockIn, clockOut);

        const updated = await this.prisma.$transaction(async (tx) => {
            const s = await tx.workSession.update({
                where: { id: session.id },
                data: {
                    clockOut,
                    totalMinutes,
                    description: dto.description ?? session.description,
                },
            });
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.WORK_SESSION_CLOCKED_OUT, resource: 'work_session', resourceId: s.id, details: { totalMinutes } as any },
            });
            return s;
        });

        return updated;
    }
}
