import { getPrismaClient } from '../config/database';
import { notificationsQueue } from '../config/queues';
import { NotificationType } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = getPrismaClient();

const DUE_SOON_WINDOW_MS  = 24 * 60 * 60 * 1000;  // 24 hours
const DUE_SOON_COOLDOWN_H = 24;                     // don't re-notify within 24 h
const OVERDUE_COOLDOWN_H  = 6;                      // don't re-notify within 6 h
const SCAN_INTERVAL_MS    = 15 * 60 * 1000;         // scan every 15 minutes

/**
 * Dispatch a notification job, guarded by a cooldown window so users
 * are not spammed. Returns true if the job was dispatched.
 */
async function dispatchIfNotCoolingDown(
    userId: string,
    workspaceId: string,
    taskId: string,
    taskTitle: string,
    type: NotificationType,
    cooldownHours: number,
): Promise<boolean> {
    const since = new Date(Date.now() - cooldownHours * 3_600_000);
    const recent = await prisma.notification.findFirst({
        where: { userId, workspaceId, taskId, type, createdAt: { gte: since } },
    });
    if (recent) return false;

    await notificationsQueue.add(type, {
        type,
        userId,
        workspaceId,
        taskId,
        taskTitle,
    });
    return true;
}

async function scanDueSoon(): Promise<void> {
    const now = new Date();
    const window = new Date(now.getTime() + DUE_SOON_WINDOW_MS);

    const tasks = await prisma.task.findMany({
        where: {
            dueDate: { gte: now, lte: window },
            status: { notIn: ['DONE'] },
        },
        include: {
            assignments: { select: { userId: true } },
        },
    });

    let dispatched = 0;
    for (const task of tasks) {
        for (const { userId } of task.assignments) {
            const sent = await dispatchIfNotCoolingDown(
                userId,
                task.workspaceId,
                task.id,
                task.title,
                NotificationType.TASK_DUE_SOON,
                DUE_SOON_COOLDOWN_H,
            );
            if (sent) dispatched++;
        }
    }

    if (dispatched > 0) logger.info(`[Scheduler] Dispatched ${dispatched} DUE_SOON notifications`);
}

async function scanOverdue(): Promise<void> {
    const now = new Date();

    const tasks = await prisma.task.findMany({
        where: {
            dueDate: { lt: now },
            status: { notIn: ['DONE'] },
        },
        include: {
            assignments: { select: { userId: true } },
        },
    });

    let dispatched = 0;
    for (const task of tasks) {
        for (const { userId } of task.assignments) {
            const sent = await dispatchIfNotCoolingDown(
                userId,
                task.workspaceId,
                task.id,
                task.title,
                NotificationType.TASK_OVERDUE,
                OVERDUE_COOLDOWN_H,
            );
            if (sent) dispatched++;
        }
    }

    if (dispatched > 0) logger.info(`[Scheduler] Dispatched ${dispatched} TASK_OVERDUE notifications`);
}

async function runScan(): Promise<void> {
    try {
        await Promise.all([scanDueSoon(), scanOverdue()]);
    } catch (err: any) {
        logger.error('[Scheduler] Deadline scan error', { error: err?.message });
    }
}

/**
 * Start the deadline scheduler. Runs a scan every 15 minutes.
 * Returns the interval handle so it can be cleared on graceful shutdown.
 */
export function startDeadlineScheduler(): NodeJS.Timeout {
    logger.info('[Scheduler] Starting deadline scheduler (interval: 15 min)');

    // Run once immediately on startup, then repeat
    void runScan();

    return setInterval(runScan, SCAN_INTERVAL_MS);
}
