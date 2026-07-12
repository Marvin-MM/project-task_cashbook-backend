import { injectable, inject } from 'tsyringe';
import { PrismaClient, ProjectRole, ProjectStatus } from '@prisma/client';
import { ProjectsRepository } from './projects.repository';
import { NotFoundError, ConflictError, AuthorizationError, AppError } from '../../core/errors/AppError';
import { AuditAction, WorkspaceRole } from '../../core/types';
import {
    CreateProjectDto,
    UpdateProjectDto,
    AddProjectMemberDto,
    UpdateProjectMemberRoleDto,
    ProjectQueryDto,
} from './projects.dto';

@injectable()
export class ProjectsService {
    constructor(
        private repo: ProjectsRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) {}

    // ─── Helpers ──────────────────────────────────────────────
    private async assertWorkspaceActive(workspaceId: string) {
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws || !ws.isActive) throw new NotFoundError('Workspace');
        return ws;
    }

    private async getProjectInWorkspace(projectId: string, workspaceId: string) {
        const project = await this.repo.findById(projectId);
        if (!project || project.workspaceId !== workspaceId) throw new NotFoundError('Project');
        return project;
    }

    /** Returns true when the caller is workspace OWNER or ADMIN. */
    private async isWorkspaceManager(workspaceId: string, userId: string): Promise<boolean> {
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!ws) return false;
        if (ws.ownerId === userId) return true;
        const membership = await this.prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId } },
        });
        return membership?.role === WorkspaceRole.ADMIN;
    }

    /** Returns the caller's project role or null if not a member. */
    private async getProjectRole(projectId: string, userId: string): Promise<ProjectRole | null> {
        const m = await this.repo.findMembership(projectId, userId);
        return m ? (m.role as ProjectRole) : null;
    }

    /** Asserts caller can manage project (PROJECT_MANAGER or workspace OWNER/ADMIN). */
    private async assertCanManageProject(projectId: string, workspaceId: string, userId: string) {
        const isWsManager = await this.isWorkspaceManager(workspaceId, userId);
        if (isWsManager) return;
        const role = await this.getProjectRole(projectId, userId);
        if (role !== ProjectRole.PROJECT_MANAGER) {
            throw new AuthorizationError('Only project managers or workspace admins can perform this action');
        }
    }

    // ─── CRUD ────────────────────────────────────────────────
    async getProjects(workspaceId: string, userId: string, query: ProjectQueryDto) {
        await this.assertWorkspaceActive(workspaceId);
        const { projects, total, page, limit } = await this.repo.findByWorkspaceId(workspaceId, query);
        const totalPages = Math.ceil(total / limit);
        return {
            data: projects,
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

    async getProject(projectId: string, workspaceId: string) {
        return this.getProjectInWorkspace(projectId, workspaceId);
    }

    async createProject(workspaceId: string, userId: string, dto: CreateProjectDto) {
        await this.assertWorkspaceActive(workspaceId);

        const project = await this.prisma.$transaction(async (tx) => {
            const newProject = await tx.project.create({
                data: {
                    workspaceId,
                    createdById: userId,
                    name: dto.name,
                    description: dto.description ?? null,
                    status: dto.status ?? ProjectStatus.ACTIVE,
                    startDate: dto.startDate ? new Date(dto.startDate) : null,
                    endDate: dto.endDate ? new Date(dto.endDate) : null,
                },
            });

            // Auto-add creator as PROJECT_MANAGER
            await tx.projectMember.create({
                data: {
                    projectId: newProject.id,
                    userId,
                    role: ProjectRole.PROJECT_MANAGER,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.PROJECT_CREATED,
                    resource: 'project',
                    resourceId: newProject.id,
                    details: { name: dto.name } as any,
                },
            });

            return newProject;
        });

        return project;
    }

    async updateProject(projectId: string, workspaceId: string, userId: string, dto: UpdateProjectDto) {
        const project = await this.getProjectInWorkspace(projectId, workspaceId);
        if (project.status === ProjectStatus.ARCHIVED) {
            throw new AppError('Cannot update an archived project', 400, 'INVALID_OPERATION');
        }

        await this.assertCanManageProject(projectId, workspaceId, userId);

        const updated = await this.prisma.project.update({
            where: { id: projectId },
            data: {
                name: dto.name,
                description: dto.description,
                status: dto.status,
                startDate: dto.startDate !== undefined ? (dto.startDate ? new Date(dto.startDate) : null) : undefined,
                endDate: dto.endDate !== undefined ? (dto.endDate ? new Date(dto.endDate) : null) : undefined,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.PROJECT_UPDATED,
                resource: 'project',
                resourceId: projectId,
                details: dto as any,
            },
        });

        return updated;
    }

    async archiveProject(projectId: string, workspaceId: string, userId: string) {
        await this.getProjectInWorkspace(projectId, workspaceId);
        await this.assertCanManageProject(projectId, workspaceId, userId);

        const updated = await this.prisma.project.update({
            where: { id: projectId },
            data: { status: ProjectStatus.ARCHIVED },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.PROJECT_ARCHIVED, resource: 'project', resourceId: projectId },
        });

        return updated;
    }

    async deleteProject(projectId: string, workspaceId: string, userId: string) {
        await this.getProjectInWorkspace(projectId, workspaceId);
        const isWsManager = await this.isWorkspaceManager(workspaceId, userId);
        if (!isWsManager) throw new AuthorizationError('Only workspace owners or admins can delete projects');

        await this.prisma.$transaction(async (tx) => {
            await tx.project.delete({ where: { id: projectId } });
            await tx.auditLog.create({
                data: { userId, workspaceId, action: AuditAction.PROJECT_DELETED, resource: 'project', resourceId: projectId },
            });
        });
    }

    // ─── Members ─────────────────────────────────────────────
    async getMembers(projectId: string, workspaceId: string) {
        await this.getProjectInWorkspace(projectId, workspaceId);
        return this.repo.findAllMembers(projectId);
    }

    async addMember(projectId: string, workspaceId: string, userId: string, dto: AddProjectMemberDto) {
        await this.getProjectInWorkspace(projectId, workspaceId);
        await this.assertCanManageProject(projectId, workspaceId, userId);

        // Target user must be a workspace member
        const wsMembership = await this.prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: dto.userId } },
        });
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!wsMembership && ws?.ownerId !== dto.userId) {
            throw new AppError('User is not a member of this workspace', 400, 'INVALID_OPERATION');
        }

        const existing = await this.repo.findMembership(projectId, dto.userId);
        if (existing) throw new ConflictError('User is already a member of this project');

        const member = await this.prisma.$transaction(async (tx) => {
            const m = await tx.projectMember.create({
                data: { projectId, userId: dto.userId, role: dto.role },
                include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.PROJECT_MEMBER_ADDED,
                    resource: 'project_member',
                    resourceId: m.id,
                    details: { projectId, addedUserId: dto.userId, role: dto.role } as any,
                },
            });
            return m;
        });

        return member;
    }

    async updateMemberRole(projectId: string, memberId: string, workspaceId: string, userId: string, dto: UpdateProjectMemberRoleDto) {
        await this.getProjectInWorkspace(projectId, workspaceId);
        await this.assertCanManageProject(projectId, workspaceId, userId);

        const member = await this.prisma.projectMember.findUnique({ where: { id: memberId } });
        if (!member || member.projectId !== projectId) throw new NotFoundError('Project member');

        // Prevent demoting the last PROJECT_MANAGER
        if (member.role === ProjectRole.PROJECT_MANAGER && dto.role !== ProjectRole.PROJECT_MANAGER) {
            const managerCount = await this.prisma.projectMember.count({
                where: { projectId, role: ProjectRole.PROJECT_MANAGER },
            });
            if (managerCount <= 1) {
                throw new AppError('Cannot demote the only project manager', 400, 'INVALID_OPERATION');
            }
        }

        const updated = await this.prisma.projectMember.update({
            where: { id: memberId },
            data: { role: dto.role },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.PROJECT_MEMBER_ROLE_CHANGED,
                resource: 'project_member',
                resourceId: memberId,
                details: { projectId, role: dto.role } as any,
            },
        });

        return updated;
    }

    async removeMember(projectId: string, memberId: string, workspaceId: string, userId: string) {
        await this.getProjectInWorkspace(projectId, workspaceId);
        await this.assertCanManageProject(projectId, workspaceId, userId);

        const member = await this.prisma.projectMember.findUnique({ where: { id: memberId } });
        if (!member || member.projectId !== projectId) throw new NotFoundError('Project member');

        // Cannot remove the last PROJECT_MANAGER
        if (member.role === ProjectRole.PROJECT_MANAGER) {
            const managerCount = await this.prisma.projectMember.count({
                where: { projectId, role: ProjectRole.PROJECT_MANAGER },
            });
            if (managerCount <= 1) {
                throw new AppError('Cannot remove the only project manager', 400, 'INVALID_OPERATION');
            }
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.projectMember.delete({ where: { id: memberId } });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.PROJECT_MEMBER_REMOVED,
                    resource: 'project_member',
                    resourceId: memberId,
                    details: { projectId, removedUserId: member.userId } as any,
                },
            });
        });
    }
}
