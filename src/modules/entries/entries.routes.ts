import { Router } from 'express';
import { container } from 'tsyringe';
import { EntriesController } from './entries.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireCashbookMember } from '../../middlewares/authorize';
import { idempotency } from '../../middlewares/idempotency';
import { CashbookPermission } from '../../core/types/permissions';
import {
    createEntrySchema,
    updateEntrySchema,
    deleteEntrySchema,
    reviewDeleteRequestSchema,
    entryQuerySchema,
} from './entries.dto';

const router = Router({ mergeParams: true });
const entriesController = container.resolve(EntriesController);

router.use(authenticate as any);

/*
 * Literal paths first. `/:entryId/cashbook/:cashbookId` below has the same
 * shape as `/delete-requests/cashbook/:cashbookId`, and Express matches in
 * declaration order — with the dynamic one first, listing delete requests
 * called getOne with entryId = "delete-requests" and went to Prisma with it.
 */
router.get(
    '/delete-requests/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.APPROVE_DELETE) as any,
    entriesController.getDeleteRequests.bind(entriesController) as any
);

// ─── Entry CRUD ────────────────────────────────────────
router.get(
    '/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.VIEW_ENTRIES) as any,
    validate(entryQuerySchema, 'query'),
    entriesController.getAll.bind(entriesController) as any
);

router.get(
    '/:entryId/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.VIEW_ENTRIES) as any,
    entriesController.getOne.bind(entriesController) as any
);

router.post(
    '/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.CREATE_ENTRY) as any,
    idempotency('POST /entries/cashbook/:cashbookId') as any,
    validate(createEntrySchema),
    entriesController.create.bind(entriesController) as any
);

router.patch(
    '/:entryId/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.UPDATE_ENTRY) as any,
    idempotency('PATCH /entries/:entryId/cashbook/:cashbookId') as any,
    validate(updateEntrySchema),
    entriesController.update.bind(entriesController) as any
);

router.delete(
    '/:entryId/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.DELETE_ENTRY) as any,
    idempotency('DELETE /entries/:entryId/cashbook/:cashbookId') as any,
    validate(deleteEntrySchema),
    entriesController.delete.bind(entriesController) as any
);

// ─── Delete Requests ───────────────────────────────────
router.post(
    '/delete-requests/:requestId/review/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.APPROVE_DELETE) as any,
    validate(reviewDeleteRequestSchema),
    entriesController.reviewDeleteRequest.bind(entriesController) as any
);

// ─── Audit Trail ───────────────────────────────────────
router.get(
    '/:entryId/audit/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.VIEW_AUDIT_LOG) as any,
    entriesController.getAuditTrail.bind(entriesController) as any
);

// ─── Receipts ──────────────────────────────────────────
router.post(
    '/:entryId/receipt/send/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.VIEW_ENTRIES) as any,
    entriesController.sendReceipt.bind(entriesController) as any
);

export default router;
