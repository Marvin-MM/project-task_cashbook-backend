/**
 * Attendance actions that belong to a person rather than to a workspace.
 *
 * Mounted outside `/workspaces/:workspaceId` on purpose. The one-open-session
 * rule is global, so a session left open in workspace A blocks clocking in to
 * workspace B — and the person may no longer be able to address workspace A at
 * all. Every route here is scoped to `req.user.userId`, which is why it is safe
 * for it to reach across workspace boundaries when nothing else may.
 */
import { Router } from 'express';
import { container } from 'tsyringe';
import { TimeTrackingController } from './time-tracking.controller';
import { authenticate } from '../../middlewares/authenticate';

const router = Router();
const controller = container.resolve(TimeTrackingController);

router.use(authenticate as any);

/** Close my open session, wherever it is. */
router.post(
    '/close-open-session',
    controller.closeMyOpenSession.bind(controller) as any,
);

export default router;
