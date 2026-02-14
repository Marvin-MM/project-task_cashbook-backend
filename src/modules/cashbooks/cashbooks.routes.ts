import { Router } from 'express';
import { CashbooksController } from './cashbooks.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember, requireCashbookMember } from '../../middlewares/authorize';
import { CashbookPermission } from '../../core/types/permissions';
import { WorkspaceRole } from '../../core/types';
import {
    createCashbookSchema,
    updateCashbookSchema,
    addCashbookMemberSchema,
    updateCashbookMemberRoleSchema,
} from './cashbooks.dto';

const router = Router({ mergeParams: true });
const cashbooksController = new CashbooksController();

router.use(authenticate as any);

// ─── Workspace-scoped routes ───────────────────────────
// List cashbooks in a workspace
router.get(
    '/workspace/:workspaceId',
    requireWorkspaceMember() as any,
    cashbooksController.getAll.bind(cashbooksController) as any
);

// Create cashbook in a workspace
router.post(
    '/workspace/:workspaceId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER]) as any,
    validate(createCashbookSchema),
    cashbooksController.create.bind(cashbooksController) as any
);

// ─── Cashbook-scoped routes ────────────────────────────
// Get single cashbook
router.get(
    '/:cashbookId',
    requireCashbookMember(CashbookPermission.VIEW_CASHBOOK) as any,
    cashbooksController.getOne.bind(cashbooksController) as any
);

// Update cashbook
router.patch(
    '/:cashbookId',
    requireCashbookMember(CashbookPermission.UPDATE_CASHBOOK) as any,
    validate(updateCashbookSchema),
    cashbooksController.update.bind(cashbooksController) as any
);

// Delete cashbook
router.delete(
    '/:cashbookId',
    requireCashbookMember(CashbookPermission.DELETE_CASHBOOK) as any,
    cashbooksController.delete.bind(cashbooksController) as any
);

// Financial summary
router.get(
    '/:cashbookId/summary',
    requireCashbookMember(CashbookPermission.VIEW_CASHBOOK) as any,
    cashbooksController.getSummary.bind(cashbooksController) as any
);

// ─── Cashbook members ──────────────────────────────────
router.get(
    '/:cashbookId/members',
    requireCashbookMember(CashbookPermission.VIEW_MEMBERS) as any,
    cashbooksController.getMembers.bind(cashbooksController) as any
);

router.post(
    '/:cashbookId/members',
    requireCashbookMember(CashbookPermission.ADD_MEMBER) as any,
    validate(addCashbookMemberSchema),
    cashbooksController.addMember.bind(cashbooksController) as any
);

router.patch(
    '/:cashbookId/members/:userId',
    requireCashbookMember(CashbookPermission.CHANGE_MEMBER_ROLE) as any,
    validate(updateCashbookMemberRoleSchema),
    cashbooksController.updateMemberRole.bind(cashbooksController) as any
);

router.delete(
    '/:cashbookId/members/:userId',
    requireCashbookMember(CashbookPermission.REMOVE_MEMBER) as any,
    cashbooksController.removeMember.bind(cashbooksController) as any
);

export default router;
