/**
 * Presence intervals, and the daily rollup built from them.
 *
 * The rollup is the reason this file exists. Everything else in attendance can
 * be checked by reading a session row; "who was absent on Tuesday" cannot,
 * because there is no row for somebody who never turned up. These tests pin the
 * grid that produces those rows, and the property that makes the whole thing
 * trustworthy: recomputing is idempotent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PresenceStatus, WorkspaceRole } from '@prisma/client';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { PresenceService } from '../../modules/attendance/presence.service';
import { AttendanceRollupService } from '../../modules/attendance/rollup.service';
import { TimeTrackingService } from '../../modules/time-tracking/time-tracking.service';
import {
    addWorkspaceMember,
    createOpenWorkSession,
    createUser,
    createWorkspace,
} from '../factories';
import { clearClockCache, toDateColumn } from '../../core/time/workspace-clock';

const presence = () => resolveService(PresenceService);
const rollup = () => resolveService(AttendanceRollupService);
const timeTracking = () => resolveService(TimeTrackingService);

const DATE = '2026-03-10'; // a Tuesday

/** Workspace with settings, an org schedule, and one tracked member. */
async function fixture(schedule: Partial<{
    workingDays: number[];
    startTime: string;
    endTime: string;
    graceMinutes: number;
    breakMinutes: number;
    breakPaid: boolean;
    expectedMinutesPerDay: number;
}> = {}) {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    await testPrisma.attendanceSettings.create({
        data: { workspaceId: workspace.id },
    });

    const member = await createUser();
    await addWorkspaceMember(workspace.id, member.id, WorkspaceRole.MEMBER);
    // The owner has no membership row, so only the member is tracked.

    await testPrisma.workSchedule.create({
        data: {
            workspaceId: workspace.id,
            workingDays: schedule.workingDays ?? [1, 2, 3, 4, 5],
            startTime: schedule.startTime ?? '09:00',
            endTime: schedule.endTime ?? '17:00',
            graceMinutes: schedule.graceMinutes ?? 10,
            breakMinutes: schedule.breakMinutes ?? 0,
            breakPaid: schedule.breakPaid ?? true,
            expectedMinutesPerDay: schedule.expectedMinutesPerDay ?? 480,
            effectiveFrom: toDateColumn('2026-01-01'),
        },
    });

    return { owner, workspace, member };
}

/** A completed session on DATE, written directly. */
async function closedSession(
    workspaceId: string,
    userId: string,
    opts: { fromHour: number; toHour: number; late?: number },
) {
    const clockIn = new Date(`${DATE}T${String(opts.fromHour).padStart(2, '0')}:00:00.000Z`);
    const clockOut = new Date(`${DATE}T${String(opts.toHour).padStart(2, '0')}:00:00.000Z`);
    const minutes = Math.floor((clockOut.getTime() - clockIn.getTime()) / 60_000);
    return testPrisma.workSession.create({
        data: {
            workspaceId,
            userId,
            clockIn,
            clockOut,
            businessDate: toDateColumn(DATE),
            status: 'CLOSED',
            totalMinutes: minutes,
            workedMinutes: minutes,
            scheduledStartUtc: new Date(`${DATE}T06:00:00.000Z`), // 09:00 Kampala
            graceMinutesApplied: 10,
        },
    });
}

beforeEach(async () => {
    await resetDatabase();
    clearClockCache();
});

describe('presence', () => {
    it('starts AVAILABLE when clocking in', async () => {
        const { workspace, member } = await fixture();

        const session = await timeTracking().clockIn(workspace.id, member.id, {});

        expect(session.presenceStatus).toBe('AVAILABLE');
        const intervals = await testPrisma.workSessionPresence.findMany({
            where: { sessionId: session.id },
        });
        expect(intervals).toHaveLength(1);
        expect(intervals[0].endedAt).toBeNull();
    });

    it('closes the previous interval and opens a new one', async () => {
        const { workspace, member } = await fixture();
        await createOpenWorkSession(workspace.id, member.id, {
            clockIn: new Date(Date.now() - 30 * 60 * 1000),
        });

        await presence().setPresence(workspace.id, member.id, PresenceStatus.LUNCH);

        const intervals = await testPrisma.workSessionPresence.findMany({
            orderBy: { startedAt: 'asc' },
        });
        expect(intervals).toHaveLength(2);
        expect(intervals[0].endedAt).not.toBeNull();
        expect(intervals[0].minutes).toBe(30);
        expect(intervals[1].status).toBe('LUNCH');
        expect(intervals[1].endedAt).toBeNull();
    });

    it('is a no-op when the status has not changed', async () => {
        const { workspace, member } = await fixture();
        await createOpenWorkSession(workspace.id, member.id);

        await presence().setPresence(workspace.id, member.id, PresenceStatus.AVAILABLE);

        // No zero-length interval.
        expect(await testPrisma.workSessionPresence.count()).toBe(1);
    });

    it('refuses when the caller is not clocked in', async () => {
        const { workspace, member } = await fixture();

        await expect(
            presence().setPresence(workspace.id, member.id, PresenceStatus.BUSY),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('converges when two changes land together', async () => {
        const { workspace, member } = await fixture();
        await createOpenWorkSession(workspace.id, member.id);

        await Promise.allSettled([
            presence().setPresence(workspace.id, member.id, PresenceStatus.BUSY),
            presence().setPresence(workspace.id, member.id, PresenceStatus.MEETING),
        ]);

        // Whatever won, there is exactly one open interval afterwards.
        const open = await testPrisma.workSessionPresence.count({ where: { endedAt: null } });
        expect(open).toBe(1);
    });

    it('clears presence on clock-out, and closes the interval', async () => {
        const { workspace, member } = await fixture();
        await createOpenWorkSession(workspace.id, member.id, {
            clockIn: new Date(Date.now() - 60 * 60 * 1000),
        });

        const closed = await timeTracking().clockOut(workspace.id, member.id, {});

        expect(closed.presenceStatus).toBeNull();
        expect(await testPrisma.workSessionPresence.count({ where: { endedAt: null } })).toBe(0);
    });

    it('subtracts unpaid break time from worked minutes', async () => {
        const { workspace, member } = await fixture({ breakPaid: false });
        await createOpenWorkSession(workspace.id, member.id, {
            clockIn: new Date(Date.now() - 60 * 60 * 1000),
        });

        // Twenty minutes of it at lunch.
        await presence().setPresence(workspace.id, member.id, PresenceStatus.LUNCH);
        await testPrisma.workSessionPresence.updateMany({
            where: { status: 'LUNCH' },
            data: { startedAt: new Date(Date.now() - 20 * 60 * 1000) },
        });

        const closed = await timeTracking().clockOut(workspace.id, member.id, {});

        expect(closed.breakMinutes).toBe(20);
        expect(closed.workedMinutes).toBe(closed.totalMinutes! - 20);
    });

    it('leaves worked minutes alone when breaks are paid', async () => {
        const { workspace, member } = await fixture({ breakPaid: true });
        await createOpenWorkSession(workspace.id, member.id, {
            clockIn: new Date(Date.now() - 60 * 60 * 1000),
        });
        await presence().setPresence(workspace.id, member.id, PresenceStatus.BREAK);

        const closed = await timeTracking().clockOut(workspace.id, member.id, {});

        expect(closed.breakMinutes).toBe(0);
        expect(closed.workedMinutes).toBe(closed.totalMinutes);
    });
});

describe('the daily rollup', () => {
    it('records a full day as PRESENT', async () => {
        const { workspace, member } = await fixture();
        await closedSession(workspace.id, member.id, { fromHour: 6, toHour: 14 }); // 8h

        await rollup().recomputeDay(workspace.id, DATE);

        const day = await testPrisma.attendanceDay.findFirstOrThrow({
            where: { workspaceId: workspace.id, userId: member.id },
        });
        expect(day.status).toBe('PRESENT');
        expect(day.workedMinutes).toBe(480);
        expect(day.expectedMinutes).toBe(480);
        expect(day.sessionCount).toBe(1);
    });

    it('records a short day as PARTIAL', async () => {
        const { workspace, member } = await fixture();
        await closedSession(workspace.id, member.id, { fromHour: 6, toHour: 10 }); // 4h

        await rollup().recomputeDay(workspace.id, DATE);

        const day = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });
        expect(day.status).toBe('PARTIAL');
        expect(day.workedMinutes).toBe(240);
    });

    it('generates ABSENT for a working day with no session at all', async () => {
        // The case no GROUP BY over sessions can produce.
        const { workspace, member } = await fixture();

        await rollup().recomputeDay(workspace.id, DATE);

        const day = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });
        expect(day.status).toBe('ABSENT');
        expect(day.workedMinutes).toBe(0);
        expect(day.expectedMinutes).toBe(480);
    });

    it('does not call a non-working day an absence', async () => {
        const { workspace, member } = await fixture({ workingDays: [1] }); // Mondays only

        await rollup().recomputeDay(workspace.id, DATE); // a Tuesday

        const day = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });
        expect(day.status).toBe('NON_WORKING');
        expect(day.expectedMinutes).toBe(0);
    });

    it('does not call a holiday an absence', async () => {
        const { workspace, member } = await fixture();
        await testPrisma.holiday.create({
            data: { workspaceId: workspace.id, date: toDateColumn(DATE), name: 'Liberation Day' },
        });

        await rollup().recomputeDay(workspace.id, DATE);

        const day = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });
        expect(day.status).toBe('HOLIDAY');
        expect(day.expectedMinutes).toBe(0);
    });

    it('skips somebody hired after the date', async () => {
        // Otherwise every day before their start date shows as an absence.
        const { workspace, member } = await fixture();
        await testPrisma.workspaceMember.updateMany({
            where: { workspaceId: workspace.id, userId: member.id },
            data: { employmentStartDate: toDateColumn('2026-06-01') },
        });

        await rollup().recomputeDay(workspace.id, DATE);

        expect(await testPrisma.attendanceDay.count()).toBe(0);
    });

    it('skips somebody who has left', async () => {
        const { workspace, member } = await fixture();
        await testPrisma.workspaceMember.updateMany({
            where: { workspaceId: workspace.id, userId: member.id },
            data: { employmentEndDate: toDateColumn('2026-01-31') },
        });

        await rollup().recomputeDay(workspace.id, DATE);

        expect(await testPrisma.attendanceDay.count()).toBe(0);
    });

    it('skips somebody not on the clock at all', async () => {
        const { workspace, member } = await fixture();
        await testPrisma.workspaceMember.updateMany({
            where: { workspaceId: workspace.id, userId: member.id },
            data: { attendanceTracked: false },
        });

        await rollup().recomputeDay(workspace.id, DATE);

        expect(await testPrisma.attendanceDay.count()).toBe(0);
    });

    it('measures lateness against the schedule snapshot, past the grace period', async () => {
        const { workspace, member } = await fixture();
        // Due 06:00Z, arrived 06:45Z, 10 minutes grace -> 35 late.
        await testPrisma.workSession.create({
            data: {
                workspaceId: workspace.id,
                userId: member.id,
                clockIn: new Date(`${DATE}T06:45:00.000Z`),
                clockOut: new Date(`${DATE}T14:00:00.000Z`),
                businessDate: toDateColumn(DATE),
                status: 'CLOSED',
                totalMinutes: 435,
                workedMinutes: 435,
                scheduledStartUtc: new Date(`${DATE}T06:00:00.000Z`),
                graceMinutesApplied: 10,
            },
        });

        await rollup().recomputeDay(workspace.id, DATE);

        const day = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });
        expect(day.lateMinutes).toBe(35);
    });

    it('sums several sessions in one day', async () => {
        const { workspace, member } = await fixture();
        await closedSession(workspace.id, member.id, { fromHour: 6, toHour: 10 });
        await closedSession(workspace.id, member.id, { fromHour: 11, toHour: 15 });

        await rollup().recomputeDay(workspace.id, DATE);

        const day = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });
        expect(day.sessionCount).toBe(2);
        expect(day.workedMinutes).toBe(480);
        expect(day.status).toBe('PRESENT');
    });

    it('is idempotent — recomputing changes nothing', async () => {
        // The property the rebuild script depends on.
        const { workspace, member } = await fixture();
        await closedSession(workspace.id, member.id, { fromHour: 6, toHour: 14 });

        await rollup().recomputeDay(workspace.id, DATE);
        const first = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });

        await rollup().recomputeDay(workspace.id, DATE);
        await rollup().recomputeDay(workspace.id, DATE);
        const third = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });

        expect(await testPrisma.attendanceDay.count()).toBe(1);
        expect({ ...third, computedAt: null, id: null })
            .toEqual({ ...first, computedAt: null, id: null });
    });

    it('corrects itself when the underlying sessions change', async () => {
        const { workspace, member } = await fixture();
        await rollup().recomputeDay(workspace.id, DATE);
        expect((await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } })).status)
            .toBe('ABSENT');

        await closedSession(workspace.id, member.id, { fromHour: 6, toHour: 14 });
        await rollup().recomputeDay(workspace.id, DATE);

        const day = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });
        expect(day.status).toBe('PRESENT');
        expect(day.workedMinutes).toBe(480);
    });

    it('never counts more overtime than it measured', async () => {
        const { workspace, member } = await fixture();
        await testPrisma.workSession.create({
            data: {
                workspaceId: workspace.id,
                userId: member.id,
                clockIn: new Date(`${DATE}T06:00:00.000Z`),
                clockOut: new Date(`${DATE}T16:00:00.000Z`),
                businessDate: toDateColumn(DATE),
                status: 'CLOSED',
                totalMinutes: 600,
                workedMinutes: 600,
                rawOvertimeMinutes: 120,
                countedOvertimeMinutes: 0, // tracking off
            },
        });

        await rollup().recomputeDay(workspace.id, DATE);

        const day = await testPrisma.attendanceDay.findFirstOrThrow({ where: { userId: member.id } });
        expect(day.rawOvertimeMinutes).toBe(120);
        expect(day.countedOvertimeMinutes).toBe(0);
    });
});
