import { Router } from 'express';
import { AdminController } from './admin.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireSuperAdmin } from '../../middlewares/authorize';

const router = Router();
const adminController = new AdminController();

router.use(authenticate as any);
router.use(requireSuperAdmin() as any);

router.get('/users', adminController.listUsers.bind(adminController) as any);
router.patch('/users/:userId/toggle-status', adminController.toggleUserStatus.bind(adminController) as any);
router.get('/stats', adminController.getStats.bind(adminController) as any);
router.get('/workspaces', adminController.listWorkspaces.bind(adminController) as any);

export default router;
