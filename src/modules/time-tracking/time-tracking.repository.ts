import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { TimeEntryQueryDto, WorkSessionQueryDto } from './time-tracking.dto';

@injectable()
export class TimeTrackingRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) {}

    // ─── Time Entries ─────────────────────────────────────────
    async findTimeEntries(
        workspaceId: string,
        opts: TimeEntryQueryDto,
        visibility?: { userId: string; isWorkspaceManager: boolean },
    ) {
        // Safe pagination defaults — prevents NaN/undefined reaching Prisma
        const page      = Math.max(1, Number(opts.page)  || 1);
        const limit     = Math.min(100, Math.max(1, Number(opts.limit) || 20));
        const sortOrder = opts.sortOrder === 'asc' ? 'asc' : ('desc' as const);
        const skip      = (page - 1) * limit;

        const { taskId, projectId, userId, dateFrom, dateTo } = opts;

        const where: any = { workspaceId };
        if (taskId)     where.taskId    = taskId;
        if (projectId)  where.projectId = projectId;
        if (visibility && !visibility.isWorkspaceManager) {
            where.userId = visibility.userId;
        } else if (userId) {
            where.userId = userId;
        }
        if (dateFrom || dateTo) {
            where.startTime = {};
            if (dateFrom) where.startTime.gte = new Date(dateFrom);
            if (dateTo)   where.startTime.lte = new Date(dateTo);
        }

        const [entries, total] = await Promise.all([
            this.prisma.timeEntry.findMany({
                where,
                skip,
                take: limit,
                orderBy: { startTime: sortOrder },
                include: {
                    user:    { select: { id: true, firstName: true, lastName: true } },
                    task:    { select: { id: true, title: true } },
                    project: { select: { id: true, name: true } },
                },
            }),
            this.prisma.timeEntry.count({ where }),
        ]);

        return { entries, total, page, limit };
    }

    async findTimeEntryById(id: string) {
        return this.prisma.timeEntry.findUnique({
            where: { id },
            include: {
                user:    { select: { id: true, firstName: true, lastName: true } },
                task:    { select: { id: true, title: true } },
                project: { select: { id: true, name: true } },
            },
        });
    }

    /** Find an active (no endTime) timer for this user in the given workspace. */
    async findActiveTimer(userId: string, workspaceId: string) {
        return this.prisma.timeEntry.findFirst({
            where: { userId, workspaceId, endTime: null, source: 'TIMER' },
        });
    }

    /** Detect any time entry that overlaps [startTime, endTime] for this user (excluding `excludeId`). */
    async findOverlappingEntry(
        userId: string,
        workspaceId: string,
        startTime: Date,
        endTime: Date,
        excludeId?: string,
    ) {
        return this.prisma.timeEntry.findFirst({
            where: {
                userId,
                workspaceId,
                id: excludeId ? { not: excludeId } : undefined,
                // An existing entry overlaps if it starts before our end and either
                // is still open or ends after our start.
                AND: [
                    { startTime: { lt: endTime } },
                    {
                        OR: [
                            { endTime: null },
                            { endTime: { gt: startTime } },
                        ],
                    },
                ],
            },
        });
    }

    // ─── Work Sessions ────────────────────────────────────────
    async findWorkSessions(
        workspaceId: string,
        opts: WorkSessionQueryDto,
        visibility?: { userId: string; isWorkspaceManager: boolean },
    ) {
        // Safe pagination defaults
        const page  = Math.max(1, Number(opts.page)  || 1);
        const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));
        const skip  = (page - 1) * limit;

        const { userId, dateFrom, dateTo } = opts;

        const where: any = { workspaceId };
        if (visibility && !visibility.isWorkspaceManager) {
            where.userId = visibility.userId;
        } else if (userId) {
            where.userId = userId;
        }
        if (dateFrom || dateTo) {
            where.clockIn = {};
            if (dateFrom) where.clockIn.gte = new Date(dateFrom);
            if (dateTo)   where.clockIn.lte = new Date(dateTo);
        }

        const [sessions, total] = await Promise.all([
            this.prisma.workSession.findMany({
                where,
                skip,
                take: limit,
                orderBy: { clockIn: 'desc' },
                include: { user: { select: { id: true, firstName: true, lastName: true } } },
            }),
            this.prisma.workSession.count({ where }),
        ]);

        return { sessions, total, page, limit };
    }

    async findActiveSession(userId: string, workspaceId: string) {
        return this.prisma.workSession.findFirst({
            where: { userId, workspaceId, clockOut: null },
        });
    }
}
