import { Router } from 'express';
import { container } from 'tsyringe';
import { TimeTrackingController } from './time-tracking.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
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
} from './time-tracking.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(TimeTrackingController);

router.use(authenticate as any);

// ─── Time Entries ─────────────────────────────────────
// NOTE: static paths (/entries, /entries/active-timer) MUST come before
// the dynamic /:entryId route so Express does not swallow them as param values.
router.get(
    '/entries',
    requireWorkspaceMember() as any,
    validate(timeEntryQuerySchema, 'query'),
    controller.getTimeEntries.bind(controller) as any,
);

router.post(
    '/entries',
    requireWorkspaceMember() as any,
    validate(createTimeEntrySchema),
    controller.createTimeEntry.bind(controller) as any,
);

router.get(
    '/entries/active-timer',
    requireWorkspaceMember() as any,
    controller.getActiveTimer.bind(controller) as any,
);

router.get(
    '/summary',
    requireWorkspaceMember() as any,
    validate(timeSummaryQuerySchema, 'query'),
    controller.getTimeSummary.bind(controller) as any,
);

// Dynamic param routes — UUID guard returns 422 before Prisma is ever called
router.get(
    '/entries/:entryId',
    requireWorkspaceMember() as any,
    validate(uuidParams('entryId'), 'params'),
    controller.getTimeEntry.bind(controller) as any,
);

router.patch(
    '/entries/:entryId',
    requireWorkspaceMember() as any,
    validate(uuidParams('entryId'), 'params'),
    validate(updateTimeEntrySchema),
    controller.updateTimeEntry.bind(controller) as any,
);

router.delete(
    '/entries/:entryId',
    requireWorkspaceMember() as any,
    validate(uuidParams('entryId'), 'params'),
    controller.deleteTimeEntry.bind(controller) as any,
);

router.post(
    '/entries/:entryId/lock',
    requireWorkspaceMember() as any,
    validate(uuidParams('entryId'), 'params'),
    validate(lockTimeEntrySchema),
    controller.setTimeEntryLock.bind(controller) as any,
);

// ─── Timer ────────────────────────────────────────────
// Static paths — no UUID params needed
router.post(
    '/timer/start',
    requireWorkspaceMember() as any,
    validate(startTimerSchema),
    controller.startTimer.bind(controller) as any,
);

router.post(
    '/timer/stop',
    requireWorkspaceMember() as any,
    controller.stopTimer.bind(controller) as any,
);

// ─── Work Sessions ────────────────────────────────────
// Static paths first
router.get(
    '/sessions',
    requireWorkspaceMember() as any,
    validate(workSessionQuerySchema, 'query'),
    controller.getWorkSessions.bind(controller) as any,
);

router.get(
    '/sessions/active',
    requireWorkspaceMember() as any,
    controller.getActiveSession.bind(controller) as any,
);

router.post(
    '/sessions/clock-in',
    requireWorkspaceMember() as any,
    validate(clockInSchema),
    controller.clockIn.bind(controller) as any,
);

router.post(
    '/sessions/clock-out',
    requireWorkspaceMember() as any,
    validate(clockOutSchema),
    controller.clockOut.bind(controller) as any,
);

export default router;
