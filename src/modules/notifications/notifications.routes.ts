import { Router } from 'express';
import { container } from 'tsyringe';
import { NotificationsController } from './notifications.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import { notificationQuerySchema, markReadSchema } from './notifications.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(NotificationsController);

router.use(authenticate as any);

// ─── Static paths first ───────────────────────────────
router.get(
    '/',
    requireWorkspaceMember() as any,
    validate(notificationQuerySchema, 'query'),
    controller.getNotifications.bind(controller) as any,
);

router.patch(
    '/mark-read',
    requireWorkspaceMember() as any,
    validate(markReadSchema),
    controller.markAsRead.bind(controller) as any,
);

router.patch(
    '/mark-all-read',
    requireWorkspaceMember() as any,
    controller.markAllRead.bind(controller) as any,
);

// ─── Dynamic :notificationId routes ───────────────────
router.delete(
    '/:notificationId',
    requireWorkspaceMember() as any,
    validate(uuidParams('notificationId'), 'params'),
    controller.deleteNotification.bind(controller) as any,
);

export default router;
