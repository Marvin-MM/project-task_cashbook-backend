/**
 * Which night a sale belongs to.
 *
 * A venue running past midnight is the case the cutover exists for: a sale rung
 * at 01:30 on Saturday belongs to Friday's session, Friday's prices and Friday's
 * Z-report. Bucketing by calendar date charges a Thursday crowd Friday's prices
 * and splits one night's takings across two reconciliations.
 *
 * These are unit tests over the clock rather than integration tests over the
 * desk, because the desk cannot be made to believe it is 01:30 without either
 * faking timers globally or waiting until 01:30.
 */
import { describe, expect, it } from 'vitest';
import { WorkspaceClock } from '../../core/time/workspace-clock';
import { sessionDayOfWeek } from '../../modules/ticketing/business-day';

/** Kampala: UTC+3, no DST — the deployment target. */
const kampala = (dayStartMinutes: number) =>
    new WorkspaceClock({ timezone: 'Africa/Kampala', dayBoundaryMinutes: dayStartMinutes });

/** A local wall time in Kampala, as the instant the server would see. */
const at = (local: string) => new Date(`${local}+03:00`);

describe('the business-day cutover', () => {
    it('keeps a late Friday crowd on Friday', () => {
        const clock = kampala(360);   // 06:00

        expect(clock.businessDate(at('2026-08-07T22:00:00'))).toBe('2026-08-07'); // Fri 22:00
        expect(clock.businessDate(at('2026-08-07T23:59:00'))).toBe('2026-08-07'); // Fri 23:59
        expect(clock.businessDate(at('2026-08-08T00:30:00'))).toBe('2026-08-07'); // Sat 00:30
        expect(clock.businessDate(at('2026-08-08T01:30:00'))).toBe('2026-08-07'); // Sat 01:30
        expect(clock.businessDate(at('2026-08-08T05:59:00'))).toBe('2026-08-07'); // Sat 05:59
    });

    it('starts the new day at the cutover, not at midnight', () => {
        const clock = kampala(360);
        expect(clock.businessDate(at('2026-08-08T06:00:00'))).toBe('2026-08-08');
        expect(clock.businessDate(at('2026-08-08T07:00:00'))).toBe('2026-08-08');
    });

    it('falls back to plain calendar days when the cutover is zero', () => {
        const clock = kampala(0);
        expect(clock.businessDate(at('2026-08-07T23:59:00'))).toBe('2026-08-07');
        expect(clock.businessDate(at('2026-08-08T00:01:00'))).toBe('2026-08-08');
    });

    it('resolves in the workspace zone, not the server’s', () => {
        const clock = kampala(0);
        // 22:30 UTC is already 01:30 the next day in Kampala. A server running
        // in UTC that used its own date would file this under the wrong night.
        expect(clock.businessDate(new Date('2026-08-07T22:30:00Z'))).toBe('2026-08-08');
    });
});

describe('which session runs', () => {
    it('reports the weekday of the BUSINESS date, so late sales price correctly', () => {
        const clock = kampala(360);

        // Saturday 01:30 belongs to Friday's business date, so the desk must
        // find Friday's session — 5, not Saturday's 6.
        const businessDate = clock.businessDate(at('2026-08-08T01:30:00'));
        expect(businessDate).toBe('2026-08-07');
        expect(sessionDayOfWeek(clock, businessDate)).toBe(5);
    });

    it('maps the week the way a date picker does: Sunday is 0', () => {
        const clock = kampala(0);
        // 2026-08-02 is a Sunday; 2026-08-08 is a Saturday.
        expect(sessionDayOfWeek(clock, '2026-08-02')).toBe(0);
        expect(sessionDayOfWeek(clock, '2026-08-03')).toBe(1);
        expect(sessionDayOfWeek(clock, '2026-08-06')).toBe(4);
        expect(sessionDayOfWeek(clock, '2026-08-08')).toBe(6);
    });

    it('agrees with JavaScript’s getDay for every day of a week', () => {
        const clock = kampala(0);
        for (let day = 2; day <= 8; day += 1) {
            const date = `2026-08-0${day}`;
            expect(sessionDayOfWeek(clock, date)).toBe(new Date(`${date}T12:00:00Z`).getUTCDay());
        }
    });
});
