/**
 * Periodic housekeeping for tables that grow without bound.
 *
 * Deliberately a plain setInterval rather than a BullMQ repeatable job, matching
 * deadlineScheduler: these tasks are cheap, idempotent, and harmless to run on
 * every replica.
 */
import { sweepIdempotencyRecords } from '../middlewares/idempotency';
import { logger } from '../utils/logger';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function runSweep(): Promise<void> {
    try {
        const removed = await sweepIdempotencyRecords();
        if (removed > 0) {
            logger.info('[Maintenance] Swept expired idempotency records', { removed });
        }
    } catch (error) {
        logger.error('[Maintenance] Idempotency sweep failed', {
            error: (error as Error).message,
        });
    }
}

export function startMaintenanceScheduler(): NodeJS.Timeout {
    logger.info('[Maintenance] Starting maintenance scheduler (interval: 60 min)');
    void runSweep();
    return setInterval(runSweep, SWEEP_INTERVAL_MS);
}
