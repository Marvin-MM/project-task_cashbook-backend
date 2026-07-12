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

export default router;
