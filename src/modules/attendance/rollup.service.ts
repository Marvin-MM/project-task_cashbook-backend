/**
 * The daily attendance rollup — the single writer of `attendance_days`.
 *
 * Why a table at all, when sessions are already stored:
 *
 *   Absence cannot be derived from rows that exist. "Who was missing on
 *   Tuesday" needs a day x member grid resolved against schedules, holidays and
 *   employment dates. There is no GROUP BY over work_sessions that produces a
 *   row for somebody who never clocked in.
 *
 *   Approvals need a stable snapshot. A monthly report approved in March must
 *   not change because somebody edited the schedule in June.
 *
 *   Cost. Thirty days across two hundred people is six thousand cells, each
 *   needing a schedule resolution, on a screen that gets polled.
 *
 * Guard rails, the same ones the ledger's cached balances use: one writer, full
 * recompute rather than deltas, and a rebuild script that can reproduce every
 * row from the sessions underneath.
 */
import { injectable, inject } from 'tsyringe';
import {
    AttendanceDayStatus,
    AttendanceFlagType,
    LeaveDayPortion,
    PrismaClient,
} from '@prisma/client';
import {
    BusinessDate,
    WorkspaceClock,
    clockFor,
    toDateColumn,
} from '../../core/time/workspace-clock';
import { resolveSchedule } from '../../core/time/schedule-resolver';

interface SessionAggregate {
    userId: string;
    workedMinutes: number;
    breakMinutes: number;
    rawOvertimeMinutes: number;
    countedOvertimeMinutes: number;
    firstClockIn: Date | null;
    lastClockOut: Date | null;
    sessionCount: number;
    lateMinutes: number;
}

@injectable()
export class AttendanceRollupService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    /**
     * Recompute one business date for every tracked member.
     *
     * Idempotent by construction: it reads the sessions, derives the whole row,
     * and upserts. Running it twice, or running it a year later, produces the
     * same answer — which is what makes the rebuild script safe.
     */
    async recomputeDay(workspaceId: string, businessDate: BusinessDate): Promise<number> {
        const clock = await clockFor(this.prisma, workspaceId);
        const dateColumn = toDateColumn(businessDate);

        const members = await this.trackedMembers(workspaceId, dateColumn);
        if (members.length === 0) return 0;

        const [sessions, billable, onLeave, settings] = await Promise.all([
            this.aggregateSessions(workspaceId, dateColumn),
            this.billableMinutes(workspaceId, dateColumn),
            this.leaveByUser(workspaceId, dateColumn),
            this.prisma.attendanceSettings.findUnique({
                where: { workspaceId },
                select: { overtimeTrackingEnabled: true, flagsEnabled: true },
            }),
        ]);

        let written = 0;
        for (const member of members) {
            const schedule = await resolveSchedule(
                this.prisma, workspaceId, member.userId, businessDate, clock,
            );
            const worked = sessions.get(member.userId);
            const leave = onLeave.get(member.userId);

            const status = this.classify(schedule, worked, leave);

            // Overtime counts when the workspace tracks it, or when a specific
            // request was approved for this day — the exception that makes an
            // otherwise-untracked late night payable.
            const raw = worked?.rawOvertimeMinutes ?? 0;
            const approved = await this.approvedOvertimeMinutes(
                workspaceId, member.userId, dateColumn,
            );
            const counted = settings?.overtimeTrackingEnabled
                ? raw
                : Math.min(raw, approved ?? 0);

            await this.prisma.attendanceDay.upsert({
                where: {
                    workspaceId_userId_businessDate: {
                        workspaceId,
                        userId: member.userId,
                        businessDate: dateColumn,
                    },
                },
                create: {
                    workspaceId,
                    userId: member.userId,
                    businessDate: dateColumn,
                    status,
                    expectedMinutes: schedule.expectedMinutes,
                    workedMinutes: worked?.workedMinutes ?? 0,
                    breakMinutes: worked?.breakMinutes ?? 0,
                    rawOvertimeMinutes: raw,
                    countedOvertimeMinutes: counted,
                    billableMinutes: billable.get(member.userId) ?? 0,
                    lateMinutes: worked?.lateMinutes ?? 0,
                    firstClockIn: worked?.firstClockIn ?? null,
                    lastClockOut: worked?.lastClockOut ?? null,
                    sessionCount: worked?.sessionCount ?? 0,
                    scheduleId: schedule.scheduleId,
                },
                // A full overwrite, never a delta — a partial update is how a
                // rollup drifts away from the rows it is supposed to summarise.
                update: {
                    status,
                    expectedMinutes: schedule.expectedMinutes,
                    workedMinutes: worked?.workedMinutes ?? 0,
                    breakMinutes: worked?.breakMinutes ?? 0,
                    rawOvertimeMinutes: raw,
                    countedOvertimeMinutes: counted,
                    billableMinutes: billable.get(member.userId) ?? 0,
                    lateMinutes: worked?.lateMinutes ?? 0,
                    firstClockIn: worked?.firstClockIn ?? null,
                    lastClockOut: worked?.lastClockOut ?? null,
                    sessionCount: worked?.sessionCount ?? 0,
                    scheduleId: schedule.scheduleId,
                    computedAt: new Date(),
                },
            });
            if (settings?.flagsEnabled !== false) {
                await this.raiseFlagsFor(
                    workspaceId, member.userId, dateColumn, status, worked,
                );
            }
            written += 1;
        }
        return written;
    }

    /**
     * Flags derived from the finished day.
     *
     * Only the ones that need hindsight live here — an absence is not knowable
     * until the day is over. LATE_IN is raised at clock-in so the badge appears
     * immediately; re-raising it here is harmless because the partial unique
     * index makes it idempotent.
     */
    private async raiseFlagsFor(
        workspaceId: string,
        userId: string,
        businessDate: Date,
        status: AttendanceDayStatus,
        worked: SessionAggregate | undefined,
    ) {
        if (status === AttendanceDayStatus.ABSENT) {
            await this.raiseFlag(workspaceId, userId, businessDate, 'ABSENT');
        }
        if (worked && worked.lateMinutes > 0) {
            await this.raiseFlag(workspaceId, userId, businessDate, 'LATE_IN', worked.lateMinutes);
        }
    }

    /**
     * skipDuplicates rather than upsert: the uniqueness is a PARTIAL index
     * (day-scoped flags only), which Prisma cannot express as a compound key.
     * ON CONFLICT DO NOTHING honours it, and also means a waived flag is never
     * silently resurrected by a later recompute.
     */
    private async raiseFlag(
        workspaceId: string,
        userId: string,
        businessDate: Date,
        type: AttendanceFlagType,
        minutes?: number,
    ) {
        await this.prisma.attendanceFlag.createMany({
            data: [{ workspaceId, userId, businessDate, type, minutes: minutes ?? null }],
            skipDuplicates: true,
        });
    }

    /** Approved overtime for one person on one day, if any. */
    private async approvedOvertimeMinutes(
        workspaceId: string,
        userId: string,
        businessDate: Date,
    ): Promise<number | null> {
        const approved = await this.prisma.overtimeRequest.findFirst({
            where: { workspaceId, userId, businessDate, status: 'APPROVED' },
            select: { approvedMinutes: true },
        });
        return approved?.approvedMinutes ?? null;
    }

    /** Who has approved leave on the date. */
    private async leaveByUser(workspaceId: string, date: Date) {
        const days = await this.prisma.leaveDay.findMany({
            where: { workspaceId, date },
            select: { userId: true, portion: true },
        });
        return new Map(days.map((day) => [day.userId, day.portion]));
    }

    /** Recompute an inclusive range, oldest first. */
    async recomputeRange(workspaceId: string, from: BusinessDate, to: BusinessDate) {
        const clock = await clockFor(this.prisma, workspaceId);
        let cursor = from;
        let days = 0;
        // Guard against an unbounded loop if the caller inverts the range.
        while (cursor <= to && days < 400) {
            await this.recomputeDay(workspaceId, cursor);
            cursor = clock.addLocalDays(cursor, 1);
            days += 1;
        }
        return days;
    }

    /**
     * What kind of day this was.
     *
     * Order matters: a holiday is a holiday even if somebody worked, and a
     * non-working day never counts as an absence — which is the whole reason
     * `expectedMinutes` is zero on those days.
     */
    private classify(
        schedule: { isHoliday: boolean; isWorkingDay: boolean; expectedMinutes: number },
        worked: SessionAggregate | undefined,
        leavePortion: LeaveDayPortion | undefined,
    ): AttendanceDayStatus {
        const minutes = worked?.workedMinutes ?? 0;

        if (schedule.isHoliday) return AttendanceDayStatus.HOLIDAY;
        if (!schedule.isWorkingDay) return AttendanceDayStatus.NON_WORKING;
        // Approved leave outranks an absence: the person was excused, not
        // missing. Somebody who worked anyway is reported on what they did.
        if (leavePortion && minutes === 0) return AttendanceDayStatus.ON_LEAVE;
        if (minutes === 0) return AttendanceDayStatus.ABSENT;
        // "Turned up but left early" is worth distinguishing from a full day,
        // and from not turning up at all.
        if (schedule.expectedMinutes > 0 && minutes < schedule.expectedMinutes) {
            return AttendanceDayStatus.PARTIAL;
        }
        return AttendanceDayStatus.PRESENT;
    }

    /**
     * Members who are expected on this date.
     *
     * Employment dates are what stop the rollup inventing absences for somebody
     * hired mid-month, and `attendanceTracked` covers the owner and contractors
     * who are simply not on the clock.
     */
    private async trackedMembers(workspaceId: string, date: Date) {
        return this.prisma.workspaceMember.findMany({
            where: {
                workspaceId,
                attendanceTracked: true,
                AND: [
                    { OR: [{ employmentStartDate: null }, { employmentStartDate: { lte: date } }] },
                    { OR: [{ employmentEndDate: null }, { employmentEndDate: { gte: date } }] },
                ],
            },
            select: { userId: true },
        });
    }

    /** Closed sessions on the date, summed per person. */
    private async aggregateSessions(workspaceId: string, date: Date) {
        const sessions = await this.prisma.workSession.findMany({
            where: { workspaceId, businessDate: date, clockOut: { not: null } },
            select: {
                userId: true,
                clockIn: true,
                clockOut: true,
                workedMinutes: true,
                totalMinutes: true,
                breakMinutes: true,
                rawOvertimeMinutes: true,
                countedOvertimeMinutes: true,
                scheduledStartUtc: true,
                graceMinutesApplied: true,
            },
        });

        const byUser = new Map<string, SessionAggregate>();
        for (const session of sessions) {
            const current = byUser.get(session.userId) ?? {
                userId: session.userId,
                workedMinutes: 0,
                breakMinutes: 0,
                rawOvertimeMinutes: 0,
                countedOvertimeMinutes: 0,
                firstClockIn: null,
                lastClockOut: null,
                sessionCount: 0,
                lateMinutes: 0,
            };

            current.workedMinutes += session.workedMinutes ?? session.totalMinutes ?? 0;
            current.breakMinutes += session.breakMinutes;
            current.rawOvertimeMinutes += session.rawOvertimeMinutes;
            current.countedOvertimeMinutes += session.countedOvertimeMinutes;
            current.sessionCount += 1;

            if (!current.firstClockIn || session.clockIn < current.firstClockIn) {
                current.firstClockIn = session.clockIn;
                // Lateness is a property of the first arrival, measured against
                // the schedule snapshot taken at that clock-in.
                const due = session.scheduledStartUtc;
                if (due) {
                    const grace = session.graceMinutesApplied ?? 0;
                    const late = WorkspaceClock.minutesBetween(due, session.clockIn) - grace;
                    current.lateMinutes = Math.max(0, late);
                }
            }
            if (session.clockOut && (!current.lastClockOut || session.clockOut > current.lastClockOut)) {
                current.lastClockOut = session.clockOut;
            }

            byUser.set(session.userId, current);
        }
        return byUser;
    }

    /** Client-billable minutes logged against the date, per person. */
    private async billableMinutes(workspaceId: string, date: Date) {
        const grouped = await this.prisma.timeEntry.groupBy({
            by: ['userId'],
            where: {
                workspaceId,
                businessDate: date,
                billable: true,
                endTime: { not: null },
            },
            _sum: { durationMinutes: true },
        });
        return new Map(grouped.map((row) => [row.userId, row._sum.durationMinutes ?? 0]));
    }
}
