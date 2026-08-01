/**
 * Wall-clock arithmetic in a workspace's own time zone.
 *
 * Everything attendance decides — was this person late, which day do these
 * minutes belong to, when does the shift end — is a question about *local* time.
 * Before this module the answer came from `new Date().getHours()`, which is the
 * server container's zone: deployed in UTC, a Kampala workspace configured to
 * allow clock-in between 08:00 and 09:30 really allowed 11:00 to 12:30 local.
 *
 * Luxon rather than hand-rolled Intl offset-solving. The hard parts are the
 * two-pass offset solve, the spring-forward gap, the fall-back ambiguity, and
 * the fact that "+1 day" is not "+24 hours" across a transition. That is
 * exactly the code that produces one incident a year in a path nobody touches
 * between incidents — and here it decides whether someone is marked late.
 */
import { DateTime } from 'luxon';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_TIME_ZONE, assertValidTimeZone } from './zones';

/** 'YYYY-MM-DD' — a calendar date with no time and no zone. */
export type BusinessDate = string;
/** 'HH:MM' in 24h form. */
export type WallTime = string;

export interface ClockConfig {
    timezone: string;
    /**
     * How far past local midnight a business day starts, in minutes. 0 means a
     * business day is a calendar day.
     *
     * A workspace running 22:00–06:00 shifts sets this to e.g. 240, so a 01:30
     * clock-in belongs to the *previous* business date rather than splitting one
     * shift across two days. This single integer is what lets cross-midnight
     * work be handled without modelling shift instances.
     */
    dayBoundaryMinutes: number;
}

const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function assertWallTime(value: string): void {
    if (!WALL_TIME.test(value)) {
        throw new Error(`Expected a wall time as HH:MM, got "${value}"`);
    }
}

export class WorkspaceClock {
    readonly timezone: string;
    readonly dayBoundaryMinutes: number;

    constructor(config: ClockConfig) {
        assertValidTimeZone(config.timezone);
        this.timezone = config.timezone;
        this.dayBoundaryMinutes = config.dayBoundaryMinutes;
    }

    /** The local calendar date of an instant. Not the business date. */
    localDate(at: Date): BusinessDate {
        return DateTime.fromJSDate(at, { zone: this.timezone }).toFormat('yyyy-MM-dd');
    }

    /** The local wall time of an instant. */
    localTime(at: Date): WallTime {
        return DateTime.fromJSDate(at, { zone: this.timezone }).toFormat('HH:mm');
    }

    /**
     * The business date an instant belongs to — the bucketing function.
     *
     * Shifting the instant back by the day boundary and *then* taking the local
     * date is what pulls an 01:30 clock-in onto the previous day. Done with
     * `minus({ minutes })` in the zone rather than millisecond arithmetic so a
     * DST transition inside the shifted window is handled by the calendar.
     */
    businessDate(at: Date): BusinessDate {
        return DateTime.fromJSDate(at, { zone: this.timezone })
            .minus({ minutes: this.dayBoundaryMinutes })
            .toFormat('yyyy-MM-dd');
    }

    /** Half-open [start, end) UTC instants covering one business date. */
    businessDateRangeUtc(date: BusinessDate): { startUtc: Date; endUtc: Date } {
        const start = this.startOfBusinessDate(date);
        const end = this.startOfBusinessDate(this.addLocalDays(date, 1));
        return { startUtc: start, endUtc: end };
    }

    private startOfBusinessDate(date: BusinessDate): Date {
        const base = DateTime.fromISO(date, { zone: this.timezone }).startOf('day');
        return this.resolve(base.plus({ minutes: this.dayBoundaryMinutes }), date);
    }

    /**
     * A local wall time on a local date, as a UTC instant.
     *
     * `dayOffset` exists for shifts that cross midnight: a 22:00–06:00 schedule
     * resolves its end with `atLocalTime(date, '06:00', 1)`.
     *
     * Two DST policies, both deliberate and both pinned by tests:
     *
     *   Nonexistent local time (spring forward — on 2025-03-09 in New York the
     *   clock jumps 02:00 → 03:00, so 02:30 never happens): shift forward by
     *   the length of the gap, giving 03:30. Not clamped to 03:00, because
     *   preserving the offset from the intended time keeps a shift the length
     *   it was rostered for rather than silently shortening it.
     *
     *   Ambiguous local time (fall back — on 2025-11-02 01:30 happens twice):
     *   take the first, still-DST occurrence (UTC-4 rather than UTC-5). Picking
     *   the earlier one means a shift is never retroactively lengthened by an
     *   hour nobody worked.
     *
     * Both are luxon's own defaults; they are documented and tested here rather
     * than assumed, because they are the answers a hand-rolled implementation
     * would most likely get wrong.
     */
    atLocalTime(date: BusinessDate, time: WallTime, dayOffset = 0): Date {
        assertWallTime(time);
        const [hour, minute] = time.split(':').map(Number);
        const target = DateTime.fromISO(date, { zone: this.timezone })
            .plus({ days: dayOffset })
            .set({ hour, minute, second: 0, millisecond: 0 });
        return this.resolve(target, `${date} ${time}`);
    }

    /**
     * Turn a possibly-invalid local DateTime into an instant.
     *
     * Luxon reports a nonexistent local time by silently shifting it forward,
     * which is the policy we want, but it can also produce an invalid DateTime
     * if the date itself was malformed — that is a programming error, not a DST
     * case, so it throws rather than guessing.
     */
    private resolve(dt: DateTime, context: string): Date {
        if (!dt.isValid) {
            throw new Error(
                `Could not resolve "${context}" in ${this.timezone}: ${dt.invalidReason ?? 'unknown'}`,
            );
        }
        return dt.toJSDate();
    }

    /**
     * Calendar-day arithmetic, not 24-hour arithmetic.
     *
     * Across a DST boundary these differ by an hour, and adding 86,400,000 ms
     * to a local midnight lands on 23:00 or 01:00 of the next day rather than
     * on midnight.
     */
    addLocalDays(date: BusinessDate, days: number): BusinessDate {
        return DateTime.fromISO(date, { zone: this.timezone })
            .plus({ days })
            .toFormat('yyyy-MM-dd');
    }

    /** ISO weekday: 1 = Monday … 7 = Sunday, matching WorkSchedule.workingDays. */
    isoWeekday(date: BusinessDate): number {
        return DateTime.fromISO(date, { zone: this.timezone }).weekday;
    }

    /** First and last business date of the month a date falls in. */
    monthRange(date: BusinessDate): { start: BusinessDate; end: BusinessDate } {
        const dt = DateTime.fromISO(date, { zone: this.timezone });
        return {
            start: dt.startOf('month').toFormat('yyyy-MM-dd'),
            end: dt.endOf('month').toFormat('yyyy-MM-dd'),
        };
    }

    /** Whole minutes between two instants, floored, never negative. */
    static minutesBetween(from: Date, to: Date): number {
        return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
    }

    /** The business date of an instant, ready to store in a `@db.Date` column. */
    businessDateColumn(at: Date): Date {
        return toDateColumn(this.businessDate(at));
    }
}

/**
 * A 'YYYY-MM-DD' as the Date a Prisma `@db.Date` column expects.
 *
 * Pinned to UTC midnight deliberately: Postgres stores a bare calendar date, and
 * Prisma reads the JS Date's UTC components to build it. Constructing it from
 * local midnight instead would shift the stored date by a day for any server
 * running west of Greenwich.
 */
export function toDateColumn(date: BusinessDate): Date {
    return new Date(`${date}T00:00:00.000Z`);
}

// ─── Loader ──────────────────────────────────────────────

interface CacheEntry {
    clock: WorkspaceClock;
    expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * The clock for a workspace, cached briefly.
 *
 * Clock-in already loads the workspace two or three times over; this keeps a
 * fourth read off the hot path without letting a timezone change take longer
 * than a minute to apply. `invalidateClock` makes the change immediate when it
 * happens through the settings endpoint.
 */
export async function clockFor(
    prisma: Pick<PrismaClient, 'workspace'>,
    workspaceId: string,
): Promise<WorkspaceClock> {
    const hit = cache.get(workspaceId);
    if (hit && hit.expiresAt > Date.now()) return hit.clock;

    const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { timezone: true },
    });

    const clock = new WorkspaceClock({
        timezone: workspace?.timezone ?? DEFAULT_TIME_ZONE,
        // Lives on AttendanceSettings, which does not exist until phase 4. Until
        // then every workspace's business day is its calendar day.
        dayBoundaryMinutes: 0,
    });

    cache.set(workspaceId, { clock, expiresAt: Date.now() + CACHE_TTL_MS });
    return clock;
}

export function invalidateClock(workspaceId: string): void {
    cache.delete(workspaceId);
}

/** Test seam — the cache is process-global and would otherwise leak between cases. */
export function clearClockCache(): void {
    cache.clear();
}
