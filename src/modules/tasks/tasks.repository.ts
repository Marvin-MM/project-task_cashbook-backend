import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { TaskQueryDto } from './tasks.dto';

const TASK_INCLUDE = {
    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
    project: { select: { id: true, name: true, status: true } },
    assignments: {
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    },
    comments: {
        orderBy: { createdAt: 'asc' as const },
        include: { author: { select: { id: true, firstName: true, lastName: true, email: true } } },
        take: 100,
    },
    checklist: {
        orderBy: { position: 'asc' as const },
    },
    _count: { select: { timeEntries: true, comments: true, checklist: true } },
} as const;

const ALLOWED_SORT_FIELDS = new Set(['createdAt', 'dueDate', 'priority', 'title']);

@injectable()
export class TasksRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) {}

    async findByWorkspaceId(
        workspaceId: string,
        opts: TaskQueryDto,
        visibility?: { userId: string; isWorkspaceManager: boolean },
    ) {
        // Safe pagination defaults — prevents NaN/undefined reaching Prisma
        const page      = Math.max(1, Number(opts.page)  || 1);
        const limit     = Math.min(100, Math.max(1, Number(opts.limit) || 20));
        const sortBy    = ALLOWED_SORT_FIELDS.has(opts.sortBy as string) ? (opts.sortBy as string) : 'createdAt';
        const sortOrder = opts.sortOrder === 'asc' ? 'asc' : 'desc';
        const skip      = (page - 1) * limit;
        const now       = new Date();

        const { projectId, status, priority, assigneeId, isOverdue, search } = opts;

        const where: any = { workspaceId };
        if (visibility && !visibility.isWorkspaceManager) {
            where.OR = [
                { createdById: visibility.userId },
                { assignments: { some: { userId: visibility.userId } } },
                { project: { members: { some: { userId: visibility.userId } } } },
            ];
        }
        if (projectId !== undefined) where.projectId = projectId;
        if (status) where.status = status;
        if (priority) where.priority = priority;
        if (isOverdue) where.dueDate = { lt: now };
        if (search) {
            const searchWhere = [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
            ];
            if (where.OR) {
                where.AND = [{ OR: where.OR }, { OR: searchWhere }];
                delete where.OR;
            } else {
                where.OR = searchWhere;
            }
        }
        if (assigneeId) {
            where.assignments = { some: { userId: assigneeId } };
        }

        const [tasks, total] = await Promise.all([
            this.prisma.task.findMany({
                where,
                skip,
                take: limit,
                orderBy: { [sortBy]: sortOrder },
                include: TASK_INCLUDE,
            }),
            this.prisma.task.count({ where }),
        ]);

        return { tasks, total, page, limit };
    }

    async findById(id: string) {
        return this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
    }

    async findAssignment(taskId: string, userId: string) {
        return this.prisma.taskAssignment.findUnique({
            where: { taskId_userId: { taskId, userId } },
        });
    }
}
