/**
 * Attendance decisions follow the workspace's zone, not the server's.
 *
 * The bug this replaces: `enforceAttendanceTimeWindow` compared
 * `new Date().getHours()` — the container's local time — against HH:MM strings
 * the schema described as "local time". Deployed in UTC, a Kampala workspace
 * configured to allow clock-in between 08:00 and 09:30 actually allowed 11:00
 * to 12:30 EAT, and nobody would have noticed except as unexplained rejections.
 *
 * Time is frozen with vi.setSystemTime so "now" is a known instant. Note that
 * this does NOT freeze Postgres's clock, which is exactly why every attendance
 * timestamp is written by the application rather than defaulted in SQL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { TimeTrackingService } from '../../modules/time-tracking/time-tracking.service';
import { createUser, createWorkspace } from '../factories';
import { clearClockCache } from '../../core/time/workspace-clock';

const service = () => resolveService(TimeTrackingService);

beforeEach(async () => {
    await resetDatabase();
    clearClockCache();
});

afterEach(() => {
    vi.useRealTimers();
});

/** Freeze the wall clock at a UTC instant. */
function freezeAtUtc(iso: string) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(iso));
}

describe('the clock-in window is evaluated in the workspace zone', () => {
    it('accepts an arrival that is inside the window locally but outside it in UTC', async () => {
        // 06:00Z is 09:00 in Kampala (+03:00) — inside 08:00-09:30 local.
        // Judged in UTC it would be 06:00, well outside, and refused.
        freezeAtUtc('2025-06-10T06:00:00.000Z');

        const user = await createUser();
        const workspace = await createWorkspace(user.id, {
            timezone: 'Africa/Kampala',
            attendanceClockInStart: '08:00',
            attendanceClockInEnd: '09:30',
            enforceClockWindows: true,
        });

        await expect(service().clockIn(workspace.id, user.id, {})).resolves.toBeTruthy();
    });

    it('refuses an arrival that is outside the window locally but inside it in UTC', async () => {
        // The mirror image: 08:30Z is 11:30 in Kampala — past the window.
        freezeAtUtc('2025-06-10T08:30:00.000Z');

        const user = await createUser();
        const workspace = await createWorkspace(user.id, {
            timezone: 'Africa/Kampala',
            attendanceClockInStart: '08:00',
            attendanceClockInEnd: '09:30',
            enforceClockWindows: true,
        });

        await expect(service().clockIn(workspace.id, user.id, {})).rejects.toMatchObject({
            code: 'OUTSIDE_ATTENDANCE_TIME_WINDOW',
        });
    });

    it('gives two workspaces in different zones opposite answers at the same instant', async () => {
        // The clearest statement of the fix: one server clock, one window
        // configuration, two correct-but-different outcomes.
        freezeAtUtc('2025-06-10T06:00:00.000Z');

        const user = await createUser();
        const kampala = await createWorkspace(user.id, {
            timezone: 'Africa/Kampala', // 09:00 local
            attendanceClockInStart: '08:00',
            attendanceClockInEnd: '09:30',
            enforceClockWindows: true,
        });
        const london = await createWorkspace(user.id, {
            timezone: 'Europe/London', // 07:00 local (BST)
            attendanceClockInStart: '08:00',
            attendanceClockInEnd: '09:30',
            enforceClockWindows: true,
        });

        await expect(service().clockIn(london.id, user.id, {})).rejects.toMatchObject({
            code: 'OUTSIDE_ATTENDANCE_TIME_WINDOW',
        });
        await expect(service().clockIn(kampala.id, user.id, {})).resolves.toBeTruthy();
    });

    it('follows the DST offset rather than a fixed one', async () => {
        // 13:00Z on a June day is 09:00 in New York under EDT (-04:00). Under
        // the winter offset (-05:00) it would be 08:00 — still inside this
        // window, so the window is tightened to catch the difference.
        freezeAtUtc('2025-06-10T13:00:00.000Z');

        const user = await createUser();
        const workspace = await createWorkspace(user.id, {
            timezone: 'America/New_York',
            attendanceClockInStart: '08:30',
            attendanceClockInEnd: '09:30',
            enforceClockWindows: true,
        });

        await expect(service().clockIn(workspace.id, user.id, {})).resolves.toBeTruthy();
    });
});

describe('the business date is the local day', () => {
    it('assigns late-evening UTC work to the following local day', async () => {
        // 22:30Z is 01:30 the next day in Kampala. Bucketing on the UTC date —
        // what the old summary did — would file it under the 10th.
        freezeAtUtc('2025-06-10T22:30:00.000Z');

        const user = await createUser();
        const workspace = await createWorkspace(user.id, { timezone: 'Africa/Kampala' });

        const session = await service().clockIn(workspace.id, user.id, {});

        expect(session.businessDate.toISOString().slice(0, 10)).toBe('2025-06-11');
    });

    it('assigns early-morning UTC work to the previous local day west of Greenwich', async () => {
        // 02:30Z is 22:30 the previous day in New York.
        freezeAtUtc('2025-06-11T02:30:00.000Z');

        const user = await createUser();
        const workspace = await createWorkspace(user.id, { timezone: 'America/New_York' });

        const session = await service().clockIn(workspace.id, user.id, {});

        expect(session.businessDate.toISOString().slice(0, 10)).toBe('2025-06-10');
    });

    it('stamps time entries with the same local day', async () => {
        freezeAtUtc('2025-06-10T22:30:00.000Z');

        const user = await createUser();
        const workspace = await createWorkspace(user.id, { timezone: 'Africa/Kampala' });
        const project = await testPrisma.project.create({
            data: { workspaceId: workspace.id, name: 'Evening work', createdById: user.id },
        });

        const entry = await service().startTimer(workspace.id, user.id, { projectId: project.id });

        expect(entry.businessDate.toISOString().slice(0, 10)).toBe('2025-06-11');
        // And the entry records who typed it, which is what will distinguish
        // self-logged time from time a manager logs on someone's behalf.
        expect(entry.createdById).toBe(user.id);
    });
});

describe('workspaces without an explicit zone', () => {
    it('default to Africa/Kampala rather than the server zone', async () => {
        const user = await createUser();
        const workspace = await testPrisma.workspace.create({
            data: { name: 'No zone set', type: 'BUSINESS', ownerId: user.id, defaultCurrency: 'UGX' },
        });

        expect(workspace.timezone).toBe('Africa/Kampala');
    });
});
