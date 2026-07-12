import { injectable, inject } from 'tsyringe';
import { PrismaClient, TaskStatus, ProjectRole } from '@prisma/client';
import { TasksRepository } from './tasks.repository';
import { NotFoundError, AuthorizationError, AppError } from '../../core/errors/AppError';
import { AuditAction, WorkspaceRole } from '../../core/types';
import {
    CreateTaskDto,
    UpdateTaskDto,
    AssignTaskDto,
    ChangeTaskStatusDto,
    TaskQueryDto,
} from './tasks.dto';
import { notificationsQueue } from '../../config/queues';

@injectable()
export class TasksService {
    constructor(
        private repo: TasksRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) {}

    // ─── Helpers ──────────────────────────────────────────────
    private async getTaskInWorkspace(taskId: string, workspaceId: string) {
        const task = await this.repo.findById(taskId);
        if (!task || task.workspaceId !== workspaceId) throw new NotFoundError('Task');
        return task;
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

    private async isProjectManager(projectId: string, userId: string): Promise<boolean> {
        const m = await this.prisma.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId } },
        });
        return m?.role === ProjectRole.PROJECT_MANAGER;
    }

    private async assertCanWriteTask(task: any, workspaceId: string, userId: string) {
        if (await this.isWorkspaceManager(workspaceId, userId)) return;
        if (task.createdById === userId) return;
        if (task.projectId && await this.isProjectManager(task.projectId, userId)) return;
        throw new AuthorizationError('Insufficient permissions to modify this task');
    }

    // ─── List / Get ───────────────────────────────────────────
    async getTasks(workspaceId: string, query: TaskQueryDto) {
        const { tasks, total, page, limit } = await this.repo.findByWorkspaceId(workspaceId, query);
        const totalPages = Math.ceil(total / limit);
        return {
            data: tasks,
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

    async getTask(taskId: string, workspaceId: string) {
        return this.getTaskInWorkspace(taskId, workspaceId);
    }

    // ─── Create ───────────────────────────────────────────────
    async createTask(workspaceId: string, userId: string, dto: CreateTaskDto) {
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws || !ws.isActive) throw new NotFoundError('Workspace');

        // If project provided — caller must be a workspace manager or project member
        if (dto.projectId) {
            const project = await this.prisma.project.findUnique({ where: { id: dto.projectId } });
            if (!project || project.workspaceId !== workspaceId) throw new NotFoundError('Project');

            const isWsManager = await this.isWorkspaceManager(workspaceId, userId);
            if (!isWsManager) {
                const membership = await this.prisma.projectMember.findUnique({
                    where: { projectId_userId: { projectId: dto.projectId, userId } },
                });
                if (!membership) throw new AuthorizationError('You must be a project member to create tasks in this project');
            }
        }

        const task = await this.prisma.$transaction(async (tx) => {
            const newTask = await tx.task.create({
                data: {
                    workspaceId,
                    createdById: userId,
                    projectId: dto.projectId ?? null,
                    title: dto.title,
                    description: dto.description ?? null,
                    status: dto.status ?? TaskStatus.TODO,
                    priority: dto.priority ?? 'MEDIUM',
                    dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
                    estimatedTimeMinutes: dto.estimatedTimeMinutes ?? null,
                },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TASK_CREATED,
                    resource: 'task',
                    resourceId: newTask.id,
                    details: { title: dto.title, projectId: dto.projectId ?? null } as any,
                },
            });
            return newTask;
        });

        return task;
    }

    // ─── Update ───────────────────────────────────────────────
    async updateTask(taskId: string, workspaceId: string, userId: string, dto: UpdateTaskDto) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanWriteTask(task, workspaceId, userId);

        const updated = await this.prisma.task.update({
            where: { id: taskId },
            data: {
                title: dto.title,
                description: dto.description,
                status: dto.status,
                priority: dto.priority,
                dueDate: dto.dueDate !== undefined ? (dto.dueDate ? new Date(dto.dueDate) : null) : undefined,
                estimatedTimeMinutes: dto.estimatedTimeMinutes,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.TASK_UPDATED,
                resource: 'task',
                resourceId: taskId,
                details: dto as any,
            },
        });

        return updated;
    }

    // ─── Change Status ────────────────────────────────────────
    async changeStatus(taskId: string, workspaceId: string, userId: string, dto: ChangeTaskStatusDto) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);

        // Assignee, task creator, project manager, or workspace manager can change status
        const isAssignee = task.assignments.some((a: any) => a.userId === userId);
        if (!isAssignee) await this.assertCanWriteTask(task, workspaceId, userId);

        const updated = await this.prisma.task.update({
            where: { id: taskId },
            data: { status: dto.status },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.TASK_STATUS_CHANGED,
                resource: 'task',
                resourceId: taskId,
                details: { status: dto.status } as any,
            },
        });

        return updated;
    }

    // ─── Delete ───────────────────────────────────────────────
    async deleteTask(taskId: string, workspaceId: string, userId: string) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanWriteTask(task, workspaceId, userId);

        await this.prisma.$transaction(async (tx) => {
            await tx.task.delete({ where: { id: taskId } });
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.TASK_DELETED, resource: 'task', resourceId: taskId },
            });
        });
    }

    // ─── Assign ───────────────────────────────────────────────
    async assignUsers(taskId: string, workspaceId: string, userId: string, dto: AssignTaskDto) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanWriteTask(task, workspaceId, userId);

        // Validate each target user
        for (const targetId of dto.userIds) {
            const wsM = await this.prisma.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId, userId: targetId } },
            });
            const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
            if (!wsM && ws?.ownerId !== targetId) {
                throw new AppError(`User ${targetId} is not a workspace member`, 400, 'INVALID_OPERATION');
            }

            if (task.projectId) {
                const pm = await this.prisma.projectMember.findUnique({
                    where: { projectId_userId: { projectId: task.projectId, userId: targetId } },
                });
                if (!pm) {
                    throw new AppError(
                        `User ${targetId} is not a project member. Add them to the project first.`,
                        400,
                        'INVALID_OPERATION',
                    );
                }
            }
        }

        // Atomic replace — delete existing assignments then insert new ones
        await this.prisma.$transaction(async (tx) => {
            await tx.taskAssignment.deleteMany({ where: { taskId } });

            await tx.taskAssignment.createMany({
                data: dto.userIds.map((uid) => ({ taskId, userId: uid, assignedBy: userId })),
                skipDuplicates: true,
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TASK_ASSIGNED,
                    resource: 'task',
                    resourceId: taskId,
                    details: { assignedUserIds: dto.userIds } as any,
                },
            });
        });

        // Dispatch notifications non-blockingly
        for (const assigneeId of dto.userIds) {
            if (assigneeId === userId) continue; // don't notify self
            notificationsQueue.add('TASK_ASSIGNED', {
                type: 'TASK_ASSIGNED',
                userId: assigneeId,
                workspaceId,
                taskId,
                taskTitle: task.title,
            }).catch(() => {}); // fire-and-forget
        }

        return this.repo.findById(taskId);
    }

    async unassignUser(taskId: string, workspaceId: string, userId: string, targetUserId: string) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanWriteTask(task, workspaceId, userId);

        const assignment = await this.repo.findAssignment(taskId, targetUserId);
        if (!assignment) throw new NotFoundError('Task assignment');

        await this.prisma.$transaction(async (tx) => {
            await tx.taskAssignment.delete({
                where: { taskId_userId: { taskId, userId: targetUserId } },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TASK_UNASSIGNED,
                    resource: 'task',
                    resourceId: taskId,
                    details: { unassignedUserId: targetUserId } as any,
                },
            });
        });
    }
}
