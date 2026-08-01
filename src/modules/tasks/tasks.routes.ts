import { Router } from 'express';
import { container } from 'tsyringe';
import { TasksController } from './tasks.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import { upload } from '../../middlewares/upload';
import {
    createTaskSchema,
    updateTaskSchema,
    changeTaskStatusSchema,
    assignTaskSchema,
    taskQuerySchema,
    createTaskCommentSchema,
    createChecklistItemSchema,
    updateChecklistItemSchema,
    requestAssignmentSchema,
    reviewRequestSchema,
    submitTaskReportSchema,
    reviewTaskReportSchema,
    assignmentRequestQuerySchema,
} from './tasks.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(TasksController);

router.use(authenticate as any);

/*
 * Every route is gated on USE_TASKS, which every role holds — the middleware is
 * answering "may you use this module", not "may you touch this task".
 *
 * Row-level authority stays in TasksService, because it depends on the task:
 * visibility is created-by-me OR assigned-to-me OR in-a-project-I-belong-to,
 * and write authority narrows further to the assignee or someone holding
 * MANAGE_TASKS. A route-level permission cannot express any of that.
 */

// ─── Static paths first ───────────────────────────────
router.get(
    '/',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(taskQuerySchema, 'query'),
    controller.getTasks.bind(controller) as any,
);

router.post(
    '/',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(createTaskSchema),
    controller.createTask.bind(controller) as any,
);

/*
 * Approval and report collections.
 *
 * These MUST stay above `/:taskId`. Express matches in declaration order, so
 * with `/:taskId` first a GET of /assignment-requests binds taskId to the
 * literal string "assignment-requests", the uuid guard rejects it, and the
 * endpoint answers 400 for every caller — which is exactly what it did.
 */
router.get(
    '/assignment-requests',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(assignmentRequestQuerySchema, 'query'),
    controller.listAssignmentRequests.bind(controller) as any,
);

router.post(
    '/assignment-requests/:requestId/review',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('requestId'), 'params'),
    validate(reviewRequestSchema),
    controller.reviewAssignmentRequest.bind(controller) as any,
);

router.post(
    '/assignment-requests/:requestId/withdraw',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('requestId'), 'params'),
    controller.withdrawAssignmentRequest.bind(controller) as any,
);

router.post(
    '/reports/:reportId/review',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('reportId'), 'params'),
    validate(reviewTaskReportSchema),
    controller.reviewReport.bind(controller) as any,
);

router.get(
    '/reports/:reportId/attachments',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('reportId'), 'params'),
    controller.listReportAttachments.bind(controller) as any,
);

router.post(
    '/reports/:reportId/attachments',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('reportId'), 'params'),
    upload.single('file') as any,
    controller.attachToReport.bind(controller) as any,
);

// ─── Dynamic :taskId routes ───────────────────────────
// UUID guard fires before anything touches Prisma
router.get(
    '/:taskId',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    controller.getTask.bind(controller) as any,
);

router.patch(
    '/:taskId',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    validate(updateTaskSchema),
    controller.updateTask.bind(controller) as any,
);

router.patch(
    '/:taskId/status',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    validate(changeTaskStatusSchema),
    controller.changeStatus.bind(controller) as any,
);

router.delete(
    '/:taskId',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    controller.deleteTask.bind(controller) as any,
);

router.post(
    '/:taskId/assign',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    validate(assignTaskSchema),
    controller.assignUsers.bind(controller) as any,
);

router.delete(
    '/:taskId/assign/:userId',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId', 'userId'), 'params'),
    controller.unassignUser.bind(controller) as any,
);

// ─── Comments ─────────────────────────────────────────
router.get(
    '/:taskId/comments',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    controller.listComments.bind(controller) as any,
);

router.post(
    '/:taskId/comments',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    validate(createTaskCommentSchema),
    controller.addComment.bind(controller) as any,
);

router.delete(
    '/:taskId/comments/:commentId',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId', 'commentId'), 'params'),
    controller.deleteComment.bind(controller) as any,
);

// ─── Checklist ────────────────────────────────────────
router.get(
    '/:taskId/checklist',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    controller.listChecklist.bind(controller) as any,
);

router.post(
    '/:taskId/checklist',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    validate(createChecklistItemSchema),
    controller.addChecklistItem.bind(controller) as any,
);

router.patch(
    '/:taskId/checklist/:itemId',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId', 'itemId'), 'params'),
    validate(updateChecklistItemSchema),
    controller.updateChecklistItem.bind(controller) as any,
);

router.delete(
    '/:taskId/checklist/:itemId',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId', 'itemId'), 'params'),
    controller.deleteChecklistItem.bind(controller) as any,
);

// ─── Activity ─────────────────────────────────────────
router.get(
    '/:taskId/activity',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    controller.getTaskActivity.bind(controller) as any,
);

/*
 * Approvals, per task. The collection halves of these live above, with the
 * other literal paths.
 *
 * All USE_TASKS at the door: everybody may ask to take on work and report on
 * work they did. Who may DECIDE is checked per task in the service, because it
 * depends on the task — workspace APPROVE_TASK_WORK, or the per-project
 * PROJECT_MANAGER role for the project this task belongs to.
 */
router.post(
    '/:taskId/assignment-requests',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    validate(requestAssignmentSchema),
    controller.requestAssignment.bind(controller) as any,
);

router.get(
    '/:taskId/reports',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    controller.listReports.bind(controller) as any,
);

router.post(
    '/:taskId/reports',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    validate(submitTaskReportSchema),
    controller.submitReport.bind(controller) as any,
);

/*
 * Attachments. Reuses the same MinIO storage, presigning and soft-delete path
 * as cashbook attachments — Attachment is polymorphic with a CHECK enforcing
 * exactly one owner, so there is one file stack rather than two that drift.
 */
router.get(
    '/:taskId/attachments',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    controller.listTaskAttachments.bind(controller) as any,
);

router.post(
    '/:taskId/attachments',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('taskId'), 'params'),
    upload.single('file') as any,
    controller.attachToTask.bind(controller) as any,
);

export default router;
