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
    CreateTaskCommentDto,
    CreateChecklistItemDto,
    UpdateChecklistItemDto,
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

    private async getProjectRole(projectId: string, userId: string): Promise<ProjectRole | null> {
        const m = await this.prisma.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId } },
        });
        return m ? (m.role as ProjectRole) : null;
    }

    private async assertCanViewTask(task: any, workspaceId: string, userId: string) {
        if (await this.isWorkspaceManager(workspaceId, userId)) return;
        if (task.createdById === userId) return;
        if (task.assignments.some((a: any) => a.userId === userId)) return;
        if (task.projectId && await this.getProjectRole(task.projectId, userId)) return;
        throw new AuthorizationError('You do not have access to this task');
    }

    private async assertCanWriteTask(task: any, workspaceId: string, userId: string) {
        if (await this.isWorkspaceManager(workspaceId, userId)) return;
        if (task.createdById === userId) return;
        if (task.projectId && await this.isProjectManager(task.projectId, userId)) return;
        throw new AuthorizationError('Insufficient permissions to modify this task');
    }

    private async assertCanCreateInProject(projectId: string, workspaceId: string, userId: string) {
        const project = await this.prisma.project.findUnique({ where: { id: projectId } });
        if (!project || project.workspaceId !== workspaceId) throw new NotFoundError('Project');
        if (project.status === 'ARCHIVED') {
            throw new AppError('Cannot create tasks on an archived project', 400, 'PROJECT_ARCHIVED');
        }

        if (await this.isWorkspaceManager(workspaceId, userId)) return;
        const role = await this.getProjectRole(projectId, userId);
        if (!role) {
            throw new AuthorizationError('You must be a project member to create tasks in this project');
        }
        if (role === ProjectRole.VIEWER) {
            throw new AuthorizationError('Viewers cannot create tasks on this project');
        }
    }

    // ─── List / Get ───────────────────────────────────────────
    async getTasks(workspaceId: string, userId: string, query: TaskQueryDto) {
        const isWorkspaceManager = await this.isWorkspaceManager(workspaceId, userId);
        const { tasks, total, page, limit } = await this.repo.findByWorkspaceId(
            workspaceId,
            query,
            { userId, isWorkspaceManager },
        );
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

    async getTask(taskId: string, workspaceId: string, userId: string) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanViewTask(task, workspaceId, userId);
        return task;
    }

    // ─── Create ───────────────────────────────────────────────
    async createTask(workspaceId: string, userId: string, dto: CreateTaskDto) {
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws || !ws.isActive) throw new NotFoundError('Workspace');

        if (dto.projectId) {
            await this.assertCanCreateInProject(dto.projectId, workspaceId, userId);
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

        if (dto.projectId !== undefined && dto.projectId) {
            await this.assertCanCreateInProject(dto.projectId, workspaceId, userId);
        }

        const data: any = {
            title: dto.title,
            description: dto.description,
            projectId: dto.projectId !== undefined ? dto.projectId : undefined,
            status: dto.status,
            priority: dto.priority,
            dueDate: dto.dueDate !== undefined ? (dto.dueDate ? new Date(dto.dueDate) : null) : undefined,
            estimatedTimeMinutes: dto.estimatedTimeMinutes,
        };
        if (dto.status === TaskStatus.DONE) {
            data.completedAt = new Date();
        } else if (dto.status) {
            data.completedAt = null;
        }

        const updated = await this.prisma.task.update({
            where: { id: taskId },
            data,
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

        const statusData: any = { status: dto.status };
        // completedAt when entering DONE; clear when reopening
        if (dto.status === TaskStatus.DONE) {
            statusData.completedAt = new Date();
        } else if ((task as any).completedAt || task.status === TaskStatus.DONE) {
            statusData.completedAt = null;
        }

        const updated = await this.prisma.task.update({
            where: { id: taskId },
            data: statusData,
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

    // ─── Assign (additive — never wipes existing assignees) ────
    async assignUsers(taskId: string, workspaceId: string, userId: string, dto: AssignTaskDto) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanWriteTask(task, workspaceId, userId);

        // Deduplicate target IDs
        const targetIds = [...new Set(dto.userIds)];

        // Validate each target user
        for (const targetId of targetIds) {
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

        // Existing assignees — only insert missing rows (additive)
        const existing = await this.prisma.taskAssignment.findMany({
            where: { taskId },
            select: { userId: true },
        });
        const existingSet = new Set(existing.map((e) => e.userId));
        const toAdd = targetIds.filter((id) => !existingSet.has(id));

        if (toAdd.length === 0) {
            return this.repo.findById(taskId);
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.taskAssignment.createMany({
                data: toAdd.map((uid) => ({ taskId, userId: uid, assignedBy: userId })),
                skipDuplicates: true,
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TASK_ASSIGNED,
                    resource: 'task',
                    resourceId: taskId,
                    details: { assignedUserIds: toAdd, mode: 'additive' } as any,
                },
            });
        });

        // Notify newly assigned only
        for (const assigneeId of toAdd) {
            if (assigneeId === userId) continue;
            notificationsQueue.add('TASK_ASSIGNED', {
                type: 'TASK_ASSIGNED',
                userId: assigneeId,
                workspaceId,
                taskId,
                taskTitle: task.title,
            }).catch(() => {});
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

    // ─── Comments ─────────────────────────────────────────────
    async listComments(taskId: string, workspaceId: string, userId: string) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanViewTask(task, workspaceId, userId);
        return this.prisma.taskComment.findMany({
            where: { taskId },
            orderBy: { createdAt: 'asc' },
            include: { author: { select: { id: true, firstName: true, lastName: true, email: true } } },
        });
    }

    async addComment(taskId: string, workspaceId: string, userId: string, dto: CreateTaskCommentDto) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanViewTask(task, workspaceId, userId);

        const comment = await this.prisma.taskComment.create({
            data: { taskId, authorId: userId, body: dto.body.trim() },
            include: { author: { select: { id: true, firstName: true, lastName: true, email: true } } },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.TASK_COMMENT_ADDED,
                resource: 'task_comment',
                resourceId: comment.id,
                details: { taskId } as any,
            },
        });

        return comment;
    }

    async deleteComment(taskId: string, commentId: string, workspaceId: string, userId: string) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanViewTask(task, workspaceId, userId);
        const comment = await this.prisma.taskComment.findUnique({ where: { id: commentId } });
        if (!comment || comment.taskId !== taskId) throw new NotFoundError('Comment');

        const isWsManager = await this.isWorkspaceManager(workspaceId, userId);
        if (comment.authorId !== userId && !isWsManager) {
            throw new AuthorizationError('You can only delete your own comments');
        }

        await this.prisma.taskComment.delete({ where: { id: commentId } });
        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.TASK_COMMENT_DELETED,
                resource: 'task_comment',
                resourceId: commentId,
                details: { taskId } as any,
            },
        });
    }

    // ─── Checklist ────────────────────────────────────────────
    async listChecklist(taskId: string, workspaceId: string, userId: string) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanViewTask(task, workspaceId, userId);
        return this.prisma.taskChecklistItem.findMany({
            where: { taskId },
            orderBy: { position: 'asc' },
        });
    }

    async addChecklistItem(
        taskId: string,
        workspaceId: string,
        userId: string,
        dto: CreateChecklistItemDto,
    ) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanWriteTask(task, workspaceId, userId);

        const maxPos = await this.prisma.taskChecklistItem.aggregate({
            where: { taskId },
            _max: { position: true },
        });
        const position = dto.position ?? ((maxPos._max.position ?? -1) + 1);

        const item = await this.prisma.taskChecklistItem.create({
            data: { taskId, title: dto.title.trim(), position },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.TASK_CHECKLIST_UPDATED,
                resource: 'task_checklist',
                resourceId: item.id,
                details: { taskId, action: 'add' } as any,
            },
        });

        return item;
    }

    async updateChecklistItem(
        taskId: string,
        itemId: string,
        workspaceId: string,
        userId: string,
        dto: UpdateChecklistItemDto,
    ) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        // Assignees may toggle done
        const isAssignee = task.assignments.some((a: any) => a.userId === userId);
        if (!isAssignee) await this.assertCanWriteTask(task, workspaceId, userId);

        const item = await this.prisma.taskChecklistItem.findUnique({ where: { id: itemId } });
        if (!item || item.taskId !== taskId) throw new NotFoundError('Checklist item');

        const data: any = {};
        if (dto.title !== undefined) data.title = dto.title.trim();
        if (dto.position !== undefined) data.position = dto.position;
        if (dto.isDone !== undefined) {
            data.isDone = dto.isDone;
            data.completedAt = dto.isDone ? new Date() : null;
            data.completedBy = dto.isDone ? userId : null;
        }

        const updated = await this.prisma.taskChecklistItem.update({
            where: { id: itemId },
            data,
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.TASK_CHECKLIST_UPDATED,
                resource: 'task_checklist',
                resourceId: itemId,
                details: { taskId, action: 'update', ...dto } as any,
            },
        });

        return updated;
    }

    async deleteChecklistItem(
        taskId: string,
        itemId: string,
        workspaceId: string,
        userId: string,
    ) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanWriteTask(task, workspaceId, userId);

        const item = await this.prisma.taskChecklistItem.findUnique({ where: { id: itemId } });
        if (!item || item.taskId !== taskId) throw new NotFoundError('Checklist item');

        await this.prisma.$transaction(async (tx) => {
            await tx.taskChecklistItem.delete({ where: { id: itemId } });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.TASK_CHECKLIST_UPDATED,
                    resource: 'task_checklist',
                    resourceId: itemId,
                    details: { taskId, action: 'delete' } as any,
                },
            });
        });
    }

    /** Recent audit activity for a task (production collaboration feed). */
    async getTaskActivity(taskId: string, workspaceId: string, userId: string) {
        const task = await this.getTaskInWorkspace(taskId, workspaceId);
        await this.assertCanViewTask(task, workspaceId, userId);
        // Pull recent workspace task-related logs and filter by taskId in details or resourceId
        const logs = await this.prisma.auditLog.findMany({
            where: {
                workspaceId,
                resource: { in: ['task', 'task_comment', 'task_checklist'] },
            },
            orderBy: { createdAt: 'desc' },
            take: 80,
            select: {
                id: true,
                action: true,
                resource: true,
                resourceId: true,
                details: true,
                createdAt: true,
                userId: true,
            },
        });
        return logs
            .filter((l) => {
                if (l.resource === 'task' && l.resourceId === taskId) return true;
                const d = l.details as any;
                return d && d.taskId === taskId;
            })
            .slice(0, 40);
    }
}
