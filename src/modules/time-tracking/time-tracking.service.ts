import { injectable, inject } from 'tsyringe';
import { PrismaClient, TimeEntrySource } from '@prisma/client';
import { TimeTrackingRepository } from './time-tracking.repository';
import { NotFoundError, AuthorizationError, AppError, ConflictError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import {
    CreateTimeEntryDto,
    UpdateTimeEntryDto,
    StartTimerDto,
    ClockInDto,
    ClockOutDto,
    TimeEntryQueryDto,
    WorkSessionQueryDto,
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

    private async assertOwnsEntry(entryId: string, workspaceId: string, userId: string) {
        const entry = await this.repo.findTimeEntryById(entryId);
        if (!entry || entry.workspaceId !== workspaceId) throw new NotFoundError('Time entry');
        if (entry.userId !== userId) throw new AuthorizationError('You can only modify your own time entries');
        return entry;
    }

    // ─── Time Entries ─────────────────────────────────────────
    async getTimeEntries(workspaceId: string, query: TimeEntryQueryDto) {
        const { entries, total, page, limit } = await this.repo.findTimeEntries(workspaceId, query);
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

    async getTimeEntry(entryId: string, workspaceId: string) {
        const entry = await this.repo.findTimeEntryById(entryId);
        if (!entry || entry.workspaceId !== workspaceId) throw new NotFoundError('Time entry');
        return entry;
    }

    async createTimeEntry(workspaceId: string, userId: string, dto: CreateTimeEntryDto) {
        await this.assertWorkspaceMember(workspaceId, userId);

        const startTime = new Date(dto.startTime);
        const endTime = dto.endTime ? new Date(dto.endTime) : null;

        if (endTime && endTime <= startTime) {
            throw new AppError('endTime must be after startTime', 400, 'INVALID_TIME_RANGE');
        }

        // Validate referenced task / project belong to workspace
        if (dto.taskId) {
            const task = await this.prisma.task.findUnique({ where: { id: dto.taskId } });
            if (!task || task.workspaceId !== workspaceId) throw new NotFoundError('Task');
        }
        if (dto.projectId) {
            const proj = await this.prisma.project.findUnique({ where: { id: dto.projectId } });
            if (!proj || proj.workspaceId !== workspaceId) throw new NotFoundError('Project');
        }

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
                    taskId: dto.taskId ?? null,
                    projectId: dto.projectId ?? null,
                    startTime,
                    endTime,
                    durationMinutes,
                    source: dto.source ?? TimeEntrySource.MANUAL,
                    description: dto.description ?? null,
                },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TIME_ENTRY_CREATED,
                    resource: 'time_entry',
                    resourceId: e.id,
                    details: { taskId: dto.taskId, projectId: dto.projectId } as any,
                },
            });
            return e;
        });

        return entry;
    }

    async updateTimeEntry(entryId: string, workspaceId: string, userId: string, dto: UpdateTimeEntryDto) {
        const entry = await this.assertOwnsEntry(entryId, workspaceId, userId);

        const startTime = dto.startTime ? new Date(dto.startTime) : entry.startTime;
        const endTime   = dto.endTime !== undefined
            ? (dto.endTime ? new Date(dto.endTime) : null)
            : entry.endTime;

        if (endTime && endTime <= startTime) {
            throw new AppError('endTime must be after startTime', 400, 'INVALID_TIME_RANGE');
        }

        if (endTime) {
            const overlap = await this.repo.findOverlappingEntry(userId, workspaceId, startTime, endTime, entryId);
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
            },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.TIME_ENTRY_UPDATED, resource: 'time_entry', resourceId: entryId },
        });

        return updated;
    }

    async deleteTimeEntry(entryId: string, workspaceId: string, userId: string) {
        await this.assertOwnsEntry(entryId, workspaceId, userId);

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

        // Prevent two concurrent timers per user in the workspace
        const active = await this.repo.findActiveTimer(userId, workspaceId);
        if (active) {
            throw new ConflictError('You already have an active timer running. Stop it before starting a new one.');
        }

        if (dto.taskId) {
            const task = await this.prisma.task.findUnique({ where: { id: dto.taskId } });
            if (!task || task.workspaceId !== workspaceId) throw new NotFoundError('Task');
        }
        if (dto.projectId) {
            const proj = await this.prisma.project.findUnique({ where: { id: dto.projectId } });
            if (!proj || proj.workspaceId !== workspaceId) throw new NotFoundError('Project');
        }

        const entry = await this.prisma.timeEntry.create({
            data: {
                userId,
                workspaceId,
                taskId: dto.taskId ?? null,
                projectId: dto.projectId ?? null,
                startTime: new Date(),
                source: TimeEntrySource.TIMER,
                description: dto.description ?? null,
            },
        });

        return entry;
    }

    async stopTimer(workspaceId: string, userId: string) {
        await this.assertWorkspaceMember(workspaceId, userId);

        const active = await this.repo.findActiveTimer(userId, workspaceId);
        if (!active) throw new NotFoundError('Active timer');

        const endTime = new Date();
        const durationMinutes = computeMinutes(active.startTime, endTime);

        const updated = await this.prisma.timeEntry.update({
            where: { id: active.id },
            data: { endTime, durationMinutes },
        });

        return updated;
    }

    async getActiveTimer(workspaceId: string, userId: string) {
        return this.repo.findActiveTimer(userId, workspaceId);
    }

    // ─── Work Sessions ────────────────────────────────────────
    async getWorkSessions(workspaceId: string, query: WorkSessionQueryDto) {
        const { sessions, total, page, limit } = await this.repo.findWorkSessions(workspaceId, query);
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
