import { WorkspacesRepository } from './workspaces.repository';
import { NotFoundError, AuthorizationError, AppError } from '../../core/errors/AppError';
import { WorkspaceType, WorkspaceRole, AuditAction } from '../../core/types';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from './workspaces.dto';
import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();
const workspacesRepository = new WorkspacesRepository();

export class WorkspacesService {
    async getUserWorkspaces(userId: string) {
        return workspacesRepository.findUserWorkspaces(userId);
    }

    async getWorkspace(workspaceId: string, userId: string) {
        const workspace = await workspacesRepository.findById(workspaceId);
        if (!workspace || !workspace.isActive) {
            throw new NotFoundError('Workspace');
        }
        return workspace;
    }

    async createBusinessWorkspace(userId: string, dto: CreateWorkspaceDto) {
        const workspace = await prisma.$transaction(async (tx) => {
            const ws = await tx.workspace.create({
                data: {
                    name: dto.name,
                    type: WorkspaceType.BUSINESS,
                    ownerId: userId,
                },
                include: {
                    owner: {
                        select: { id: true, email: true, firstName: true, lastName: true },
                    },
                },
            });

            // Owner is automatically the first member
            await tx.workspaceMember.create({
                data: {
                    workspaceId: ws.id,
                    userId,
                    role: WorkspaceRole.OWNER,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId: ws.id,
                    action: AuditAction.WORKSPACE_CREATED,
                    resource: 'workspace',
                    resourceId: ws.id,
                    details: { name: dto.name } as any,
                },
            });

            return ws;
        });

        return workspace;
    }

    async updateWorkspace(workspaceId: string, userId: string, dto: UpdateWorkspaceDto) {
        const workspace = await workspacesRepository.findById(workspaceId);
        if (!workspace || !workspace.isActive) {
            throw new NotFoundError('Workspace');
        }

        if (workspace.ownerId !== userId) {
            // Check if user is an admin
            const membership = await prisma.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId, userId } },
            });
            if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
                throw new AuthorizationError('Only workspace owner or admin can update workspace');
            }
        }

        const updated = await workspacesRepository.update(workspaceId, dto);

        await prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.WORKSPACE_UPDATED,
                resource: 'workspace',
                resourceId: workspaceId,
                details: dto as any,
            },
        });

        return updated;
    }

    async deleteWorkspace(workspaceId: string, userId: string) {
        const workspace = await workspacesRepository.findById(workspaceId);
        if (!workspace || !workspace.isActive) {
            throw new NotFoundError('Workspace');
        }

        if (workspace.type === 'PERSONAL') {
            throw new AppError('Cannot delete personal workspace', 400, 'INVALID_OPERATION');
        }

        if (workspace.ownerId !== userId) {
            throw new AuthorizationError('Only the workspace owner can delete it');
        }

        await workspacesRepository.softDelete(workspaceId);

        await prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.WORKSPACE_DELETED,
                resource: 'workspace',
                resourceId: workspaceId,
            },
        });
    }
}
