/**
 * The queues, and why a test must never reach them.
 *
 * The harness truncates every table between cases. Redis is not truncated, and
 * it is the same Redis the developer's app talks to — so notifications
 * dispatched by a test outlived the users they were addressed to, and the next
 * app start drained hundreds of them into
 *
 *     Foreign key constraint violated: notifications_user_id_fkey
 *
 * three times each. Two independent fixes, one per file: the queue is inert
 * under NODE_ENV=test, and the worker drops a job whose recipient is gone
 * rather than retrying it. Either alone would have stopped the storm; both,
 * because the second is also the correct behaviour in production, where users
 * really do get deleted between enqueue and delivery.
 */
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { emailQueue, notificationsQueue } from '../../config/queues';
import { __notificationInternals } from '../../workers/notifications.worker';

describe('queues are inert under test', () => {
    it('is running as NODE_ENV=test, which is what makes them inert', () => {
        expect(config.NODE_ENV).toBe('test');
    });

    it('accepts a notification without touching Redis', async () => {
        // A real Queue.add would connect and persist. This resolves whether or
        // not Redis is even running, which is the point.
        await expect(
            notificationsQueue.add('TASK_ASSIGNED', {
                type: 'TASK_ASSIGNED',
                userId: 'nobody',
                workspaceId: 'nowhere',
            } as never),
        ).resolves.toBeDefined();
    });

    it('does the same for email', async () => {
        await expect(
            emailQueue.add('send-email', { to: 'nobody@example.com' } as never),
        ).resolves.toBeDefined();
    });

    it('is not a real Queue, so nothing can be scheduled or drained by accident', () => {
        // If someone swaps the stub back for a live Queue, this fails and says
        // why, rather than the pollution reappearing silently months later.
        expect((notificationsQueue as { client?: unknown }).client).toBeUndefined();
    });
});

describe('a notification for a user who no longer exists', () => {
    it('fails with P2003, which is what the worker keys its drop on', async () => {
        // Pins the assumption against a Prisma upgrade: if the code for a
        // foreign key violation ever changes, the worker would go back to
        // retrying dead jobs three times each and this test says so first.
        const { testPrisma } = await import('../setup');

        const error = await testPrisma.notification
            .create({
                data: {
                    userId: '00000000-0000-0000-0000-000000000000',
                    workspaceId: '00000000-0000-0000-0000-000000000000',
                    type: 'TASK_ASSIGNED',
                    title: 'Orphan',
                    body: 'Addressed to nobody',
                },
            })
            .then(() => null)
            .catch((e: unknown) => e);

        expect(error).not.toBeNull();
        expect((error as { code?: string }).code).toBe('P2003');
        expect(__notificationInternals.isMissingReferentError(error)).toBe(true);
    });

    it('does not treat an ordinary failure as droppable', async () => {
        // A connection blip must still be retried.
        expect(__notificationInternals.isMissingReferentError(new Error('ECONNRESET'))).toBe(false);
        expect(__notificationInternals.isMissingReferentError({ code: 'P1001' })).toBe(false);
    });
});
