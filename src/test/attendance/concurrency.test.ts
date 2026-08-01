/**
 * Concurrent attendance writes.
 *
 * Every assertion here checks the DATABASE STATE, not the status code. "One
 * request 409'd" is compatible with two rows having been written and one
 * request happening to lose a later race; "exactly one row exists" is not.
 *
 * The guard being tested used to be a findFirst plus an in-transaction
 * re-check under READ COMMITTED, which serializes nothing — each statement
 * takes a fresh snapshot, so two concurrent clock-ins could both see "no open
 * session" and both insert. Migration 0008 added the partial unique index that
 * makes it real, which also made the previously-unreachable P2002 handlers live.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { TimeTrackingService } from '../../modules/time-tracking/time-tracking.service';
import { addWorkspaceMember, createOpenWorkSession, createUser, createWorkspace } from '../factories';
import { clearClockCache } from '../../core/time/workspace-clock';

const service = () => resolveService(TimeTrackingService);

/** Run n copies of an operation and report how many resolved vs rejected. */
async function race<T>(n: number, op: () => Promise<T>) {
    const results = await Promise.allSettled(Array.from({ length: n }, op));
    return {
        fulfilled: results.filter((r) => r.status === 'fulfilled').length,
        rejected: results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[],
    };
}

beforeEach(async () => {
    await resetDatabase();
    clearClockCache();
});

describe('clock-in', () => {
    it('writes exactly one session when two devices race', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);

        const { fulfilled } = await race(2, () => service().clockIn(workspace.id, user.id, {}));

        const sessions = await testPrisma.workSession.findMany({ where: { userId: user.id } });
        expect(sessions).toHaveLength(1);
        expect(fulfilled).toBe(1);
    });

    it('holds under heavier contention', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);

        await race(8, () => service().clockIn(workspace.id, user.id, {}));

        const open = await testPrisma.workSession.count({
            where: { userId: user.id, clockOut: null },
        });
        expect(open).toBe(1);
    });

    it('cannot open a second session in a different organisation', async () => {
        const user = await createUser();
        const orgA = await createWorkspace(user.id, { name: 'Acme Ltd' });
        const orgB = await createWorkspace(user.id, { name: 'Beta Ltd' });

        const results = await Promise.allSettled([
            service().clockIn(orgA.id, user.id, {}),
            service().clockIn(orgB.id, user.id, {}),
        ]);

        const sessions = await testPrisma.workSession.findMany({ where: { userId: user.id } });
        expect(sessions).toHaveLength(1);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('lets two different people clock in at the same time', async () => {
        // The constraint is per user; it must not serialize the whole workspace.
        const alice = await createUser();
        const bob = await createUser();
        const workspace = await createWorkspace(alice.id);
        await addWorkspaceMember(workspace.id, bob.id);

        const results = await Promise.allSettled([
            service().clockIn(workspace.id, alice.id, {}),
            service().clockIn(workspace.id, bob.id, {}),
        ]);

        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        expect(await testPrisma.workSession.count({ where: { clockOut: null } })).toBe(2);
    });

    it('surfaces the collision as a 409, not a raw database error', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);

        const { rejected } = await race(2, () => service().clockIn(workspace.id, user.id, {}));

        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatchObject({ statusCode: 409 });
    });
});

describe('the database is the backstop, not the service', () => {
    it('refuses a second open session written directly, bypassing every check', async () => {
        // If this passes, the guarantee survives any future code path that
        // forgets to look before it inserts.
        const user = await createUser();
        const workspace = await createWorkspace(user.id);
        await createOpenWorkSession(workspace.id, user.id);

        await expect(createOpenWorkSession(workspace.id, user.id)).rejects.toMatchObject({
            code: 'P2002',
        });
    });

    it('allows a second session once the first is closed', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);
        await createOpenWorkSession(workspace.id, user.id);
        await service().clockOut(workspace.id, user.id, {});

        await expect(createOpenWorkSession(workspace.id, user.id)).resolves.toBeTruthy();
    });

    it('refuses a half-closed row: a clockOut with status still OPEN', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);
        const session = await createOpenWorkSession(workspace.id, user.id);

        await expect(
            testPrisma.$executeRawUnsafe(
                `UPDATE work_sessions SET clock_out = NOW(), total_minutes = 10 WHERE id = $1::uuid`,
                session.id,
            ),
        ).rejects.toThrow(/work_sessions_open_state/);
    });

    it('refuses a closed row with no minutes', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);
        const session = await createOpenWorkSession(workspace.id, user.id);

        await expect(
            testPrisma.$executeRawUnsafe(
                `UPDATE work_sessions SET clock_out = NOW(), status = 'CLOSED' WHERE id = $1::uuid`,
                session.id,
            ),
        ).rejects.toThrow(/work_sessions_closed_has_minutes/);
    });

    it('refuses a session that ends before it starts', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);
        const session = await createOpenWorkSession(workspace.id, user.id);

        await expect(
            testPrisma.$executeRawUnsafe(
                `UPDATE work_sessions
                 SET clock_out = clock_in - INTERVAL '1 hour', total_minutes = 0, status = 'CLOSED'
                 WHERE id = $1::uuid`,
                session.id,
            ),
        ).rejects.toThrow(/work_sessions_ordered/);
    });
});

describe('clock-out', () => {
    it('closes the session exactly once when two requests race', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);
        const session = await createOpenWorkSession(workspace.id, user.id, {
            clockIn: new Date(Date.now() - 30 * 60 * 1000),
        });

        const { fulfilled } = await race(2, () => service().clockOut(workspace.id, user.id, {}));

        expect(fulfilled).toBe(1);
        const after = await testPrisma.workSession.findUniqueOrThrow({ where: { id: session.id } });
        expect(after.status).toBe('CLOSED');
        expect(after.totalMinutes).toBe(30);
    });

    it('does not overwrite a session someone else already closed', async () => {
        // Stands in for the auto-close job racing a real clock-out: the loser
        // must no-op rather than rewrite the winner's clockOut.
        const user = await createUser();
        const workspace = await createWorkspace(user.id);
        const session = await createOpenWorkSession(workspace.id, user.id);

        await service().closeMyOpenSession(user.id);
        const closedAt = (await testPrisma.workSession.findUniqueOrThrow({
            where: { id: session.id },
        })).clockOut;

        await expect(service().clockOut(workspace.id, user.id, {})).rejects.toBeTruthy();

        const after = await testPrisma.workSession.findUniqueOrThrow({ where: { id: session.id } });
        expect(after.clockOut).toEqual(closedAt);
        expect(after.closureReason).toBe('USER_SWITCH');
    });
});

describe('timers', () => {
    it('starts exactly one timer when two requests race', async () => {
        const user = await createUser();
        const workspace = await createWorkspace(user.id);
        const project = await testPrisma.project.create({
            data: { workspaceId: workspace.id, name: 'Racing', createdById: user.id },
        });

        await race(4, () => service().startTimer(workspace.id, user.id, { projectId: project.id }));

        const running = await testPrisma.timeEntry.count({
            where: { userId: user.id, endTime: null, source: 'TIMER' },
        });
        expect(running).toBe(1);
    });
});
