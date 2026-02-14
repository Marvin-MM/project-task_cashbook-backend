import { Router } from 'express';
import { AuditController } from './audit.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember, requireCashbookMember } from '../../middlewares/authorize';
import { CashbookPermission } from '../../core/types/permissions';
import { WorkspaceRole } from '../../core/types';

const router = Router({ mergeParams: true });
const auditController = new AuditController();

router.use(authenticate as any);

// Workspace audit logs (owner/admin only)
router.get(
    '/workspace/:workspaceId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    auditController.getWorkspaceAuditLogs.bind(auditController) as any
);

// Financial audit logs for a cashbook
router.get(
    '/financial/:cashbookId',
    requireCashbookMember(CashbookPermission.VIEW_AUDIT_LOG) as any,
    auditController.getFinancialAuditLogs.bind(auditController) as any
);

export default router;
