import { Router } from 'express';
import { container } from 'tsyringe';
import { AccountsController } from './accounts.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { idempotency } from '../../middlewares/idempotency';
import {
    createAccountSchema,
    updateAccountSchema,
    archiveAccountSchema,
    createAccountTransferSchema,
} from './accounts.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(AccountsController);

// All account routes require authentication and workspace scope
router.use(authenticate as any);

// List accounts
router.get(
    '/',
    requireWorkspaceMember(WorkspacePermission.VIEW_WALLETS) as any,
    controller.getAll.bind(controller) as any
);

// Get Net Worth
router.get(
    '/net-worth',
    requireWorkspaceMember(WorkspacePermission.VIEW_WALLET_BALANCES) as any,
    controller.getNetWorth.bind(controller) as any
);

// Wallet transfer (must be before /:id routes)
router.post(
    '/transfers',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    idempotency('POST /workspaces/:workspaceId/accounts/transfers') as any,
    validate(createAccountTransferSchema),
    controller.transfer.bind(controller) as any
);

// Get single account
router.get(
    '/:id',
    requireWorkspaceMember(WorkspacePermission.VIEW_WALLETS) as any,
    controller.getById.bind(controller) as any
);

// Recalculate wallet balance from ledger + transfers
router.post(
    '/:id/recalculate',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    controller.recalculateBalance.bind(controller) as any
);

// Create account
router.post(
    '/',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    idempotency('POST /workspaces/:workspaceId/accounts') as any,
    validate(createAccountSchema),
    controller.create.bind(controller) as any
);

// Update account
router.patch(
    '/:id',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    validate(updateAccountSchema),
    controller.update.bind(controller) as any
);

// Archive/Unarchive account
router.post(
    '/:id/archive',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    validate(archiveAccountSchema),
    controller.archive.bind(controller) as any
);

// Delete account
router.delete(
    '/:id',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    controller.delete.bind(controller) as any
);

export default router;
