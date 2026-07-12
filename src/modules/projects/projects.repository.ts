import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { ProjectQueryDto } from './projects.dto';

// Valid columns for ordering — prevents injection if sortBy ever bypasses Zod
const ALLOWED_SORT_FIELDS = new Set(['name', 'createdAt', 'startDate', 'endDate']);

@injectable()
export class ProjectsRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) {}

    async findByWorkspaceId(workspaceId: string, opts: ProjectQueryDto) {
        // Apply safe defaults at the repository layer so a partially validated
        // query object never causes NaN skip / undefined take in Prisma.
        const page      = Math.max(1, Number(opts.page)  || 1);
        const limit     = Math.min(100, Math.max(1, Number(opts.limit) || 20));
        const sortBy    = ALLOWED_SORT_FIELDS.has(opts.sortBy as string) ? (opts.sortBy as string) : 'createdAt';
        const sortOrder = opts.sortOrder === 'asc' ? 'asc' : 'desc';
        const skip      = (page - 1) * limit;

        const { status, search } = opts;

        const where: any = { workspaceId };
        if (status) where.status = status;
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [projects, total] = await Promise.all([
            this.prisma.project.findMany({
                where,
                skip,
                take: limit,
                orderBy: { [sortBy]: sortOrder },
                include: {
                    createdBy: { select: { id: true, firstName: true, lastName: true } },
                    _count: { select: { members: true, tasks: true } },
                },
            }),
            this.prisma.project.count({ where }),
        ]);

        return { projects, total, page, limit };
    }

    async findById(id: string) {
        return this.prisma.project.findUnique({
            where: { id },
            include: {
                createdBy: { select: { id: true, firstName: true, lastName: true } },
                members: {
                    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
                },
                _count: { select: { tasks: true, timeEntries: true } },
            },
        });
    }

    async findMembership(projectId: string, userId: string) {
        return this.prisma.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId } },
        });
    }

    async findAllMembers(projectId: string) {
        return this.prisma.projectMember.findMany({
            where: { projectId },
            include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        });
    }
}
