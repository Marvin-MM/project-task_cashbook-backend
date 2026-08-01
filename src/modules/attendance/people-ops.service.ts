/**
 * Overtime requests, attendance flags and periodic work reports.
 *
 * Three small workflows that share one shape — asked for, then decided — and
 * one rule: the decision is claimed with a compare-and-swap before anything
 * downstream happens, so two approvers can never both act on the same row.
 */
import { injectable, inject } from 'tsyringe';
import {
    ApprovalStatus,
    AttendanceFlagStatus,
    AttendanceFlagType,
    OvertimeRequestType,
    PrismaClient,
    WorkReportPeriod,
} from '@prisma/client';
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
import { clockFor, toDateColumn } from '../../core/time/workspace-clock';
import { notificationsQueue } from '../../config/queues';
import type {
    CreateOvertimeRequestDto,
    ReviewOvertimeDto,
    ReviewWorkReportDto,
    SubmitWorkReportDto,
    WaiveFlagDto,
} from './attendance.dto';

@injectable()
export class PeopleOpsService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    private can(workspaceId: string, userId: string, permission: WorkspacePermission) {
        return workspaceUserCan(this.prisma, workspaceId, userId, permission);
    }

    // ─── Overtime ─────────────────────────────────────────────

    /**
     * Ask to work past the scheduled end, or account for having done so.
     *
     * Both directions matter: PLANNED is permission in advance, RETROACTIVE is
     * the case where somebody stayed late and now needs those minutes counted.
     * Without the second, every unplanned late night is unrecoverable.
     */
    async requestOvertime(workspaceId: string, userId: string, dto: CreateOvertimeRequestDto) {
        try {
            const request = await this.prisma.$transaction(async (tx) => {
                const created = await tx.overtimeRequest.create({
                    data: {
                        workspaceId,
                        userId,
                        businessDate: toDateColumn(dto.businessDate),
                        type: dto.type ?? OvertimeRequestType.PLANNED,
                        requestedMinutes: dto.requestedMinutes,
                        reason: dto.reason,
                    },
                });
                await tx.auditLog.create({
                    data: {
                        userId,
                        workspaceId,
                        action: AuditAction.OVERTIME_REQUESTED,
                        resource: 'overtime_request',
                        resourceId: created.id,
                        details: { minutes: dto.requestedMinutes, date: dto.businessDate } as any,
                    },
                });
                return created;
            });

            await this.notifyApprovers(workspaceId, userId, WorkspacePermission.APPROVE_OVERTIME, {
                type: 'OVERTIME_REQUESTED',
                title: 'An overtime request needs a decision',
                body: `${Math.round(dto.requestedMinutes / 6) / 10}h on ${dto.businessDate}: ${dto.reason}`,
                entityType: 'OVERTIME_REQUEST',
                entityId: request.id,
                groupKey: `overtime:${request.id}`,
            });
            return request;
        } catch (error: any) {
            // overtime_requests_one_pending
            if (error?.code === 'P2002') {
                throw new ConflictError('You already have a request awaiting a decision for that day.');
            }
            throw error;
        }
    }

    async reviewOvertime(
        requestId: string,
        workspaceId: string,
        userId: string,
        dto: ReviewOvertimeDto,
    ) {
        if (!(await this.can(workspaceId, userId, WorkspacePermission.APPROVE_OVERTIME))) {
            throw new AuthorizationError('You cannot decide overtime requests in this workspace');
        }

        const request = await this.prisma.overtimeRequest.findUnique({ where: { id: requestId } });
        if (!request || request.workspaceId !== workspaceId) throw new NotFoundError('Overtime request');
        if (request.status !== ApprovalStatus.PENDING) {
            throw new ConflictError('That request has already been decided.');
        }
        if (!dto.approve && !dto.reviewNote?.trim()) {
            throw new AppError('Say why the request is declined.', 400, 'REVIEW_NOTE_REQUIRED');
        }

        // An approver may grant less than was asked for, never more — the CHECK
        // enforces it too, but a clear error beats a constraint violation.
        const approvedMinutes = dto.approve
            ? Math.min(dto.approvedMinutes ?? request.requestedMinutes, request.requestedMinutes)
            : null;

        const decided = await this.prisma.$transaction(async (tx) => {
            const claimed = await tx.overtimeRequest.updateMany({
                where: { id: requestId, status: ApprovalStatus.PENDING, version: request.version },
                data: {
                    status: dto.approve ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
                    approvedMinutes,
                    reviewerId: userId,
                    reviewNote: dto.reviewNote ?? null,
                    reviewedAt: new Date(),
                    version: { increment: 1 },
                },
            });
            if (claimed.count === 0) throw new ConflictError('That request has already been decided.');

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: dto.approve
                        ? AuditAction.OVERTIME_APPROVED
                        : AuditAction.OVERTIME_REJECTED,
                    resource: 'overtime_request',
                    resourceId: requestId,
                    details: { approvedMinutes } as any,
                },
            });
            return tx.overtimeRequest.findUniqueOrThrow({ where: { id: requestId } });
        });

        // Approved overtime changes what counts on that day, so the rollup for
        // it is now stale. Recomputing is the rollup service's job; flagging it
        // here keeps this service out of that dependency.
        void this.dispatch({
            userId: request.userId,
            workspaceId,
            type: 'OVERTIME_DECIDED',
            title: dto.approve ? 'Your overtime was approved' : 'Your overtime was declined',
            body: dto.approve
                ? `${Math.round((approvedMinutes ?? 0) / 6) / 10}h approved.`
                : (dto.reviewNote ?? 'Declined.'),
            entityType: 'OVERTIME_REQUEST',
            entityId: requestId,
            groupKey: `overtime-decided:${requestId}`,
        });

        return decided;
    }

    async listOvertime(
        workspaceId: string,
        userId: string,
        query: { status?: ApprovalStatus; mine?: boolean },
    ) {
        const canSeeAll = await this.can(workspaceId, userId, WorkspacePermission.APPROVE_OVERTIME);
        return this.prisma.overtimeRequest.findMany({
            where: {
                workspaceId,
                status: query.status,
                userId: canSeeAll && !query.mine ? undefined : userId,
            },
            include: {
                user: { select: { id: true, firstName: true, lastName: true, email: true } },
                reviewer: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: { businessDate: 'desc' },
            take: 200,
        });
    }

    /**
     * Minutes of overtime approved for a person on a day.
     *
     * Used by the rollup to decide `countedOvertimeMinutes` when the workspace
     * does not track overtime by default: an approved request is the exception
     * that makes those minutes count.
     */
    async approvedOvertimeMinutes(
        workspaceId: string,
        userId: string,
        businessDate: Date,
    ): Promise<number | null> {
        const approved = await this.prisma.overtimeRequest.findFirst({
            where: { workspaceId, userId, businessDate, status: ApprovalStatus.APPROVED },
            select: { approvedMinutes: true },
        });
        return approved?.approvedMinutes ?? null;
    }

    // ─── Attendance flags ─────────────────────────────────────

    /**
     * Raise a flag, at most once per scope.
     *
     * Idempotent by index: day-scoped flags collapse on
     * (workspace, user, date, type) and session-scoped ones on (session, type),
     * so a job that runs twice does not double-flag anybody. Uses createMany
     * with skipDuplicates because those indexes are partial and Prisma cannot
     * express them as compound keys for upsert.
     */
    async raiseFlag(input: {
        workspaceId: string;
        userId: string;
        businessDate: Date;
        type: AttendanceFlagType;
        minutes?: number;
        sessionId?: string;
        detail?: Record<string, unknown>;
    }): Promise<boolean> {
        const created = await this.prisma.attendanceFlag.createMany({
            data: [{
                workspaceId: input.workspaceId,
                userId: input.userId,
                businessDate: input.businessDate,
                type: input.type,
                minutes: input.minutes ?? null,
                sessionId: input.sessionId ?? null,
                detail: (input.detail ?? undefined) as never,
            }],
            skipDuplicates: true,
        });
        return created.count > 0;
    }

    async listFlags(
        workspaceId: string,
        userId: string,
        query: { from?: string; to?: string; userId?: string; status?: AttendanceFlagStatus },
    ) {
        const canSeeAll = await this.can(
            workspaceId, userId, WorkspacePermission.VIEW_ALL_ATTENDANCE,
        );
        return this.prisma.attendanceFlag.findMany({
            where: {
                workspaceId,
                status: query.status,
                userId: canSeeAll ? query.userId : userId,
                ...(query.from || query.to
                    ? {
                        businessDate: {
                            ...(query.from ? { gte: toDateColumn(query.from) } : {}),
                            ...(query.to ? { lte: toDateColumn(query.to) } : {}),
                        },
                    }
                    : {}),
            },
            include: {
                user: { select: { id: true, firstName: true, lastName: true } },
                waivedBy: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: { businessDate: 'desc' },
            take: 200,
        });
    }

    /**
     * Cancel a flag, with a reason.
     *
     * Owner and admin only. HR owns the attendance policy, so letting them
     * erase breaches of it puts the same person on both sides — and the reason
     * is required by the schema, not just by this method, so a waiver can never
     * be unexplained.
     */
    async waiveFlag(flagId: string, workspaceId: string, userId: string, dto: WaiveFlagDto) {
        if (!(await this.can(workspaceId, userId, WorkspacePermission.WAIVE_ATTENDANCE_FLAG))) {
            throw new AuthorizationError('Only an owner or admin can waive an attendance flag');
        }

        const waived = await this.prisma.$transaction(async (tx) => {
            const claimed = await tx.attendanceFlag.updateMany({
                where: { id: flagId, workspaceId, status: AttendanceFlagStatus.ACTIVE },
                data: {
                    status: AttendanceFlagStatus.WAIVED,
                    waivedById: userId,
                    waivedAt: new Date(),
                    waiverReason: dto.reason,
                },
            });
            if (claimed.count === 0) throw new NotFoundError('Active flag');

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.ATTENDANCE_FLAG_WAIVED,
                    resource: 'attendance_flag',
                    resourceId: flagId,
                    details: { reason: dto.reason } as any,
                },
            });
            return tx.attendanceFlag.findUniqueOrThrow({ where: { id: flagId } });
        });
        return waived;
    }

    // ─── Work reports ─────────────────────────────────────────

    /**
     * Submit a daily or monthly report.
     *
     * Auto-approved when the author could approve reports anyway — asking HR to
     * rubber-stamp their own is theatre. Recorded as `autoApproved` rather than
     * silently, so the queue does not appear to be missing them.
     *
     * `metrics` snapshots the hours at submission. Without it, editing a time
     * entry weeks later would change what a reviewer already signed off.
     */
    async submitWorkReport(workspaceId: string, userId: string, dto: SubmitWorkReportDto) {
        const clock = await clockFor(this.prisma, workspaceId);
        const periodStart = dto.periodStart;
        const periodEnd = dto.period === WorkReportPeriod.DAILY
            ? periodStart
            : clock.monthRange(periodStart).end;

        const isSelfApproving = await this.can(
            workspaceId, userId, WorkspacePermission.APPROVE_WORK_REPORT,
        );

        const metrics = await this.periodMetrics(workspaceId, userId, periodStart, periodEnd);
        const now = new Date();

        const report = await this.prisma.workReport.upsert({
            where: {
                workspaceId_userId_period_periodStart: {
                    workspaceId,
                    userId,
                    period: dto.period,
                    periodStart: toDateColumn(periodStart),
                },
            },
            create: {
                workspaceId,
                userId,
                period: dto.period,
                periodStart: toDateColumn(periodStart),
                periodEnd: toDateColumn(periodEnd),
                summary: dto.summary,
                blockers: dto.blockers ?? null,
                nextSteps: dto.nextSteps ?? null,
                metrics: metrics as never,
                status: isSelfApproving ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING,
                autoApproved: isSelfApproving,
                reviewedAt: isSelfApproving ? now : null,
                reviewerId: isSelfApproving ? userId : null,
                submittedAt: now,
            },
            // Resubmitting replaces rather than stacking up near-duplicates in
            // the reviewer's queue, and re-opens a report that was sent back.
            update: {
                summary: dto.summary,
                blockers: dto.blockers ?? null,
                nextSteps: dto.nextSteps ?? null,
                metrics: metrics as never,
                status: isSelfApproving ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING,
                autoApproved: isSelfApproving,
                reviewedAt: isSelfApproving ? now : null,
                reviewerId: isSelfApproving ? userId : null,
                reviewNote: null,
                submittedAt: now,
                version: { increment: 1 },
            },
        });

        if (!isSelfApproving) {
            await this.notifyApprovers(
                workspaceId, userId, WorkspacePermission.APPROVE_WORK_REPORT,
                {
                    type: 'WORK_REPORT_SUBMITTED',
                    title: 'A work report needs review',
                    body: `${dto.period === 'DAILY' ? 'Daily' : 'Monthly'} report for ${periodStart}.`,
                    entityType: 'WORK_REPORT',
                    entityId: report.id,
                    groupKey: `work-report:${report.id}`,
                },
            );
        }
        return report;
    }

    async reviewWorkReport(
        reportId: string,
        workspaceId: string,
        userId: string,
        dto: ReviewWorkReportDto,
    ) {
        if (!(await this.can(workspaceId, userId, WorkspacePermission.APPROVE_WORK_REPORT))) {
            throw new AuthorizationError('You cannot review work reports in this workspace');
        }

        const report = await this.prisma.workReport.findUnique({ where: { id: reportId } });
        if (!report || report.workspaceId !== workspaceId) throw new NotFoundError('Work report');
        if (report.status !== ApprovalStatus.PENDING) {
            throw new ConflictError('That report has already been reviewed.');
        }
        if (!dto.approve && !dto.reviewNote?.trim()) {
            throw new AppError(
                'Say what needs changing, so the author knows what to fix.',
                400,
                'REVIEW_NOTE_REQUIRED',
            );
        }

        const decided = await this.prisma.$transaction(async (tx) => {
            const claimed = await tx.workReport.updateMany({
                where: { id: reportId, status: ApprovalStatus.PENDING, version: report.version },
                data: {
                    status: dto.approve ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
                    reviewerId: userId,
                    reviewNote: dto.reviewNote ?? null,
                    reviewedAt: new Date(),
                    version: { increment: 1 },
                },
            });
            if (claimed.count === 0) throw new ConflictError('That report has already been reviewed.');

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: dto.approve
                        ? AuditAction.WORK_REPORT_APPROVED
                        : AuditAction.WORK_REPORT_REJECTED,
                    resource: 'work_report',
                    resourceId: reportId,
                },
            });
            return tx.workReport.findUniqueOrThrow({ where: { id: reportId } });
        });

        void this.dispatch({
            userId: report.userId,
            workspaceId,
            type: 'WORK_REPORT_DECIDED',
            title: dto.approve ? 'Your report was approved' : 'Your report was sent back',
            body: dto.approve ? 'Nothing further needed.' : (dto.reviewNote ?? ''),
            entityType: 'WORK_REPORT',
            entityId: reportId,
            groupKey: `work-report-decided:${reportId}`,
        });

        return decided;
    }

    async listWorkReports(
        workspaceId: string,
        userId: string,
        query: { period?: WorkReportPeriod; status?: ApprovalStatus; mine?: boolean },
    ) {
        const canSeeAll = await this.can(
            workspaceId, userId, WorkspacePermission.APPROVE_WORK_REPORT,
        );
        return this.prisma.workReport.findMany({
            where: {
                workspaceId,
                period: query.period,
                status: query.status,
                userId: canSeeAll && !query.mine ? undefined : userId,
            },
            include: {
                user: { select: { id: true, firstName: true, lastName: true, email: true } },
                reviewer: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: { periodStart: 'desc' },
            take: 200,
        });
    }

    /** Hours and sessions in the period, frozen into the report at submission. */
    private async periodMetrics(
        workspaceId: string,
        userId: string,
        from: string,
        to: string,
    ) {
        const [days, entries] = await Promise.all([
            this.prisma.attendanceDay.aggregate({
                where: {
                    workspaceId,
                    userId,
                    businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
                },
                _sum: { workedMinutes: true, countedOvertimeMinutes: true },
                _count: true,
            }),
            this.prisma.timeEntry.aggregate({
                where: {
                    workspaceId,
                    userId,
                    businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
                    endTime: { not: null },
                },
                _sum: { durationMinutes: true },
            }),
        ]);

        return {
            workedMinutes: days._sum.workedMinutes ?? 0,
            overtimeMinutes: days._sum.countedOvertimeMinutes ?? 0,
            daysRecorded: days._count,
            trackedMinutes: entries._sum.durationMinutes ?? 0,
            snapshotAt: new Date().toISOString(),
        };
    }

    // ─── Notifications ────────────────────────────────────────

    private dispatch(data: Record<string, unknown>) {
        return notificationsQueue.add(data.type as string, data).catch(() => { });
    }

    private async notifyApprovers(
        workspaceId: string,
        actorId: string,
        permission: WorkspacePermission,
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
            if (hasWorkspacePermission(member.role as WorkspaceRole, permission)) {
                recipients.add(member.userId);
            }
        }
        recipients.delete(actorId);

        await Promise.all(
            [...recipients].map((userId) => this.dispatch({ ...payload, userId, workspaceId })),
        );
    }
}
