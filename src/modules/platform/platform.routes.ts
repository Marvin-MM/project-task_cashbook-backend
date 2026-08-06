import { Router } from 'express';
import { container } from 'tsyringe';
import { PlatformController } from './platform.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireSuperAdmin } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import { setWorkspaceFeatureSchema } from './platform.dto';

const router = Router();
const controller = container.resolve(PlatformController);

router.use(authenticate as any);
router.use(requireSuperAdmin() as any);

router.get('/stats', controller.getStats.bind(controller) as any);

router.get('/users', controller.listUsers.bind(controller) as any);
router.patch('/users/:userId/toggle-status', controller.toggleUserStatus.bind(controller) as any);

router.get('/workspaces', controller.listWorkspaces.bind(controller) as any);

// Unlocking a module for one organisation. The only write this module has ever
// had against a workspace — everything else here is read-only by design.
router.patch(
    '/workspaces/:workspaceId/features',
    validate(uuidParams('workspaceId'), 'params'),
    validate(setWorkspaceFeatureSchema),
    controller.setWorkspaceFeature.bind(controller) as any,
);

router.get('/audit-logs', controller.listAuditLogs.bind(controller) as any);

// Read-only: the env var is the source of truth, so there is no grant/revoke
// endpoint. `reconcile` re-applies it without waiting for a restart.
router.get('/super-admins', controller.listSuperAdmins.bind(controller) as any);
router.post('/super-admins/reconcile', controller.reconcileSuperAdmins.bind(controller) as any);

export default router;
