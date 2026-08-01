import { Router } from 'express';
import { container } from 'tsyringe';
import { PlatformController } from './platform.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireSuperAdmin } from '../../middlewares/authorize';

const router = Router();
const controller = container.resolve(PlatformController);

router.use(authenticate as any);
router.use(requireSuperAdmin() as any);

router.get('/stats', controller.getStats.bind(controller) as any);

router.get('/users', controller.listUsers.bind(controller) as any);
router.patch('/users/:userId/toggle-status', controller.toggleUserStatus.bind(controller) as any);

router.get('/workspaces', controller.listWorkspaces.bind(controller) as any);

router.get('/audit-logs', controller.listAuditLogs.bind(controller) as any);

// Read-only: the env var is the source of truth, so there is no grant/revoke
// endpoint. `reconcile` re-applies it without waiting for a restart.
router.get('/super-admins', controller.listSuperAdmins.bind(controller) as any);
router.post('/super-admins/reconcile', controller.reconcileSuperAdmins.bind(controller) as any);

export default router;
