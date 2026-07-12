import { injectable, inject } from 'tsyringe';
import { PrismaClient, NotificationType } from '@prisma/client';
import { NotFoundError, AuthorizationError } from '../../core/errors/AppError';
import { notificationsQueue } from '../../config/queues';
import { NotificationQueryDto, MarkReadDto } from './notifications.dto';

export interface CreateNotificationData {
    userId: string;
    workspaceId: string;
    type: NotificationType;
    title: string;
    body: string;
    taskId?: string | null;
}

export interface NotificationJobData {
    type: NotificationType;
    userId: string;
    workspaceId: string;
    taskId?: string;
    taskTitle?: string;
    /** For scheduler-triggered jobs — overdue/due-soon message. */
    customTitle?: string;
    customBody?: string;
}

@injectable()
export class NotificationsService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) {}

    // ─── Query ────────────────────────────────────────────────
    async getUserNotifications(userId: string, workspaceId: string, query: NotificationQueryDto) {
        // Safe pagination defaults at service layer (no separate repo method, query is simple)
        const page  = Math.max(1, Number(query.page)  || 1);
        const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
        const skip  = (page - 1) * limit;

        const { isRead, type } = query;

        const where: any = { userId, workspaceId };
        if (isRead !== undefined) where.isRead = isRead;
        if (type) where.type = type;

        const [notifications, total] = await Promise.all([
            this.prisma.notification.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: { task: { select: { id: true, title: true } } },
            }),
            this.prisma.notification.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);
        return {
            data: notifications,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1,
            },
        };
    }

    // ─── Mutations ────────────────────────────────────────────
    async markAsRead(userId: string, workspaceId: string, dto: MarkReadDto) {
        // Ensure all IDs belong to the calling user
        const count = await this.prisma.notification.count({
            where: { id: { in: dto.ids }, userId, workspaceId },
        });
        if (count !== dto.ids.length) {
            throw new AuthorizationError('Some notifications do not belong to you');
        }

        await this.prisma.notification.updateMany({
            where: { id: { in: dto.ids } },
            data: { isRead: true, readAt: new Date() },
        });
    }

    async markAllRead(userId: string, workspaceId: string) {
        await this.prisma.notification.updateMany({
            where: { userId, workspaceId, isRead: false },
            data: { isRead: true, readAt: new Date() },
        });
    }

    async deleteNotification(notificationId: string, userId: string, workspaceId: string) {
        const n = await this.prisma.notification.findUnique({ where: { id: notificationId } });
        if (!n || n.userId !== userId || n.workspaceId !== workspaceId) {
            throw new NotFoundError('Notification');
        }
        await this.prisma.notification.delete({ where: { id: notificationId } });
    }

    // ─── Internal — used by worker ────────────────────────────
    async createNotification(data: CreateNotificationData) {
        return this.prisma.notification.create({ data });
    }

    // ─── Dispatch to queue (non-blocking) ────────────────────
    static dispatch(data: NotificationJobData): void {
        notificationsQueue.add(data.type, data).catch(() => {});
    }
}
