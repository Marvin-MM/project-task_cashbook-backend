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
/*
 * The payment method that goes with a wallet, get-or-create.
 *
 * Gated on VIEW_WORKSPACE rather than MANAGE_REFERENCE_DATA, deliberately: the
 * name is read from an AccountType that already exists, never supplied by the
 * caller, so this cannot mint arbitrary reference data. Requiring the manage
 * grant instead would mean an ordinary data operator — who may record entries
 * but not manage reference data — silently gets an empty field.
 *
 * Declared before `/:workspaceId/:paymentModeId` so the literal `for-account`
 * segment is not swallowed by the dynamic one.
 */
router.post('/:workspaceId/for-account/:accountId',
    requireWorkspaceMember(WorkspacePermission.VIEW_WORKSPACE) as any,
    controller.ensureForAccount.bind(controller) as any);

router.patch('/:workspaceId/:paymentModeId', requireWorkspaceMember(WorkspacePermission.MANAGE_REFERENCE_DATA) as any, validate(updatePaymentModeSchema), controller.update.bind(controller) as any);
router.delete('/:workspaceId/:paymentModeId', requireWorkspaceMember(WorkspacePermission.MANAGE_REFERENCE_DATA) as any, controller.delete.bind(controller) as any);

export default router;
