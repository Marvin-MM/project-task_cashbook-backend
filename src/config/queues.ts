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

// ─── Queues ────────────────────────────────────────────

export const emailQueue = new Queue('email', {
    connection: bullmqConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
    },
});

export const reportsQueue = new Queue('reports', {
    connection: bullmqConnection,
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
    },
});
