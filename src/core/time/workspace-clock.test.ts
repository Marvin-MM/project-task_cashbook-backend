/**
 * The clock, pinned.
 *
 * No database, so these run in milliseconds and there is no reason to be
 * sparing with cases. They exist because the alternative to a library here was
 * ~60 lines of hand-rolled offset solving, and this file is the argument for
 * why that would have been a bad trade: every case below is one a hand-rolled
 * implementation plausibly gets wrong, silently, once a year.
 */
import { describe, expect, it } from 'vitest';
import { WorkspaceClock, toDateColumn } from './workspace-clock';
import { isValidTimeZone } from './zones';

const kampala = new WorkspaceClock({ timezone: 'Africa/Kampala', dayBoundaryMinutes: 0 });
const newYork = new WorkspaceClock({ timezone: 'America/New_York', dayBoundaryMinutes: 0 });

describe('time zone validation', () => {
    it('accepts real IANA names', () => {
        expect(isValidTimeZone('Africa/Kampala')).toBe(true);
        expect(isValidTimeZone('America/New_York')).toBe(true);
        expect(isValidTimeZone('UTC')).toBe(true);
    });

    it('rejects garbage and the legacy abbreviations', () => {
        // ICU resolves these, which is the trap: EST is a FIXED -05:00 with no
        // daylight saving, so a New York workspace that picked it would be an
        // hour out from April to November every year, silently.
        expect(isValidTimeZone('EST')).toBe(false);
        expect(isValidTimeZone('EST5EDT')).toBe(false);
        expect(isValidTimeZone('CET')).toBe(false);
        expect(isValidTimeZone('EAT')).toBe(false);
        expect(isValidTimeZone('UTC+3')).toBe(false);
        expect(isValidTimeZone('')).toBe(false);
        expect(isValidTimeZone('Not/AZone')).toBe(false);
    });

    it('still allows the Etc namespace, which deliberately means a fixed offset', () => {
        expect(isValidTimeZone('Etc/GMT-3')).toBe(true);
    });
});

describe('local reading of an instant', () => {
    it('reads a UTC instant in the workspace zone, not the server zone', () => {
        // 2025-06-10T22:30Z is 01:30 the NEXT day in Kampala (+03:00).
        const at = new Date('2025-06-10T22:30:00.000Z');
        expect(kampala.localDate(at)).toBe('2025-06-11');
        expect(kampala.localTime(at)).toBe('01:30');
    });

    it('is the bug that existed before: evening UTC work belonged to the wrong day', () => {
        // The old summary bucketed on startTime.toISOString().slice(0,10), i.e.
        // UTC. For a Kampala workspace that put 22:30 work on the 10th when
        // locally it happened on the 11th.
        const at = new Date('2025-06-10T22:30:00.000Z');
        expect(at.toISOString().slice(0, 10)).toBe('2025-06-10');
        expect(kampala.businessDate(at)).toBe('2025-06-11');
    });
});

describe('business date bucketing', () => {
    it('equals the local calendar date when the boundary is midnight', () => {
        const at = new Date('2025-06-10T09:00:00.000Z'); // 12:00 Kampala
        expect(kampala.businessDate(at)).toBe(kampala.localDate(at));
    });

    it('pulls early-morning work onto the previous day for a night shift', () => {
        // A workspace running 22:00-06:00 sets the boundary to 04:00 so one
        // shift is not split across two business dates.
        const nightShift = new WorkspaceClock({
            timezone: 'Africa/Kampala',
            dayBoundaryMinutes: 240,
        });
        // 01:30 local on the 11th belongs to the shift that began on the 10th.
        const at = new Date('2025-06-10T22:30:00.000Z'); // 01:30 Kampala on the 11th
        expect(nightShift.localDate(at)).toBe('2025-06-11');
        expect(nightShift.businessDate(at)).toBe('2025-06-10');
    });

    it('leaves work after the boundary on its own day', () => {
        const nightShift = new WorkspaceClock({
            timezone: 'Africa/Kampala',
            dayBoundaryMinutes: 240,
        });
        const at = new Date('2025-06-11T04:00:00.000Z'); // 07:00 Kampala
        expect(nightShift.businessDate(at)).toBe('2025-06-11');
    });

    it('produces a half-open UTC range that tiles without gaps or overlap', () => {
        const day1 = kampala.businessDateRangeUtc('2025-06-10');
        const day2 = kampala.businessDateRangeUtc('2025-06-11');
        expect(day1.endUtc.getTime()).toBe(day2.startUtc.getTime());
        // Kampala is UTC+3 with no DST, so a local day starts at 21:00 the
        // previous UTC day.
        expect(day1.startUtc.toISOString()).toBe('2025-06-09T21:00:00.000Z');
    });
});

describe('DST — spring forward', () => {
    // 2025-03-09 in New York: the clock jumps 02:00 -> 03:00, so 02:30 never
    // happens.
    const transitionDay = '2025-03-09';

    it('shifts a nonexistent local time past the gap rather than throwing', () => {
        const resolved = newYork.atLocalTime(transitionDay, '02:30');
        // 03:30 local, not 03:00: preserving the offset from the intended time
        // keeps a shift the length it was rostered for.
        expect(newYork.localTime(resolved)).toBe('03:30');
    });

    it('resolves times either side of the gap normally', () => {
        expect(newYork.localTime(newYork.atLocalTime(transitionDay, '01:30'))).toBe('01:30');
        expect(newYork.localTime(newYork.atLocalTime(transitionDay, '09:00'))).toBe('09:00');
    });

    it('makes the transition day 23 hours long', () => {
        const start = newYork.atLocalTime(transitionDay, '00:00');
        const end = newYork.atLocalTime(newYork.addLocalDays(transitionDay, 1), '00:00');
        expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
    });

    it('a 09:00-17:00 shift is still 8 hours on the transition day', () => {
        // The gap is at 02:00, outside the shift, so the shift length is
        // unaffected. This is the case that must NOT be "fixed" by naive
        // 24-hour arithmetic.
        const start = newYork.atLocalTime(transitionDay, '09:00');
        const end = newYork.atLocalTime(transitionDay, '17:00');
        expect((end.getTime() - start.getTime()) / 3_600_000).toBe(8);
    });
});

describe('DST — fall back', () => {
    // 2025-11-02 in New York: 01:00-02:00 happens twice.
    const transitionDay = '2025-11-02';

    it('takes the first, still-DST occurrence of an ambiguous local time', () => {
        const resolved = newYork.atLocalTime(transitionDay, '01:30');
        // EDT is UTC-4; EST would be UTC-5 and give 06:30Z.
        expect(resolved.toISOString()).toBe('2025-11-02T05:30:00.000Z');
    });

    it('makes the transition day 25 hours long', () => {
        const start = newYork.atLocalTime(transitionDay, '00:00');
        const end = newYork.atLocalTime(newYork.addLocalDays(transitionDay, 1), '00:00');
        expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
    });
});

describe('calendar arithmetic', () => {
    it('adds calendar days, not 24-hour blocks', () => {
        // Across spring forward, local midnight + 24h is 01:00, not midnight.
        // Anything that reasoned in milliseconds would drift here.
        const start = newYork.atLocalTime('2025-03-09', '00:00');
        const naive = new Date(start.getTime() + 86_400_000);
        expect(newYork.localTime(naive)).toBe('01:00');
        expect(newYork.localTime(newYork.atLocalTime(newYork.addLocalDays('2025-03-09', 1), '00:00')))
            .toBe('00:00');
    });

    it('crosses month and year boundaries', () => {
        expect(kampala.addLocalDays('2025-01-31', 1)).toBe('2025-02-01');
        expect(kampala.addLocalDays('2025-12-31', 1)).toBe('2026-01-01');
        expect(kampala.addLocalDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
    });

    it('reports ISO weekdays with Monday as 1', () => {
        expect(kampala.isoWeekday('2025-06-09')).toBe(1); // Monday
        expect(kampala.isoWeekday('2025-06-15')).toBe(7); // Sunday
    });

    it('bounds a month', () => {
        expect(kampala.monthRange('2025-02-14')).toEqual({
            start: '2025-02-01',
            end: '2025-02-28',
        });
    });
});

describe('cross-midnight shifts', () => {
    it('resolves a 22:00-06:00 shift end on the following day', () => {
        const start = kampala.atLocalTime('2025-06-10', '22:00');
        const end = kampala.atLocalTime('2025-06-10', '06:00', 1);
        expect(end.getTime()).toBeGreaterThan(start.getTime());
        expect((end.getTime() - start.getTime()) / 3_600_000).toBe(8);
        expect(kampala.localDate(end)).toBe('2025-06-11');
    });
});

describe('non-integer offsets', () => {
    it('handles +05:30 (Kolkata)', () => {
        const kolkata = new WorkspaceClock({ timezone: 'Asia/Kolkata', dayBoundaryMinutes: 0 });
        expect(kolkata.atLocalTime('2025-06-10', '09:00').toISOString())
            .toBe('2025-06-10T03:30:00.000Z');
    });

    it('handles +12:45 (Chatham)', () => {
        const chatham = new WorkspaceClock({ timezone: 'Pacific/Chatham', dayBoundaryMinutes: 0 });
        expect(chatham.atLocalTime('2025-06-10', '09:00').toISOString())
            .toBe('2025-06-09T20:15:00.000Z');
    });
});

describe('input validation', () => {
    it('rejects an invalid zone at construction', () => {
        expect(() => new WorkspaceClock({ timezone: 'Nope/Nowhere', dayBoundaryMinutes: 0 }))
            .toThrow(/not a recognised time zone/);
    });

    it('rejects a malformed wall time', () => {
        expect(() => kampala.atLocalTime('2025-06-10', '25:00')).toThrow(/HH:MM/);
        expect(() => kampala.atLocalTime('2025-06-10', '9:00')).toThrow(/HH:MM/);
        expect(() => kampala.atLocalTime('2025-06-10', 'noon')).toThrow(/HH:MM/);
    });
});

describe('toDateColumn', () => {
    it('pins to UTC midnight so a @db.Date is not shifted by the server zone', () => {
        const d = toDateColumn('2025-06-10');
        expect(d.toISOString()).toBe('2025-06-10T00:00:00.000Z');
        expect(d.getUTCDate()).toBe(10);
    });
});

describe('minutesBetween', () => {
    it('floors and never goes negative', () => {
        const a = new Date('2025-06-10T09:00:00.000Z');
        const b = new Date('2025-06-10T09:30:59.000Z');
        expect(WorkspaceClock.minutesBetween(a, b)).toBe(30);
        expect(WorkspaceClock.minutesBetween(b, a)).toBe(0);
    });
});
