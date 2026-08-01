import { Router } from 'express';
import { container } from 'tsyringe';
import { PaymentModesController } from './payment-modes.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { createPaymentModeSchema, updatePaymentModeSchema } from './payment-modes.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(PaymentModesController);

router.use(authenticate as any);

router.get('/:workspaceId', requireWorkspaceMember(WorkspacePermission.VIEW_WORKSPACE) as any, controller.getAll.bind(controller) as any);
router.post('/:workspaceId', requireWorkspaceMember(WorkspacePermission.MANAGE_REFERENCE_DATA) as any, validate(createPaymentModeSchema), controller.create.bind(controller) as any);
router.patch('/:workspaceId/:paymentModeId', requireWorkspaceMember(WorkspacePermission.MANAGE_REFERENCE_DATA) as any, validate(updatePaymentModeSchema), controller.update.bind(controller) as any);
router.delete('/:workspaceId/:paymentModeId', requireWorkspaceMember(WorkspacePermission.MANAGE_REFERENCE_DATA) as any, controller.delete.bind(controller) as any);

export default router;
