import { Router } from 'express';
import { container } from 'tsyringe';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { idempotency } from '../../middlewares/idempotency';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import {
    chartQuerySchema,
    closePeriodSchema,
    createLedgerAccountSchema,
    journalQuerySchema,
    manualJournalSchema,
    mapCategorySchema,
    reopenPeriodSchema,
    reverseJournalSchema,
    updateLedgerAccountSchema,
} from './chart-of-accounts.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(ChartOfAccountsController);

router.use(authenticate as any);

// ─── Chart of accounts ────────────────────────────────────

router.get(
    '/',
    requireWorkspaceMember(WorkspacePermission.VIEW_CHART_OF_ACCOUNTS) as any,
    validate(chartQuerySchema, 'query'),
    controller.list.bind(controller) as any,
);

router.post(
    '/',
    requireWorkspaceMember(WorkspacePermission.MANAGE_CHART_OF_ACCOUNTS) as any,
    validate(createLedgerAccountSchema),
    controller.create.bind(controller) as any,
);

router.patch(
    '/:id',
    requireWorkspaceMember(WorkspacePermission.MANAGE_CHART_OF_ACCOUNTS) as any,
    validate(updateLedgerAccountSchema),
    controller.update.bind(controller) as any,
);

// Archive, never delete: an account with postings cannot be removed without
// destroying the journals that reference it.
router.post(
    '/:id/archive',
    requireWorkspaceMember(WorkspacePermission.MANAGE_CHART_OF_ACCOUNTS) as any,
    controller.archive.bind(controller) as any,
);

// Optional category → GL mapping. Unmapped categories use the seeded defaults,
// which is why the entry form never has to mention any of this.
router.put(
    '/category-mappings/:categoryId',
    requireWorkspaceMember(WorkspacePermission.MANAGE_CHART_OF_ACCOUNTS) as any,
    validate(mapCategorySchema),
    controller.mapCategory.bind(controller) as any,
);

// ─── Journals ─────────────────────────────────────────────

router.get(
    '/journals',
    requireWorkspaceMember(WorkspacePermission.VIEW_LEDGER) as any,
    validate(journalQuerySchema, 'query'),
    controller.listJournals.bind(controller) as any,
);

router.post(
    '/journals',
    requireWorkspaceMember(WorkspacePermission.POST_MANUAL_JOURNAL) as any,
    idempotency('POST /workspaces/:workspaceId/chart-of-accounts/journals') as any,
    validate(manualJournalSchema),
    controller.postManualJournal.bind(controller) as any,
);

router.post(
    '/journals/:journalId/reverse',
    requireWorkspaceMember(WorkspacePermission.POST_MANUAL_JOURNAL) as any,
    idempotency('POST /workspaces/:workspaceId/chart-of-accounts/journals/:journalId/reverse') as any,
    validate(reverseJournalSchema),
    controller.reverseJournal.bind(controller) as any,
);

// ─── Fiscal periods ───────────────────────────────────────

router.get(
    '/periods',
    requireWorkspaceMember(WorkspacePermission.VIEW_LEDGER) as any,
    controller.listPeriods.bind(controller) as any,
);

router.post(
    '/periods/close',
    requireWorkspaceMember(WorkspacePermission.CLOSE_PERIOD) as any,
    validate(closePeriodSchema),
    controller.closePeriod.bind(controller) as any,
);

router.post(
    '/periods/:periodId/reopen',
    requireWorkspaceMember(WorkspacePermission.CLOSE_PERIOD) as any,
    validate(reopenPeriodSchema),
    controller.reopenPeriod.bind(controller) as any,
);

export default router;
