/**
 * Which night a sale belongs to.
 *
 * A venue that runs past midnight rings a sale at 01:30 that belongs to the
 * previous evening: Thursday's prices, Thursday's session, Thursday's Z-report.
 * Bucketing it by calendar date would charge Friday's prices to a Thursday crowd
 * and split one night's takings across two reconciliations.
 *
 * The arithmetic for this already exists and is already tested against DST gaps
 * and ambiguities — WorkspaceClock, built for attendance, where the same problem
 * appears as a night shift. This module is only the loader: it supplies
 * TicketSettings.dayStartMinutes where attendance supplies
 * AttendanceSettings.dayBoundaryMinutes, so the two features cannot drift into
 * two different notions of "yesterday".
 */
import { PrismaClient } from '@prisma/client';
import { WorkspaceClock, BusinessDate, toDateColumn } from '../../core/time/workspace-clock';
import { DEFAULT_TIME_ZONE } from '../../core/time/zones';

type PrismaLike = Pick<PrismaClient, 'workspace' | 'ticketSettings'>;

export { toDateColumn };
export type { BusinessDate };

/**
 * The ticketing clock for a workspace.
 *
 * Deliberately NOT cached, unlike `clockFor`. The desk reads it once per request
 * on a path that already touches settings, and a stale cutover would silently
 * post a night's sales onto the wrong date — the one failure here that is
 * expensive to unpick afterwards.
 */
export async function ticketClockFor(
    prisma: PrismaLike,
    workspaceId: string,
): Promise<WorkspaceClock> {
    const [workspace, settings] = await Promise.all([
        prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: { timezone: true },
        }),
        prisma.ticketSettings.findUnique({
            where: { workspaceId },
            select: { dayStartMinutes: true },
        }),
    ]);

    return new WorkspaceClock({
        timezone: workspace?.timezone ?? DEFAULT_TIME_ZONE,
        dayBoundaryMinutes: settings?.dayStartMinutes ?? 0,
    });
}

/**
 * Weekday of a business date as TicketSession stores it: 0 = Sunday … 6 = Saturday.
 *
 * WorkspaceClock speaks ISO weekdays (1 = Monday … 7 = Sunday) because
 * WorkSchedule.workingDays does. Ticketing uses 0-6 because that is what a date
 * picker and `Date.getDay()` produce, and because "Sunday is day 0" is what an
 * admin configuring Thursday pricing will expect from the UI. Converting in one
 * named place beats an inline `% 7` at each call site.
 */
export function sessionDayOfWeek(clock: WorkspaceClock, date: BusinessDate): number {
    return clock.isoWeekday(date) % 7;
}
