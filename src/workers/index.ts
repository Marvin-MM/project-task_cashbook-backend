import { logger } from '../utils/logger';
import { createEmailWorker } from './email.worker';
import { createNotificationsWorker } from './notifications.worker';
// import { createReportsWorker } from './reports.worker';

/**
 * Bootstrap all BullMQ workers.
 * Call this from server.ts after the app starts.
 */
export function startWorkers() {
    logger.info('🚀 Starting BullMQ workers...');

    const emailWorker = createEmailWorker();
    const notificationsWorker = createNotificationsWorker();
    // const reportsWorker = createReportsWorker();

    logger.info('✅ Email worker started (concurrency: 5)');
    logger.info('✅ Notifications worker started (concurrency: 10)');
    // logger.info('✅ Reports worker started (concurrency: 2)');

    return { emailWorker, notificationsWorker };
}

/**
 * Gracefully shut down all workers.
 */
export async function stopWorkers(workers: ReturnType<typeof startWorkers>) {
    logger.info('Shutting down BullMQ workers...');
    await Promise.all([
        workers.emailWorker.close(),
        workers.notificationsWorker.close(),
        // workers.reportsWorker.close(),
    ]);
    logger.info('✅ All workers stopped');
}
