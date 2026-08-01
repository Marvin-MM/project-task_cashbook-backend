/**
 * Time off: requested by anyone, decided by HR, an owner or an admin.
 *
 * The design decision that shapes this file: approved leave is *materialised*
 * one row per day into `leave_days`. Two things fall out of it.
 *
 *   "Is this person expected today" becomes an indexed lookup on
 *   (workspace, user, date) rather than range arithmetic that has to reason
 *   about half-days at either end.
 *
 *   Double-booking becomes impossible. The unique index rejects the second
 *   write even when two approvals commit at the same instant — which no
 *   overlap check in a service can promise, because the check and the write
 *   are two statements.
 */
import { injectable, inject } from 'tsyringe';
import { ApprovalStatus, LeaveDayPortion, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import {
    AppError,
    AuthorizationError,
    ConflictError,
    NotFoundError,
} from '../../core/errors/AppError';
import { AuditAction, WorkspaceRole } from '../../core/types';
import {
    WorkspacePermission,
    hasWorkspacePermission,
} from '../../core/types/workspace-permissions';
import { workspaceUserCan } from '../../core/authz/workspace-access';
import { clockFor, toDateColumn, type BusinessDate } from '../../core/time/workspace-clock';
import { resolveSchedule } from '../../core/time/schedule-resolver';
import { notificationsQueue } from '../../config/queues';
import type { CreateLeaveRequestDto, ReviewLeaveDto } from './attendance.dto';

@injectable()
export class LeaveService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    private can(workspaceId: string, userId: string, permission: WorkspacePermission) {
        return workspaceUserCan(this.prisma, workspaceId, userId, permission);
    }

    async listTypes(workspaceId: string) {
        return this.prisma.leaveType.findMany({
            where: { workspaceId, isActive: true },
            orderBy: { sortOrder: 'asc' },
        });
    }

    // ─── Requesting ───────────────────────────────────────────

    /**
     * Ask for time off.
     *
     * The day count skips non-working days and holidays, so a Friday-to-Monday
     * request over a normal weekend is two days, not four — anything else makes
     * an allowance meaningless.
     */
    async requestLeave(workspaceId: string, userId: string, dto: CreateLeaveRequestDto) {
        const leaveType = await this.prisma.leaveType.findFirst({
            where: { id: dto.leaveTypeId, workspaceId, isActive: true },
        });
        if (!leaveType) throw new NotFoundError('Leave type');

        if (dto.endDate < dto.startDate) {
            throw new AppError('The end date is before the start date.', 400, 'INVALID_RANGE');
        }

        const days = await this.workingDaysIn(workspaceId, userId, dto);
        if (days.length === 0) {
            throw new AppError(
                'That range has no working days in it.',
                400,
                'NO_WORKING_DAYS',
            );
        }

        // Cheap pre-check for a good message. The unique on leave_days is what
        // actually guarantees it, at approval time.
        const clash = await this.prisma.leaveDay.findFirst({
            where: { workspaceId, userId, date: { in: days.map((d) => d.column) } },
            include: { request: { select: { id: true } } },
        });
        if (clash) {
            throw new ConflictError('You already have approved leave inside that range.');
        }

        const totalDays = days.reduce(
            (sum, day) => sum + (day.portion === LeaveDayPortion.FULL ? 1 : 0.5),
            0,
        );

        const request = await this.prisma.$transaction(async (tx) => {
            const created = await tx.leaveRequest.create({
                data: {
                    workspaceId,
                    userId,
                    leaveTypeId: dto.leaveTypeId,
                    startDate: toDateColumn(dto.startDate),
                    endDate: toDateColumn(dto.endDate),
                    startPortion: dto.startPortion ?? LeaveDayPortion.FULL,
                    endPortion: dto.endPortion ?? LeaveDayPortion.FULL,
                    totalDays: new Decimal(totalDays),
                    reason: dto.reason,
                },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.LEAVE_REQUESTED,
                    resource: 'leave_request',
                    resourceId: created.id,
                    details: { from: dto.startDate, to: dto.endDate, days: totalDays } as any,
                },
            });
            return created;
        });

        await this.notifyApprovers(workspaceId, userId, {
            type: 'LEAVE_REQUESTED',
            title: 'A leave request needs a decision',
            body: `${leaveType.name}, ${dto.startDate} to ${dto.endDate} (${totalDays} day(s)).`,
            entityType: 'LEAVE_REQUEST',
            entityId: request.id,
            groupKey: `leave:${request.id}`,
        });

        return request;
    }

    async withdrawLeave(requestId: string, workspaceId: string, userId: string) {
        const claimed = await this.prisma.leaveRequest.updateMany({
            where: { id: requestId, workspaceId, userId, status: ApprovalStatus.PENDING },
            data: { status: ApprovalStatus.WITHDRAWN },
        });
        if (claimed.count === 0) throw new NotFoundError('Pending leave request');
        return this.prisma.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
    }

    /**
     * Cancel leave that was already approved.
     *
     * Deletes the materialised days as well, or the person stays "on leave" in
     * every rollup and monitoring view forever.
     */
    async cancelApprovedLeave(requestId: string, workspaceId: string, userId: string) {
        const request = await this.prisma.leaveRequest.findUnique({ where: { id: requestId } });
        if (!request || request.workspaceId !== workspaceId) throw new NotFoundError('Leave request');

        const isOwn = request.userId === userId;
        if (!isOwn && !(await this.can(workspaceId, userId, WorkspacePermission.APPROVE_LEAVE))) {
            throw new AuthorizationError('You cannot cancel this leave');
        }
        if (request.status !== ApprovalStatus.APPROVED) {
            throw new ConflictError('That request is not approved.');
        }

        return this.prisma.$transaction(async (tx) => {
            await tx.leaveDay.deleteMany({ where: { leaveRequestId: requestId } });
            await tx.leaveRequest.update({
                where: { id: requestId },
                data: { status: ApprovalStatus.WITHDRAWN },
            });
            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.LEAVE_CANCELLED,
                    resource: 'leave_request',
                    resourceId: requestId,
                },
            });
            return tx.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
        });
    }

    // ─── Deciding ─────────────────────────────────────────────

    /**
     * Approve or decline. Approving materialises the days.
     *
     * An approved day that clashes with existing leave hits the unique index
     * and the whole transaction rolls back — a request is approved entirely or
     * not at all, never leaving half a holiday booked.
     */
    async reviewLeave(
        requestId: string,
        workspaceId: string,
        userId: string,
        dto: ReviewLeaveDto,
    ) {
        if (!(await this.can(workspaceId, userId, WorkspacePermission.APPROVE_LEAVE))) {
            throw new AuthorizationError('You cannot decide leave requests in this workspace');
        }

        const request = await this.prisma.leaveRequest.findUnique({
            where: { id: requestId },
            include: { leaveType: true },
        });
        if (!request || request.workspaceId !== workspaceId) throw new NotFoundError('Leave request');
        if (request.status !== ApprovalStatus.PENDING) {
            throw new ConflictError('That request has already been decided.');
        }
        if (!dto.approve && !dto.reviewNote?.trim()) {
            throw new AppError('Say why the request is declined.', 400, 'REVIEW_NOTE_REQUIRED');
        }

        const days = dto.approve
            ? await this.workingDaysIn(workspaceId, request.userId, {
                startDate: request.startDate.toISOString().slice(0, 10),
                endDate: request.endDate.toISOString().slice(0, 10),
                startPortion: request.startPortion,
                endPortion: request.endPortion,
            })
            : [];

        try {
            const decided = await this.prisma.$transaction(async (tx) => {
                const claimed = await tx.leaveRequest.updateMany({
                    where: {
                        id: requestId,
                        status: ApprovalStatus.PENDING,
                        version: request.version,
                    },
                    data: {
                        status: dto.approve ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
                        reviewerId: userId,
                        reviewNote: dto.reviewNote ?? null,
                        reviewedAt: new Date(),
                        version: { increment: 1 },
                    },
                });
                if (claimed.count === 0) {
                    throw new ConflictError('That request has already been decided.');
                }

                if (dto.approve && days.length > 0) {
                    await tx.leaveDay.createMany({
                        data: days.map((day) => ({
                            leaveRequestId: requestId,
                            workspaceId,
                            userId: request.userId,
                            date: day.column,
                            portion: day.portion,
                        })),
                    });
                }

                await tx.auditLog.create({
                    data: {
                        userId,
                        workspaceId,
                        action: dto.approve ? AuditAction.LEAVE_APPROVED : AuditAction.LEAVE_REJECTED,
                        resource: 'leave_request',
                        resourceId: requestId,
                        details: { days: days.length } as any,
                    },
                });

                return tx.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
            });

            // Sessions already recorded inside the range are NOT deleted — they
            // are evidence that somebody worked. Flagged for HR instead.
            if (dto.approve) await this.noteWorkedLeaveDays(workspaceId, request.userId, requestId, days);

            void this.dispatch({
                userId: request.userId,
                workspaceId,
                type: 'LEAVE_DECIDED',
                title: dto.approve ? 'Your leave was approved' : 'Your leave was declined',
                body: dto.approve
                    ? `${request.leaveType.name} is booked.`
                    : `${request.leaveType.name} was declined: ${dto.reviewNote}`,
                entityType: 'LEAVE_REQUEST',
                entityId: requestId,
                groupKey: `leave-decided:${requestId}`,
            });

            return decided;
        } catch (error: any) {
            // leave_days_workspace_id_user_id_date_key — somebody else's
            // approval got there first for one of these dates.
            if (error?.code === 'P2002') {
                throw new ConflictError(
                    'Some of those dates are already booked as leave. Nothing was changed.',
                );
            }
            throw error;
        }
    }

    // ─── Queries ──────────────────────────────────────────────

    async listRequests(
        workspaceId: string,
        userId: string,
        query: { status?: ApprovalStatus; mine?: boolean; userId?: string },
    ) {
        const canSeeAll = await this.can(workspaceId, userId, WorkspacePermission.APPROVE_LEAVE);
        return this.prisma.leaveRequest.findMany({
            where: {
                workspaceId,
                status: query.status,
                userId: canSeeAll && !query.mine ? query.userId : userId,
            },
            include: {
                leaveType: { select: { id: true, name: true, isPaid: true, colorHex: true } },
                user: { select: { id: true, firstName: true, lastName: true, email: true } },
                reviewer: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: { startDate: 'desc' },
            take: 200,
        });
    }

    /** Who is off on a given day — used by monitoring and the rollup. */
    async whoIsOnLeave(workspaceId: string, date: BusinessDate) {
        return this.prisma.leaveDay.findMany({
            where: { workspaceId, date: toDateColumn(date) },
            include: {
                request: {
                    select: {
                        leaveType: { select: { name: true, colorHex: true } },
                    },
                },
            },
        });
    }

    // ─── Internals ────────────────────────────────────────────

    /**
     * The days a request actually covers.
     *
     * Non-working days and holidays are skipped entirely — they are not leave,
     * they are days nobody was expected. Half-day portions only apply to the
     * first and last day of the range.
     */
    private async workingDaysIn(
        workspaceId: string,
        userId: string,
        dto: {
            startDate: string;
            endDate: string;
            startPortion?: LeaveDayPortion | null;
            endPortion?: LeaveDayPortion | null;
        },
    ): Promise<Array<{ date: BusinessDate; column: Date; portion: LeaveDayPortion }>> {
        const clock = await clockFor(this.prisma, workspaceId);
        const out: Array<{ date: BusinessDate; column: Date; portion: LeaveDayPortion }> = [];

        let cursor = dto.startDate;
        // Bounded so a malformed range cannot spin.
        for (let i = 0; cursor <= dto.endDate && i < 400; i += 1) {
            const schedule = await resolveSchedule(this.prisma, workspaceId, userId, cursor, clock);
            if (schedule.isWorkingDay) {
                const portion =
                    cursor === dto.startDate
                        ? dto.startPortion ?? LeaveDayPortion.FULL
                        : cursor === dto.endDate
                            ? dto.endPortion ?? LeaveDayPortion.FULL
                            : LeaveDayPortion.FULL;
                out.push({ date: cursor, column: toDateColumn(cursor), portion });
            }
            cursor = clock.addLocalDays(cursor, 1);
        }
        return out;
    }

    /**
     * Somebody already worked on a day that has just become leave.
     *
     * The sessions stay. Deleting evidence that work happened would be worse
     * than the inconsistency, and it is not this method's call to make. It is
     * recorded in the audit log for HR to reconcile — deliberately not as an
     * AttendanceFlag, because none of the flag types mean this and inventing a
     * misleading one is worse than a plain record of the facts.
     */
    private async noteWorkedLeaveDays(
        workspaceId: string,
        userId: string,
        requestId: string,
        days: Array<{ column: Date }>,
    ) {
        if (days.length === 0) return;

        const worked = await this.prisma.workSession.findMany({
            where: { workspaceId, userId, businessDate: { in: days.map((d) => d.column) } },
            select: { id: true, businessDate: true },
        });
        if (worked.length === 0) return;

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.LEAVE_APPROVED,
                resource: 'leave_request',
                resourceId: requestId,
                details: {
                    note: 'Approved leave overlaps days that were already worked',
                    sessionIds: worked.map((session) => session.id),
                    dates: worked.map((session) => session.businessDate.toISOString().slice(0, 10)),
                } as any,
            },
        }).catch(() => { /* reconciliation aid, never a reason to fail approval */ });
    }

    private dispatch(data: Record<string, unknown>) {
        return notificationsQueue.add(data.type as string, data).catch(() => { });
    }

    private async notifyApprovers(
        workspaceId: string,
        actorId: string,
        payload: Record<string, unknown>,
    ) {
        const [workspace, members] = await Promise.all([
            this.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { ownerId: true },
            }),
            this.prisma.workspaceMember.findMany({
                where: { workspaceId },
                select: { userId: true, role: true },
            }),
        ]);

        const recipients = new Set<string>();
        if (workspace?.ownerId) recipients.add(workspace.ownerId);
        for (const member of members) {
            if (hasWorkspacePermission(
                member.role as WorkspaceRole, WorkspacePermission.APPROVE_LEAVE,
            )) {
                recipients.add(member.userId);
            }
        }
        recipients.delete(actorId);

        await Promise.all(
            [...recipients].map((userId) => this.dispatch({ ...payload, userId, workspaceId })),
        );
    }
}
