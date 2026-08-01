import { Router } from 'express';
import { container } from 'tsyringe';
import { TimeTrackingController } from './time-tracking.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import {
    createTimeEntrySchema,
    updateTimeEntrySchema,
    startTimerSchema,
    clockInSchema,
    clockOutSchema,
    timeEntryQuerySchema,
    workSessionQuerySchema,
    lockTimeEntrySchema,
    timeSummaryQuerySchema,
    attendanceSettingsSchema,
    createWorkSessionSchema,
    updateWorkSessionSchema,
} from './time-tracking.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(TimeTrackingController);

router.use(authenticate as any);

/*
 * USE_TIME_TRACKING is held by every role: everyone clocks in and logs their own
 * time. What differs is whose data you may see and change, and that is decided
 * in the service against named permissions —
 *
 *   VIEW_ALL_ATTENDANCE   see other people's sessions and totals
 *   EDIT_OTHERS_TIME      edit, lock or adjust someone else's record
 *   LOG_TIME_ON_BEHALF    record attendance under someone else's name
 *   MANAGE_ATTENDANCE     change the workspace's attendance policy
 *
 * — because most of these endpoints serve both cases depending on whether a
 * userId filter is present.
 */

// ─── Time Entries ─────────────────────────────────────
// NOTE: static paths (/entries, /entries/active-timer) MUST come before
// the dynamic /:entryId route so Express does not swallow them as param values.
router.get(
    '/entries',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(timeEntryQuerySchema, 'query'),
    controller.getTimeEntries.bind(controller) as any,
);

router.post(
    '/entries',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(createTimeEntrySchema),
    controller.createTimeEntry.bind(controller) as any,
);

router.get(
    '/entries/active-timer',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.getActiveTimer.bind(controller) as any,
);

router.get(
    '/summary',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(timeSummaryQuerySchema, 'query'),
    controller.getTimeSummary.bind(controller) as any,
);

router.get(
    '/settings',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.getAttendanceSettings.bind(controller) as any,
);

router.put(
    '/settings',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(attendanceSettingsSchema),
    controller.updateAttendanceSettings.bind(controller) as any,
);

// Dynamic param routes — UUID guard returns 422 before Prisma is ever called
router.get(
    '/entries/:entryId',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('entryId'), 'params'),
    controller.getTimeEntry.bind(controller) as any,
);

router.patch(
    '/entries/:entryId',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('entryId'), 'params'),
    validate(updateTimeEntrySchema),
    controller.updateTimeEntry.bind(controller) as any,
);

router.delete(
    '/entries/:entryId',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('entryId'), 'params'),
    controller.deleteTimeEntry.bind(controller) as any,
);

router.post(
    '/entries/:entryId/lock',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('entryId'), 'params'),
    validate(lockTimeEntrySchema),
    controller.setTimeEntryLock.bind(controller) as any,
);

// ─── Timer ────────────────────────────────────────────
// Static paths — no UUID params needed
router.post(
    '/timer/start',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(startTimerSchema),
    controller.startTimer.bind(controller) as any,
);

router.post(
    '/timer/stop',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.stopTimer.bind(controller) as any,
);

// ─── Work Sessions ────────────────────────────────────
// Static paths first
router.get(
    '/sessions',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(workSessionQuerySchema, 'query'),
    controller.getWorkSessions.bind(controller) as any,
);

router.get(
    '/sessions/active',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    controller.getActiveSession.bind(controller) as any,
);

router.post(
    '/sessions/manual',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(createWorkSessionSchema),
    controller.createWorkSession.bind(controller) as any,
);

router.post(
    '/sessions/clock-in',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(clockInSchema),
    controller.clockIn.bind(controller) as any,
);

router.post(
    '/sessions/clock-out',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(clockOutSchema),
    controller.clockOut.bind(controller) as any,
);

router.patch(
    '/sessions/:sessionId',
    requireWorkspaceMember(WorkspacePermission.USE_TIME_TRACKING) as any,
    validate(uuidParams('sessionId'), 'params'),
    validate(updateWorkSessionSchema),
    controller.updateWorkSession.bind(controller) as any,
);

export default router;
