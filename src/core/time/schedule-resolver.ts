/**
 * Which hours applied to one person on one day.
 *
 * Two things make this more than a lookup:
 *
 *   Precedence — a member override beats the organisation default, and the
 *   choice has to be made per row rather than per query, so it is an ORDER BY
 *   with NULLS LAST rather than two round trips.
 *
 *   Time — schedules are versioned. The schedule that applied in January is the
 *   one effective in January, not the one somebody edited in June. Resolving
 *   "current" instead would silently rewrite history every time hours changed,
 *   and the late-arrival flags computed from it along with them.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { BusinessDate, WorkspaceClock } from './workspace-clock';

type PrismaLike = Pick<PrismaClient, 'workSchedule' | 'holiday'>;

export interface EffectiveSchedule {
    scheduleId: string | null;
    /** A weekday on this person's schedule, and not a holiday. */
    isWorkingDay: boolean;
    isHoliday: boolean;
    startUtc: Date | null;
    /** Already offset by a day when the shift crosses midnight. */
    endUtc: Date | null;
    crossesMidnight: boolean;
    graceMinutes: number;
    earlyOutGraceMinutes: number;
    breakMinutes: number;
    breakPaid: boolean;
    /** Zero on a non-working day, which is what makes those days not "absent". */
    expectedMinutes: number;
    clockInWindowStart: string | null;
    clockInWindowEnd: string | null;
    clockOutWindowStart: string | null;
}

/** What a workspace with no schedule configured falls back to. */
const NO_SCHEDULE: EffectiveSchedule = {
    scheduleId: null,
    isWorkingDay: true,
    isHoliday: false,
    startUtc: null,
    endUtc: null,
    crossesMidnight: false,
    graceMinutes: 0,
    earlyOutGraceMinutes: 0,
    breakMinutes: 0,
    breakPaid: true,
    expectedMinutes: 0,
    clockInWindowStart: null,
    clockInWindowEnd: null,
    clockOutWindowStart: null,
};

export async function resolveSchedule(
    prisma: PrismaLike,
    workspaceId: string,
    userId: string,
    businessDate: BusinessDate,
    clock: WorkspaceClock,
): Promise<EffectiveSchedule> {
    const asOf = new Date(`${businessDate}T00:00:00.000Z`);

    const [schedules, holiday] = await Promise.all([
        prisma.workSchedule.findMany({
            where: {
                workspaceId,
                OR: [{ userId }, { userId: null }],
                effectiveFrom: { lte: asOf },
                AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] }],
            },
            // A row with a userId is this person's override; NULL is the org
            // default. Sorting non-null first and taking one implements
            // "override wins" without a second query.
            orderBy: [{ userId: { sort: 'desc', nulls: 'last' } }, { effectiveFrom: 'desc' }],
            take: 1,
        }),
        prisma.holiday.findUnique({
            where: { workspaceId_date: { workspaceId, date: asOf } },
            select: { id: true },
        }),
    ]);

    const schedule = schedules[0];
    if (!schedule) return { ...NO_SCHEDULE, isHoliday: Boolean(holiday) };

    const weekday = clock.isoWeekday(businessDate);
    const isScheduledDay = schedule.workingDays.includes(weekday);
    const isHoliday = Boolean(holiday);
    const isWorkingDay = isScheduledDay && !isHoliday;

    return {
        scheduleId: schedule.id,
        isWorkingDay,
        isHoliday,
        startUtc: clock.atLocalTime(businessDate, schedule.startTime),
        // A 22:00-06:00 shift ends on the following calendar day.
        endUtc: clock.atLocalTime(
            businessDate,
            schedule.endTime,
            schedule.crossesMidnight ? 1 : 0,
        ),
        crossesMidnight: schedule.crossesMidnight,
        graceMinutes: schedule.graceMinutes,
        earlyOutGraceMinutes: schedule.earlyOutGraceMinutes,
        breakMinutes: schedule.breakMinutes,
        breakPaid: schedule.breakPaid,
        // Zero on a day off, so the rollup does not report an absence for a
        // Sunday or a public holiday.
        expectedMinutes: isWorkingDay ? schedule.expectedMinutesPerDay : 0,
        clockInWindowStart: schedule.clockInWindowStart,
        clockInWindowEnd: schedule.clockInWindowEnd,
        clockOutWindowStart: schedule.clockOutWindowStart,
    };
}

/** `endTime <= startTime` means the shift runs past midnight. */
export function crossesMidnight(startTime: string, endTime: string): boolean {
    return endTime <= startTime;
}

/**
 * Minutes a shift covers, excluding unpaid break time.
 *
 * Uses the clock rather than subtracting strings so a shift spanning a DST
 * transition is the length it actually was — 23 or 25 hours of wall clock, not
 * whatever the times imply.
 */
export function scheduledMinutes(
    clock: WorkspaceClock,
    businessDate: BusinessDate,
    startTime: string,
    endTime: string,
    breakMinutes: number,
    breakPaid: boolean,
): number {
    const start = clock.atLocalTime(businessDate, startTime);
    const end = clock.atLocalTime(
        businessDate,
        endTime,
        crossesMidnight(startTime, endTime) ? 1 : 0,
    );
    const gross = WorkspaceClock.minutesBetween(start, end);
    return breakPaid ? gross : Math.max(0, gross - breakMinutes);
}

export type ScheduleRow = Prisma.WorkScheduleGetPayload<Record<string, never>>;
