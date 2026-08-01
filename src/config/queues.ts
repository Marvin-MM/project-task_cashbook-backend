import { Queue } from 'bullmq';
import { config } from './index';

/**
 * Parse REDIS_URL into BullMQ-compatible connection options.
 */
function parseBullmqConnection() {
    const url = new URL(config.REDIS_URL);
    return {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
        db: url.pathname ? Number(url.pathname.slice(1)) || 0 : 0,
        tls: url.protocol === 'rediss:' ? {} : undefined,
    };
}

export const bullmqConnection = parseBullmqConnection();

/**
 * Under test, enqueueing is a no-op.
 *
 * This is not tidiness — it fixes a real failure. The test harness truncates
 * every table between cases, but Redis is not truncated and it is the SAME
 * Redis the developer's app uses. So every notification a test dispatched sat
 * in the shared `notifications` queue referring to a user the truncate had
 * already deleted, and the next time the app started its worker drained
 * hundreds of them into
 *
 *     Foreign key constraint violated: notifications_user_id_fkey
 *
 * three times each, thanks to the retry policy. It "stabilised" only once the
 * backlog was exhausted.
 *
 * A separate Redis database or a BullMQ `prefix` would isolate the two, but it
 * would still accumulate jobs nothing ever consumes. Tests run no worker, so a
 * job they enqueue can only ever be litter. Dispatch is fire-and-forget in
 * every caller (`.catch(() => {})`), so a resolved promise is a faithful stand
 * in — and no test asserts on queue contents. If one ever needs to, it should
 * assert on the service call, not on Redis.
 */
const INERT = config.NODE_ENV === 'test';

type Enqueueable = Pick<Queue, 'add'>;

function makeQueue(name: string, removeOnComplete: number): Enqueueable {
    if (INERT) {
        return {
            add: async () => ({ id: `inert-${name}` }),
        } as unknown as Queue;
    }

    return new Queue(name, {
        connection: bullmqConnection,
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000,
            },
            removeOnComplete: { count: removeOnComplete },
            // Keep failures around long enough to diagnose, but bounded: a bad
            // deploy that fails every job must not fill Redis.
            removeOnFail: { count: 5000 },
        },
    });
}

// ─── Queues ────────────────────────────────────────────

export const emailQueue = makeQueue('email', 1000);

export const notificationsQueue = makeQueue('notifications', 2000);
