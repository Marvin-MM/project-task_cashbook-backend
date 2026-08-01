import { Worker, Job } from 'bullmq';
import { bullmqConnection } from '../config/queues';
import { getPrismaClient } from '../config/database';
import { NotificationType } from '@prisma/client';
import { logger } from '../utils/logger';
import { NotificationJobData } from '../modules/notifications/notifications.service';

const prisma = getPrismaClient();

/**
 * Is this "the row I point at is gone" rather than a transient fault?
 *
 * P2003 is a foreign key violation and P2025 is a required record not found.
 * Both are permanent for a notification: the recipient does not exist, and no
 * amount of waiting will change that. Everything else — a dropped connection,
 * a deadlock, the database restarting — is worth the retry.
 */
function isMissingReferentError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    return code === 'P2003' || code === 'P2025';
}

function buildNotificationContent(job: Job<NotificationJobData>): { title: string; body: string } {
    const { type, taskTitle, customTitle, customBody, title, body } = job.data;

    if (customTitle && customBody) return { title: customTitle, body: customBody };
    // Approval flows compose their own wording — the message depends on the
    // task title and the reviewer's note, neither of which a switch here knows.
    if (title && body) return { title, body };

    switch (type) {
        case NotificationType.TASK_ASSIGNED:
            return {
                title: 'New Task Assigned',
                body: `You have been assigned to: "${taskTitle ?? 'a task'}"`,
            };
        case NotificationType.TASK_DUE_SOON:
            return {
                title: 'Task Due Soon',
                body: `"${taskTitle ?? 'A task'}" is due within 24 hours`,
            };
        case NotificationType.TASK_OVERDUE:
            return {
                title: 'Task Overdue',
                body: `"${taskTitle ?? 'A task'}" is past its due date`,
            };
        default:
            return { title: 'Notification', body: 'You have a new notification' };
    }
}

export function createNotificationsWorker(): Worker<NotificationJobData> {
    const worker = new Worker<NotificationJobData>(
        'notifications',
        async (job: Job<NotificationJobData>) => {
            const { type, userId, workspaceId, taskId, entityType, entityId, groupKey } = job.data;

            logger.info('Processing notification job', { jobId: job.id, type, userId });

            const { title, body } = buildNotificationContent(job);
            const data = {
                userId,
                workspaceId,
                type,
                title,
                body,
                taskId: taskId ?? null,
                entityType: entityType ?? (taskId ? 'TASK' : null),
                entityId: entityId ?? taskId ?? null,
                groupKey: groupKey ?? null,
            };

            try {
                if (groupKey) {
                    // Upsert on the dedupe key so a retried job, or the same
                    // event arriving by two paths, updates one row instead of
                    // stacking up duplicates in the bell menu.
                    await prisma.notification.upsert({
                        where: { userId_type_groupKey: { userId, type, groupKey } },
                        create: data,
                        update: { title, body, isRead: false, readAt: null },
                    });
                } else {
                    await prisma.notification.create({ data });
                }
            } catch (error) {
                if (isMissingReferentError(error)) {
                    // The user or workspace this was addressed to no longer
                    // exists — an account closed, a workspace deleted, or a
                    // test database truncated under a shared Redis. Retrying
                    // cannot bring them back, so three attempts with backoff
                    // just turns one dead job into three noisy ones. Drop it.
                    logger.warn('Notification dropped: recipient no longer exists', {
                        jobId: job.id, type, userId, workspaceId,
                    });
                    return;
                }
                throw error;
            }

            logger.info('Notification created', { jobId: job.id, userId, type });
        },
        {
            connection: bullmqConnection,
            concurrency: 10,
        },
    );

    worker.on('failed', (job, err) => {
        logger.error('Notification job failed', {
            jobId: job?.id,
            type: job?.data?.type,
            userId: job?.data?.userId,
            error: err.message,
        });
    });

    worker.on('completed', (job) => {
        logger.debug('Notification job completed', { jobId: job.id });
    });

    return worker;
}

/** Exported for tests: the classification is the whole of the drop decision. */
export const __notificationInternals = { isMissingReferentError };
