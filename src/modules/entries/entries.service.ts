import { Decimal } from '@prisma/client/runtime/library';
import { EntriesRepository } from './entries.repository';
import {
    NotFoundError,
    AppError,
    ConflictError,
} from '../../core/errors/AppError';
import {
    AuditAction,
    CashbookRole,
    EntryType,
} from '../../core/types';
import {
    CreateEntryDto,
    UpdateEntryDto,
    DeleteEntryDto,
    ReviewDeleteRequestDto,
    EntryQueryDto,
} from './entries.dto';
import { getPrismaClient } from '../../config/database';
import { logger } from '../../utils/logger';
import { isDateInPast } from '../../utils/helpers';
import { CashbookPermission, hasPermission } from '../../core/types/permissions';

const prisma = getPrismaClient();
const entriesRepository = new EntriesRepository();

export class EntriesService {
    // ─── List Entries ──────────────────────────────────
    async getEntries(cashbookId: string, query: EntryQueryDto) {
        const { entries, total } = await entriesRepository.findByCashbookId(cashbookId, {
            page: query.page,
            limit: query.limit,
            type: query.type,
            categoryId: query.categoryId,
            contactId: query.contactId,
            paymentModeId: query.paymentModeId,
            startDate: query.startDate,
            endDate: query.endDate,
            sortBy: query.sortBy,
            sortOrder: query.sortOrder,
        });

        const totalPages = Math.ceil(total / query.limit);

        return {
            data: entries,
            pagination: {
                page: query.page,
                limit: query.limit,
                total,
                totalPages,
                hasNext: query.page < totalPages,
                hasPrevious: query.page > 1,
            },
        };
    }

    // ─── Get Single Entry ─────────────────────────────
    async getEntry(entryId: string) {
        const entry = await entriesRepository.findById(entryId);
        if (!entry || entry.isDeleted) {
            throw new NotFoundError('Entry');
        }
        return entry;
    }

    // ─── Create Entry ─────────────────────────────────
    async createEntry(cashbookId: string, userId: string, dto: CreateEntryDto) {
        // Get cashbook for backdate check
        const cashbook = await prisma.cashbook.findUnique({
            where: { id: cashbookId },
        });

        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        const entryDate = new Date(dto.entryDate);

        // Check backdate rule
        if (!cashbook.allowBackdate && isDateInPast(entryDate)) {
            throw new AppError(
                'Backdated entries are not allowed for this cashbook',
                400,
                'BACKDATE_NOT_ALLOWED'
            );
        }

        const amount = new Decimal(dto.amount);

        // Use transaction for concurrency safety
        const entry = await prisma.$transaction(async (tx) => {
            // Create entry
            const newEntry = await tx.entry.create({
                data: {
                    cashbookId,
                    type: dto.type as any,
                    amount,
                    description: dto.description,
                    categoryId: dto.categoryId || null,
                    contactId: dto.contactId || null,
                    paymentModeId: dto.paymentModeId || null,
                    entryDate,
                    createdById: userId,
                },
                include: {
                    category: true,
                    contact: true,
                    paymentMode: true,
                    createdBy: {
                        select: { id: true, email: true, firstName: true, lastName: true },
                    },
                },
            });

            // Update cashbook balance atomically
            const balanceBefore = cashbook.balance;
            const isIncome = dto.type === EntryType.INCOME;

            await tx.cashbook.update({
                where: { id: cashbookId },
                data: {
                    balance: isIncome
                        ? { increment: amount }
                        : { decrement: amount },
                    totalIncome: isIncome ? { increment: amount } : undefined,
                    totalExpense: !isIncome ? { increment: amount } : undefined,
                },
            });

            const balanceAfter = isIncome
                ? balanceBefore.add(amount)
                : balanceBefore.sub(amount);

            // Create entry audit
            await tx.entryAudit.create({
                data: {
                    entryId: newEntry.id,
                    userId,
                    action: 'CREATED',
                    newValues: {
                        type: dto.type,
                        amount: dto.amount,
                        description: dto.description,
                        entryDate: dto.entryDate,
                    },
                },
            });

            // Financial audit log
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    cashbookId,
                    entryId: newEntry.id,
                    action: AuditAction.ENTRY_CREATED,
                    amount,
                    balanceBefore,
                    balanceAfter,
                    details: {
                        type: dto.type,
                        description: dto.description,
                    },
                },
            });

            return newEntry;
        });

        return entry;
    }

    // ─── Update Entry ─────────────────────────────────
    async updateEntry(entryId: string, userId: string, dto: UpdateEntryDto) {
        const entry = await entriesRepository.findById(entryId);
        if (!entry || entry.isDeleted) {
            throw new NotFoundError('Entry');
        }

        const cashbook = await prisma.cashbook.findUnique({
            where: { id: entry.cashbookId },
        });

        if (!cashbook) {
            throw new NotFoundError('Cashbook');
        }

        // Backdate check for new date
        if (dto.entryDate) {
            const newDate = new Date(dto.entryDate);
            if (!cashbook.allowBackdate && isDateInPast(newDate)) {
                throw new AppError(
                    'Backdated entries are not allowed for this cashbook',
                    400,
                    'BACKDATE_NOT_ALLOWED'
                );
            }
        }

        const oldValues: Record<string, any> = {};
        const newValues: Record<string, any> = {};
        const changes: Record<string, { from: any; to: any }> = {};

        // Track changes
        if (dto.type && dto.type !== entry.type) {
            oldValues.type = entry.type;
            newValues.type = dto.type;
            changes.type = { from: entry.type, to: dto.type };
        }
        if (dto.amount && dto.amount !== entry.amount.toString()) {
            oldValues.amount = entry.amount.toString();
            newValues.amount = dto.amount;
            changes.amount = { from: entry.amount.toString(), to: dto.amount };
        }
        if (dto.description && dto.description !== entry.description) {
            oldValues.description = entry.description;
            newValues.description = dto.description;
            changes.description = { from: entry.description, to: dto.description };
        }
        if (dto.entryDate) {
            oldValues.entryDate = entry.entryDate.toISOString();
            newValues.entryDate = dto.entryDate;
            changes.entryDate = { from: entry.entryDate.toISOString(), to: dto.entryDate };
        }

        const updated = await prisma.$transaction(async (tx) => {
            // Reverse old entry effect on balance
            const wasIncome = entry.type === EntryType.INCOME;
            const oldAmount = entry.amount;
            const balanceBefore = cashbook.balance;

            // Remove old amount from balance
            await tx.cashbook.update({
                where: { id: entry.cashbookId },
                data: {
                    balance: wasIncome
                        ? { decrement: oldAmount }
                        : { increment: oldAmount },
                    totalIncome: wasIncome ? { decrement: oldAmount } : undefined,
                    totalExpense: !wasIncome ? { decrement: oldAmount } : undefined,
                },
            });

            // Apply new amount
            const newType = dto.type || entry.type;
            const newAmount = dto.amount ? new Decimal(dto.amount) : entry.amount;
            const isIncome = newType === EntryType.INCOME;

            await tx.cashbook.update({
                where: { id: entry.cashbookId },
                data: {
                    balance: isIncome
                        ? { increment: newAmount }
                        : { decrement: newAmount },
                    totalIncome: isIncome ? { increment: newAmount } : undefined,
                    totalExpense: !isIncome ? { increment: newAmount } : undefined,
                },
            });

            // Calculate new balance
            let balanceAfter = wasIncome
                ? balanceBefore.sub(oldAmount)
                : balanceBefore.add(oldAmount);
            balanceAfter = isIncome
                ? balanceAfter.add(newAmount)
                : balanceAfter.sub(newAmount);

            // Update entry
            const updatedEntry = await tx.entry.update({
                where: { id: entryId },
                data: {
                    ...(dto.type && { type: dto.type as any }),
                    ...(dto.amount && { amount: new Decimal(dto.amount) }),
                    ...(dto.description && { description: dto.description }),
                    ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
                    ...(dto.contactId !== undefined && { contactId: dto.contactId }),
                    ...(dto.paymentModeId !== undefined && { paymentModeId: dto.paymentModeId }),
                    ...(dto.entryDate && { entryDate: new Date(dto.entryDate) }),
                    version: { increment: 1 },
                },
                include: {
                    category: true,
                    contact: true,
                    paymentMode: true,
                    createdBy: {
                        select: { id: true, email: true, firstName: true, lastName: true },
                    },
                },
            });

            // Audit trail (immutable record of the edit)
            await tx.entryAudit.create({
                data: {
                    entryId,
                    userId,
                    action: 'UPDATED',
                    changes,
                    oldValues,
                    newValues,
                },
            });

            // Financial audit log
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    cashbookId: entry.cashbookId,
                    entryId,
                    action: AuditAction.ENTRY_UPDATED,
                    amount: newAmount,
                    balanceBefore,
                    balanceAfter,
                    details: { changes },
                },
            });

            return updatedEntry;
        });

        return updated;
    }

    // ─── Delete Entry (Owner / with permission) ────────
    async deleteEntry(
        entryId: string,
        userId: string,
        reason: string,
        userRole: CashbookRole
    ) {
        const entry = await entriesRepository.findById(entryId);
        if (!entry || entry.isDeleted) {
            throw new NotFoundError('Entry');
        }

        const canDelete = hasPermission(userRole, CashbookPermission.DELETE_ENTRY);
        const canApproveDelete = hasPermission(userRole, CashbookPermission.APPROVE_DELETE);

        // Users who can both delete and approve → direct delete
        if (canDelete && canApproveDelete) {
            await this.performDeletion(entry, userId, reason);
            return { action: 'DELETED', message: 'Entry deleted successfully' };
        }

        // Users who can only delete → create delete request
        if (canDelete) {
            // Check for existing pending request
            const existing = await entriesRepository.findPendingDeleteRequest(entryId);
            if (existing) {
                throw new ConflictError('A delete request is already pending for this entry');
            }

            const request = await entriesRepository.createDeleteRequest({
                entryId,
                requesterId: userId,
                reason,
            });

            const cashbook = await prisma.cashbook.findUnique({
                where: { id: entry.cashbookId },
                select: { workspaceId: true },
            });

            await prisma.auditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook?.workspaceId,
                    action: AuditAction.ENTRY_DELETE_REQUESTED,
                    resource: 'entry',
                    resourceId: entryId,
                    details: { reason } as any,
                },
            });

            return { action: 'REQUEST_CREATED', message: 'Delete request submitted for approval', data: request };
        }

        throw new AppError('You do not have permission to delete entries', 403, 'AUTHORIZATION_ERROR');
    }

    // ─── Review Delete Request ─────────────────────────
    async reviewDeleteRequest(
        requestId: string,
        reviewerId: string,
        dto: ReviewDeleteRequestDto
    ) {
        const request = await entriesRepository.findDeleteRequestById(requestId);
        if (!request) {
            throw new NotFoundError('Delete request');
        }

        if (request.status !== 'PENDING') {
            throw new AppError('This request has already been reviewed', 400, 'ALREADY_REVIEWED');
        }

        if (request.requesterId === reviewerId) {
            throw new AppError('You cannot review your own delete request', 400, 'SELF_REVIEW');
        }

        await entriesRepository.updateDeleteRequest(requestId, {
            status: dto.status,
            reviewerId,
            reviewNote: dto.reviewNote,
        });

        const action = dto.status === 'APPROVED'
            ? AuditAction.ENTRY_DELETE_APPROVED
            : AuditAction.ENTRY_DELETE_REJECTED;

        const cashbook = request.entry?.cashbook;

        await prisma.auditLog.create({
            data: {
                userId: reviewerId,
                workspaceId: cashbook?.workspaceId,
                action,
                resource: 'delete_request',
                resourceId: requestId,
                details: {
                    entryId: request.entryId,
                    status: dto.status,
                    reviewNote: dto.reviewNote,
                } as any,
            },
        });

        // If approved, perform the actual deletion
        if (dto.status === 'APPROVED' && request.entry) {
            await this.performDeletion(request.entry, reviewerId, request.reason);
        }

        return { message: `Delete request ${dto.status.toLowerCase()}` };
    }

    // ─── Get Delete Requests ──────────────────────────
    async getDeleteRequests(cashbookId: string, status?: string) {
        return entriesRepository.findDeleteRequestsByCashbook(cashbookId, status);
    }

    // ─── Get Entry Audit Trail ─────────────────────────
    async getEntryAuditTrail(entryId: string) {
        const entry = await entriesRepository.findById(entryId);
        if (!entry) {
            throw new NotFoundError('Entry');
        }
        return entriesRepository.getEntryAudits(entryId);
    }

    // ─── Internal: Perform Deletion ────────────────────
    private async performDeletion(entry: any, userId: string, reason: string) {
        const cashbook = await prisma.cashbook.findUnique({
            where: { id: entry.cashbookId },
        });

        if (!cashbook) {
            throw new NotFoundError('Cashbook');
        }

        await prisma.$transaction(async (tx) => {
            const balanceBefore = cashbook.balance;
            const wasIncome = entry.type === EntryType.INCOME;
            const amount = entry.amount;

            // Reverse the entry effect on balance
            await tx.cashbook.update({
                where: { id: entry.cashbookId },
                data: {
                    balance: wasIncome
                        ? { decrement: amount }
                        : { increment: amount },
                    totalIncome: wasIncome ? { decrement: amount } : undefined,
                    totalExpense: !wasIncome ? { decrement: amount } : undefined,
                },
            });

            const balanceAfter = wasIncome
                ? balanceBefore.sub(amount)
                : balanceBefore.add(amount);

            // Soft-delete the entry
            await tx.entry.update({
                where: { id: entry.id },
                data: {
                    isDeleted: true,
                    deletedAt: new Date(),
                    deletedReason: reason,
                },
            });

            // Entry audit
            await tx.entryAudit.create({
                data: {
                    entryId: entry.id,
                    userId,
                    action: 'DELETED',
                    oldValues: {
                        type: entry.type,
                        amount: entry.amount.toString(),
                        description: entry.description,
                    },
                },
            });

            // Financial audit log
            await tx.financialAuditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    cashbookId: entry.cashbookId,
                    entryId: entry.id,
                    action: AuditAction.ENTRY_DELETED,
                    amount,
                    balanceBefore,
                    balanceAfter,
                    reason,
                    details: {
                        type: entry.type,
                        description: entry.description,
                    },
                },
            });
        });
    }
}
