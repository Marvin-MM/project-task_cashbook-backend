import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
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

@injectable()
export class CashbooksService {
    constructor(
        private cashbooksRepository: CashbooksRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    async getCashbooks(workspaceId: string, userId: string) {
        // Check workspace type
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
        });

        if (!workspace || !workspace.isActive) {
            throw new NotFoundError('Workspace');
        }

        // Personal workspace: return all cashbooks (single owner)
        if (workspace.type === WorkspaceType.PERSONAL) {
            return this.cashbooksRepository.findByWorkspaceId(workspaceId);
        }

        // Business workspace: return only cashbooks the user has access to
        return this.cashbooksRepository.findUserAccessibleCashbooks(workspaceId, userId);
    }

    async getCashbook(cashbookId: string) {
        const cashbook = await this.cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }
        return cashbook;
    }

    async createCashbook(workspaceId: string, userId: string, dto: CreateCashbookDto) {
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
        });

        if (!workspace || !workspace.isActive) {
            throw new NotFoundError('Workspace');
        }

        const cashbook = await this.prisma.$transaction(async (tx) => {
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
        const cashbook = await this.cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        const updated = await this.cashbooksRepository.update(cashbookId, {
            ...(dto.name && { name: dto.name }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...(dto.currency && { currency: dto.currency }),
            ...(dto.allowBackdate !== undefined && { allowBackdate: dto.allowBackdate }),
        });

        await this.prisma.auditLog.create({
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
        const cashbook = await this.cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        await this.cashbooksRepository.softDelete(cashbookId);

        await this.prisma.auditLog.create({
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
        return this.cashbooksRepository.getMembers(cashbookId);
    }

    async addCashbookMember(cashbookId: string, addedByUserId: string, dto: AddCashbookMemberDto) {
        const cashbook = await this.cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        const targetUser = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });

        if (!targetUser) {
            throw new NotFoundError('User with this email');
        }

        // For business workspaces, user must be a workspace member
        if (cashbook.workspace.type === WorkspaceType.BUSINESS) {
            const wsMembership = await this.prisma.workspaceMember.findUnique({
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
        const existing = await this.cashbooksRepository.findMember(cashbookId, targetUser.id);
        if (existing) {
            throw new ConflictError('User is already a member of this cashbook');
        }

        const member = await this.cashbooksRepository.addMember(cashbookId, targetUser.id, dto.role);

        await this.prisma.auditLog.create({
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
        const membership = await this.cashbooksRepository.findMember(cashbookId, targetUserId);
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
        const updated = await this.cashbooksRepository.updateMemberRole(cashbookId, targetUserId, dto.role);

        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: { workspaceId: true },
        });

        await this.prisma.auditLog.create({
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
        const membership = await this.cashbooksRepository.findMember(cashbookId, targetUserId);
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

        await this.cashbooksRepository.removeMember(cashbookId, targetUserId);

        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: { workspaceId: true },
        });

        await this.prisma.auditLog.create({
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
        const summary = await this.cashbooksRepository.getFinancialSummary(cashbookId);
        if (!summary) {
            throw new NotFoundError('Cashbook');
        }
        return summary;
    }

    // ─── Balance Recalculation ─────────────────────────
    async recalculateBalance(cashbookId: string, userId: string) {
        const cashbook = await this.cashbooksRepository.findById(cashbookId);
        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        const oldBalance = cashbook.balance;
        const oldTotalIncome = cashbook.totalIncome;
        const oldTotalExpense = cashbook.totalExpense;

        // Aggregate from source-of-truth (non-deleted entries)
        const [incomeAgg, expenseAgg] = await Promise.all([
            this.prisma.entry.aggregate({
                where: { cashbookId, isDeleted: false, type: 'INCOME' },
                _sum: { amount: true },
            }),
            this.prisma.entry.aggregate({
                where: { cashbookId, isDeleted: false, type: 'EXPENSE' },
                _sum: { amount: true },
            }),
        ]);

        const totalIncome = incomeAgg._sum.amount ?? 0;
        const totalExpense = expenseAgg._sum.amount ?? 0;
        const balance = Number(totalIncome) - Number(totalExpense);

        const updated = await this.prisma.cashbook.update({
            where: { id: cashbookId },
            data: {
                balance,
                totalIncome,
                totalExpense,
            },
        });

        // Audit the recalculation
        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId: cashbook.workspaceId,
                action: AuditAction.CASHBOOK_UPDATED,
                resource: 'cashbook',
                resourceId: cashbookId,
                details: {
                    action: 'BALANCE_RECALCULATED',
                    oldBalance: oldBalance.toString(),
                    oldTotalIncome: oldTotalIncome.toString(),
                    oldTotalExpense: oldTotalExpense.toString(),
                    newBalance: balance.toString(),
                    newTotalIncome: totalIncome.toString(),
                    newTotalExpense: totalExpense.toString(),
                } as any,
            },
        });

        return {
            cashbookId,
            oldBalance: oldBalance.toString(),
            newBalance: balance.toString(),
            totalIncome: totalIncome.toString(),
            totalExpense: totalExpense.toString(),
        };
    }

    // ─── Reconciliation Toggle ────────────────────────
    async toggleReconciliation(entryId: string, cashbookId: string, userId: string) {
        const entry = await this.prisma.entry.findUnique({
            where: { id: entryId },
        });

        if (!entry || entry.isDeleted || entry.cashbookId !== cashbookId) {
            throw new NotFoundError('Entry');
        }

        const updated = await this.prisma.entry.update({
            where: { id: entryId },
            data: { isReconciled: !entry.isReconciled },
        });

        return {
            entryId,
            isReconciled: updated.isReconciled,
        };
    }
}
