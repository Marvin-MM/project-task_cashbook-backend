import { Router } from 'express';
import { container } from 'tsyringe';
import { TasksController } from './tasks.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import {
    createTaskSchema,
    updateTaskSchema,
    changeTaskStatusSchema,
    assignTaskSchema,
    taskQuerySchema,
    createTaskCommentSchema,
    createChecklistItemSchema,
    updateChecklistItemSchema,
} from './tasks.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(TasksController);

router.use(authenticate as any);

// ─── Static paths first ───────────────────────────────
router.get(
    '/',
    requireWorkspaceMember() as any,
    validate(taskQuerySchema, 'query'),
    controller.getTasks.bind(controller) as any,
);

router.post(
    '/',
    requireWorkspaceMember() as any,
    validate(createTaskSchema),
    controller.createTask.bind(controller) as any,
);

// ─── Dynamic :taskId routes ───────────────────────────
// UUID guard fires before anything touches Prisma
router.get(
    '/:taskId',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    controller.getTask.bind(controller) as any,
);

router.patch(
    '/:taskId',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    validate(updateTaskSchema),
    controller.updateTask.bind(controller) as any,
);

router.patch(
    '/:taskId/status',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    validate(changeTaskStatusSchema),
    controller.changeStatus.bind(controller) as any,
);

router.delete(
    '/:taskId',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    controller.deleteTask.bind(controller) as any,
);

router.post(
    '/:taskId/assign',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    validate(assignTaskSchema),
    controller.assignUsers.bind(controller) as any,
);

router.delete(
    '/:taskId/assign/:userId',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId', 'userId'), 'params'),
    controller.unassignUser.bind(controller) as any,
);

// ─── Comments ─────────────────────────────────────────
router.get(
    '/:taskId/comments',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    controller.listComments.bind(controller) as any,
);

router.post(
    '/:taskId/comments',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    validate(createTaskCommentSchema),
    controller.addComment.bind(controller) as any,
);

router.delete(
    '/:taskId/comments/:commentId',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId', 'commentId'), 'params'),
    controller.deleteComment.bind(controller) as any,
);

// ─── Checklist ────────────────────────────────────────
router.get(
    '/:taskId/checklist',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    controller.listChecklist.bind(controller) as any,
);

router.post(
    '/:taskId/checklist',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    validate(createChecklistItemSchema),
    controller.addChecklistItem.bind(controller) as any,
);

router.patch(
    '/:taskId/checklist/:itemId',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId', 'itemId'), 'params'),
    validate(updateChecklistItemSchema),
    controller.updateChecklistItem.bind(controller) as any,
);

router.delete(
    '/:taskId/checklist/:itemId',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId', 'itemId'), 'params'),
    controller.deleteChecklistItem.bind(controller) as any,
);

// ─── Activity ─────────────────────────────────────────
router.get(
    '/:taskId/activity',
    requireWorkspaceMember() as any,
    validate(uuidParams('taskId'), 'params'),
    controller.getTaskActivity.bind(controller) as any,
);

export default router;
