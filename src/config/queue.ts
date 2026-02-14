import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { getRedisClient } from './redis';
import { logger } from '../utils/logger';

const queues: Map<string, Queue> = new Map();
const workers: Map<string, Worker> = new Map();

export const QUEUE_NAMES = {
    REPORTS: 'reports',
    EMAILS: 'emails',
} as const;

export function getQueue(name: string): Queue {
    if (!queues.has(name)) {
        const queue = new Queue(name, {
            connection: getRedisClient() as any,
            defaultJobOptions: {
                removeOnComplete: { count: 100 },
                removeOnFail: { count: 500 },
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000,
                },
            },
        });
        queues.set(name, queue);
    }
    return queues.get(name)!;
}

export function createWorker<T = any>(
    queueName: string,
    processor: (job: Job<T>) => Promise<any>,
    concurrency = 3
): Worker {
    const worker = new Worker(queueName, processor, {
        connection: getRedisClient() as any,
        concurrency,
    });

    worker.on('completed', (job: Job) => {
        logger.info(`Job completed: ${queueName}`, { jobId: job.id, jobName: job.name });
    });

    worker.on('failed', (job: Job | undefined, error: Error) => {
        logger.error(`Job failed: ${queueName}`, {
            jobId: job?.id,
            jobName: job?.name,
            error: error.message,
            attemptsMade: job?.attemptsMade,
        });
    });

    worker.on('error', (error: Error) => {
        logger.error(`Worker error: ${queueName}`, { error: error.message });
    });

    workers.set(queueName, worker);
    return worker;
}

export function getQueueEvents(queueName: string): QueueEvents {
    return new QueueEvents(queueName, {
        connection: getRedisClient() as any,
    });
}

export async function closeAllQueues(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const [name, worker] of workers) {
        logger.info(`Closing worker: ${name}`);
        closePromises.push(worker.close());
    }

    for (const [name, queue] of queues) {
        logger.info(`Closing queue: ${name}`);
        closePromises.push(queue.close());
    }

    await Promise.allSettled(closePromises);
    workers.clear();
    queues.clear();
    logger.info('All queues and workers closed');
}
