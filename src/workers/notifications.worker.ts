import { Worker, Job } from 'bullmq';
import { bullmqConnection } from '../config/queues';
import { getPrismaClient } from '../config/database';
import { NotificationType } from '@prisma/client';
import { logger } from '../utils/logger';
import { NotificationJobData } from '../modules/notifications/notifications.service';

const prisma = getPrismaClient();

function buildNotificationContent(job: Job<NotificationJobData>): { title: string; body: string } {
    const { type, taskTitle, customTitle, customBody } = job.data;

    if (customTitle && customBody) return { title: customTitle, body: customBody };

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
            const { type, userId, workspaceId, taskId } = job.data;

            logger.info('Processing notification job', { jobId: job.id, type, userId });

            const { title, body } = buildNotificationContent(job);

            await prisma.notification.create({
                data: {
                    userId,
                    workspaceId,
                    type,
                    title,
                    body,
                    taskId: taskId ?? null,
                },
            });

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
