import { Router } from 'express';
import { container } from 'tsyringe';
import { ExpenseClaimsController } from './expense-claims.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import { upload } from '../../middlewares/upload';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import {
    createExpenseClaimSchema,
    reviewExpenseClaimSchema,
    expenseClaimQuerySchema,
} from './expense-claims.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(ExpenseClaimsController);

router.use(authenticate as any);

/*
 * USE_TASKS at the door: anyone doing the work may file a claim and read their
 * own. APPROVE_EXPENSE_CLAIM is checked in the service, alongside the separate
 * question of whether the approver may post to the BOOK they picked — which
 * arrives in the body, so a route-level cashbook guard cannot see it.
 */
router.get(
    '/',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(expenseClaimQuerySchema, 'query'),
    controller.list.bind(controller) as any,
);

router.post(
    '/',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(createExpenseClaimSchema),
    controller.create.bind(controller) as any,
);

router.get(
    '/:claimId',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('claimId'), 'params'),
    controller.get.bind(controller) as any,
);

router.post(
    '/:claimId/review',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('claimId'), 'params'),
    validate(reviewExpenseClaimSchema),
    controller.review.bind(controller) as any,
);

router.post(
    '/:claimId/withdraw',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('claimId'), 'params'),
    controller.withdraw.bind(controller) as any,
);

router.post(
    '/:claimId/receipts',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('claimId'), 'params'),
    upload.single('file') as any,
    controller.attachReceipt.bind(controller) as any,
);

router.get(
    '/:claimId/receipts',
    requireWorkspaceMember(WorkspacePermission.USE_TASKS) as any,
    validate(uuidParams('claimId'), 'params'),
    controller.listReceipts.bind(controller) as any,
);

export default router;
