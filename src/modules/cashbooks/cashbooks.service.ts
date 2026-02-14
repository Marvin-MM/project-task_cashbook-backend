import { CashbooksRepository } from './cashbooks.repository';
import {
    NotFoundError,
    ConflictError,
    AuthorizationError,
    AppError,
} from '../../core/errors/AppError';
import {
    AuditAction,
    CashbookRole,
    WorkspaceType,
} from '../../core/types';
import {
    CreateCashbookDto,
    UpdateCashbookDto,
    AddCashbookMemberDto,
    UpdateCashbookMemberRoleDto,
} from './cashbooks.dto';
import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();
const cashbooksRepository = new CashbooksRepository();

export class CashbooksService {
    async getCashbooks(workspaceId: string, userId: string) {
        // Check workspace type
        const workspace = await prisma.workspace.findUnique({
            where: { id: workspaceId },
        });

        if (!workspace || !workspace.isActive) {
            throw new NotFoundError('Workspace');
        }

        // Personal workspace: return all cashbooks (single owner)
        if (workspace.type === WorkspaceType.PERSONAL) {
            return cashbooksRepository.findByWorkspaceId(workspaceId);
        }

        // Business workspace: return only cashbooks the user has access to
        return cashbooksRepository.findUserAccessibleCashbooks(workspaceId, userId);
    }

    async getCashbook(cashbookId: string) {
        const cashbook = await cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }
        return cashbook;
    }

    async createCashbook(workspaceId: string, userId: string, dto: CreateCashbookDto) {
        const workspace = await prisma.workspace.findUnique({
            where: { id: workspaceId },
        });

        if (!workspace || !workspace.isActive) {
            throw new NotFoundError('Workspace');
        }

        const cashbook = await prisma.$transaction(async (tx) => {
            const cb = await tx.cashbook.create({
                data: {
                    name: dto.name,
                    description: dto.description,
                    currency: dto.currency,
                    allowBackdate: dto.allowBackdate,
                    workspace: { connect: { id: workspaceId } },
                },
                include: { workspace: true },
            });

            // For business workspaces, add creator as PRIMARY_ADMIN
            if (workspace.type === WorkspaceType.BUSINESS) {
                await tx.cashbookMember.create({
                    data: {
                        cashbookId: cb.id,
                        userId,
                        role: CashbookRole.PRIMARY_ADMIN,
                    },
                });
            }

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.CASHBOOK_CREATED,
                    resource: 'cashbook',
                    resourceId: cb.id,
                    details: { name: dto.name, currency: dto.currency } as any,
                },
            });

            return cb;
        });

        return cashbook;
    }

    async updateCashbook(cashbookId: string, userId: string, dto: UpdateCashbookDto) {
        const cashbook = await cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        const updated = await cashbooksRepository.update(cashbookId, {
            ...(dto.name && { name: dto.name }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...(dto.currency && { currency: dto.currency }),
            ...(dto.allowBackdate !== undefined && { allowBackdate: dto.allowBackdate }),
        });

        await prisma.auditLog.create({
            data: {
                userId,
                workspaceId: cashbook.workspaceId,
                action: AuditAction.CASHBOOK_UPDATED,
                resource: 'cashbook',
                resourceId: cashbookId,
                details: dto as any,
            },
        });

        return updated;
    }

    async deleteCashbook(cashbookId: string, userId: string) {
        const cashbook = await cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        await cashbooksRepository.softDelete(cashbookId);

        await prisma.auditLog.create({
            data: {
                userId,
                workspaceId: cashbook.workspaceId,
                action: AuditAction.CASHBOOK_DELETED,
                resource: 'cashbook',
                resourceId: cashbookId,
            },
        });
    }

    // ─── Cashbook Members ──────────────────────────────
    async getCashbookMembers(cashbookId: string) {
        return cashbooksRepository.getMembers(cashbookId);
    }

    async addCashbookMember(cashbookId: string, addedByUserId: string, dto: AddCashbookMemberDto) {
        const cashbook = await cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        const targetUser = await prisma.user.findUnique({
            where: { email: dto.email },
        });

        if (!targetUser) {
            throw new NotFoundError('User with this email');
        }

        // For business workspaces, user must be a workspace member
        if (cashbook.workspace.type === WorkspaceType.BUSINESS) {
            const wsMembership = await prisma.workspaceMember.findUnique({
                where: {
                    workspaceId_userId: {
                        workspaceId: cashbook.workspaceId,
                        userId: targetUser.id,
                    },
                },
            });

            if (!wsMembership && cashbook.workspace.ownerId !== targetUser.id) {
                throw new AppError(
                    'User must be a workspace member before adding to a cashbook',
                    400,
                    'INVALID_OPERATION'
                );
            }
        }

        // Check if already a cashbook member
        const existing = await cashbooksRepository.findMember(cashbookId, targetUser.id);
        if (existing) {
            throw new ConflictError('User is already a member of this cashbook');
        }

        const member = await cashbooksRepository.addMember(cashbookId, targetUser.id, dto.role);

        await prisma.auditLog.create({
            data: {
                userId: addedByUserId,
                workspaceId: cashbook.workspaceId,
                action: AuditAction.CASHBOOK_MEMBER_ADDED,
                resource: 'cashbook_member',
                resourceId: member.id,
                details: { email: dto.email, role: dto.role, cashbookId } as any,
            },
        });

        return member;
    }

    async updateCashbookMemberRole(
        cashbookId: string,
        targetUserId: string,
        updatedByUserId: string,
        dto: UpdateCashbookMemberRoleDto
    ) {
        const membership = await cashbooksRepository.findMember(cashbookId, targetUserId);
        if (!membership) {
            throw new NotFoundError('Cashbook member');
        }

        if (membership.role === 'PRIMARY_ADMIN') {
            throw new AppError(
                'Cannot change the role of the primary admin',
                400,
                'INVALID_OPERATION'
            );
        }

        const oldRole = membership.role;
        const updated = await cashbooksRepository.updateMemberRole(cashbookId, targetUserId, dto.role);

        const cashbook = await prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: { workspaceId: true },
        });

        await prisma.auditLog.create({
            data: {
                userId: updatedByUserId,
                workspaceId: cashbook?.workspaceId,
                action: AuditAction.CASHBOOK_MEMBER_ROLE_CHANGED,
                resource: 'cashbook_member',
                resourceId: membership.id,
                details: { oldRole, newRole: dto.role, targetUserId, cashbookId } as any,
            },
        });

        return updated;
    }

    async removeCashbookMember(cashbookId: string, targetUserId: string, removedByUserId: string) {
        const membership = await cashbooksRepository.findMember(cashbookId, targetUserId);
        if (!membership) {
            throw new NotFoundError('Cashbook member');
        }

        if (membership.role === 'PRIMARY_ADMIN') {
            throw new AppError(
                'Cannot remove the primary admin from the cashbook',
                400,
                'INVALID_OPERATION'
            );
        }

        await cashbooksRepository.removeMember(cashbookId, targetUserId);

        const cashbook = await prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: { workspaceId: true },
        });

        await prisma.auditLog.create({
            data: {
                userId: removedByUserId,
                workspaceId: cashbook?.workspaceId,
                action: AuditAction.CASHBOOK_MEMBER_REMOVED,
                resource: 'cashbook_member',
                details: { targetUserId, cashbookId } as any,
            },
        });
    }

    // ─── Financial Summary ─────────────────────────────
    async getFinancialSummary(cashbookId: string) {
        const summary = await cashbooksRepository.getFinancialSummary(cashbookId);
        if (!summary) {
            throw new NotFoundError('Cashbook');
        }
        return summary;
    }
}
