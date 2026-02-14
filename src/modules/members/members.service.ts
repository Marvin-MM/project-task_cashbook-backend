import { MembersRepository } from './members.repository';
import { NotFoundError, ConflictError, AuthorizationError, AppError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { InviteMemberDto, UpdateMemberRoleDto } from './members.dto';
import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();
const membersRepository = new MembersRepository();

export class MembersService {
    async getWorkspaceMembers(workspaceId: string) {
        return membersRepository.findByWorkspaceId(workspaceId);
    }

    async inviteMember(workspaceId: string, invitedByUserId: string, dto: InviteMemberDto) {
        // Find user by email
        const targetUser = await prisma.user.findUnique({
            where: { email: dto.email },
        });

        if (!targetUser) {
            throw new NotFoundError('User with this email');
        }

        if (!targetUser.isActive) {
            throw new AppError('Cannot invite deactivated user', 400, 'INVALID_OPERATION');
        }

        // Check if already a member
        const existing = await membersRepository.findByWorkspaceAndUser(workspaceId, targetUser.id);
        if (existing) {
            throw new ConflictError('User is already a member of this workspace');
        }

        const member = await membersRepository.addMember(workspaceId, targetUser.id, dto.role);

        await prisma.auditLog.create({
            data: {
                userId: invitedByUserId,
                workspaceId,
                action: AuditAction.MEMBER_INVITED,
                resource: 'workspace_member',
                resourceId: member.id,
                details: { invitedEmail: dto.email, role: dto.role } as any,
            },
        });

        return member;
    }

    async updateMemberRole(
        workspaceId: string,
        targetUserId: string,
        updatedByUserId: string,
        dto: UpdateMemberRoleDto
    ) {
        const membership = await membersRepository.findByWorkspaceAndUser(workspaceId, targetUserId);
        if (!membership) {
            throw new NotFoundError('Workspace member');
        }

        if (membership.role === 'OWNER') {
            throw new AppError('Cannot change the role of workspace owner', 400, 'INVALID_OPERATION');
        }

        const oldRole = membership.role;
        const updated = await membersRepository.updateRole(workspaceId, targetUserId, dto.role);

        await prisma.auditLog.create({
            data: {
                userId: updatedByUserId,
                workspaceId,
                action: AuditAction.MEMBER_ROLE_CHANGED,
                resource: 'workspace_member',
                resourceId: membership.id,
                details: { oldRole, newRole: dto.role, targetUserId } as any,
            },
        });

        return updated;
    }

    async removeMember(workspaceId: string, targetUserId: string, removedByUserId: string) {
        const membership = await membersRepository.findByWorkspaceAndUser(workspaceId, targetUserId);
        if (!membership) {
            throw new NotFoundError('Workspace member');
        }

        if (membership.role === 'OWNER') {
            throw new AppError('Cannot remove workspace owner', 400, 'INVALID_OPERATION');
        }

        // Also remove from all cashbooks in this workspace
        await prisma.$transaction(async (tx) => {
            // Remove cashbook memberships in this workspace
            const cashbooks = await tx.cashbook.findMany({
                where: { workspaceId },
                select: { id: true },
            });

            if (cashbooks.length > 0) {
                await tx.cashbookMember.deleteMany({
                    where: {
                        userId: targetUserId,
                        cashbookId: { in: cashbooks.map((c) => c.id) },
                    },
                });
            }

            await tx.workspaceMember.delete({
                where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
            });

            await tx.auditLog.create({
                data: {
                    userId: removedByUserId,
                    workspaceId,
                    action: AuditAction.MEMBER_REMOVED,
                    resource: 'workspace_member',
                    details: { targetUserId } as any,
                },
            });
        });
    }
}
