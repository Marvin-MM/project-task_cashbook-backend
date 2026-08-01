import { Router } from 'express';
import { container } from 'tsyringe';
import { AccountTransactionsController } from './account-transactions.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { idempotency } from '../../middlewares/idempotency';
import { createAccountTransactionSchema, updateAccountTransactionSchema } from './account-transactions.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(AccountTransactionsController);

router.use(authenticate as any);

router.get(
    '/',
    requireWorkspaceMember(WorkspacePermission.VIEW_WALLET_BALANCES) as any, // MEMBER+ can read
    controller.getAllTransactions.bind(controller) as any
);

router.post(
    '/',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    idempotency('POST /workspaces/:workspaceId/accounts/:accountId/transactions') as any,
    validate(createAccountTransactionSchema),
    controller.create.bind(controller) as any
);

router.patch(
    '/:id',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    idempotency('PATCH /workspaces/:workspaceId/accounts/:accountId/transactions/:id') as any,
    validate(updateAccountTransactionSchema),
    controller.update.bind(controller) as any
);

router.delete(
    '/:id',
    requireWorkspaceMember(WorkspacePermission.MANAGE_WALLETS) as any,
    idempotency('DELETE /workspaces/:workspaceId/accounts/:accountId/transactions/:id') as any,
    controller.delete.bind(controller) as any
);

export default router;
