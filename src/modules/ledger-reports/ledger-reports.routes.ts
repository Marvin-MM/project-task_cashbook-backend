import { Router } from 'express';
import { container } from 'tsyringe';
import { LedgerReportsController } from './ledger-reports.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import {
    agingQuerySchema,
    balanceSheetQuerySchema,
    cashFlowQuerySchema,
    generalLedgerQuerySchema,
    incomeStatementQuerySchema,
    trialBalanceQuerySchema,
} from './ledger-reports.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(LedgerReportsController);

router.use(authenticate as any);

// Financial statements are accountant-and-above only; a plain MEMBER never
// reaches this module.
const canViewReports = () =>
    requireWorkspaceMember(WorkspacePermission.VIEW_FINANCIAL_REPORTS) as any;

router.get(
    '/balance-sheet',
    canViewReports(),
    validate(balanceSheetQuerySchema, 'query'),
    controller.balanceSheet.bind(controller) as any,
);

router.get(
    '/income-statement',
    canViewReports(),
    validate(incomeStatementQuerySchema, 'query'),
    controller.incomeStatement.bind(controller) as any,
);

router.get(
    '/trial-balance',
    canViewReports(),
    validate(trialBalanceQuerySchema, 'query'),
    controller.trialBalance.bind(controller) as any,
);

router.get(
    '/general-ledger',
    canViewReports(),
    validate(generalLedgerQuerySchema, 'query'),
    controller.generalLedger.bind(controller) as any,
);

router.get(
    '/cash-flow',
    canViewReports(),
    validate(cashFlowQuerySchema, 'query'),
    controller.cashFlow.bind(controller) as any,
);

router.get(
    '/aging',
    canViewReports(),
    validate(agingQuerySchema, 'query'),
    controller.aging.bind(controller) as any,
);

// "Do the books balance?" — answered with specific accounts and differences.
router.get(
    '/integrity',
    requireWorkspaceMember(WorkspacePermission.VIEW_LEDGER) as any,
    controller.integrityCheck.bind(controller) as any,
);

/*
 * Recalculating writes, so it needs a stronger grant than reading the check.
 * MANAGE_CHART_OF_ACCOUNTS is the closest existing "you are responsible for the
 * shape of the books" permission — owner, admin and accountant.
 */
router.post(
    '/integrity/repair',
    requireWorkspaceMember(WorkspacePermission.MANAGE_CHART_OF_ACCOUNTS) as any,
    controller.repairBalances.bind(controller) as any,
);

export default router;
