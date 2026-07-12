import { z } from 'zod';
import { NotificationType } from '@prisma/client';

export const notificationQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    isRead: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
    type: z.nativeEnum(NotificationType).optional(),
});

export const markReadSchema = z.object({
    ids: z.array(z.string().uuid()).min(1, 'At least one notification ID is required'),
});

export type NotificationQueryDto = z.infer<typeof notificationQuerySchema>;
export type MarkReadDto = z.infer<typeof markReadSchema>;
