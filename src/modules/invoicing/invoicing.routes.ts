import { Router } from 'express';
import { container } from 'tsyringe';
import { InvoicingController } from './invoicing.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { WorkspaceRole } from '../../core/types';
import {
    createInvoiceSchema,
    updateInvoiceSchema,
    invoiceQuerySchema,
    updateInvoiceSettingsSchema,
} from './invoicing.dto';
import { z } from 'zod';
import { uploadImageMemory } from '../../middlewares/uploadImage';

const router = Router({ mergeParams: true });
const controller = container.resolve(InvoicingController);

router.use(authenticate as any);

// ─── Reporting (BEFORE /:invoiceId to avoid route conflict) ─

router.get(
    '/reports/overdue',
    requireWorkspaceMember() as any,
    controller.getOverdueInvoices.bind(controller) as any
);

router.get(
    '/reports/summary',
    requireWorkspaceMember() as any,
    controller.getInvoiceSummary.bind(controller) as any
);

router.get(
    '/reports/customer-outstanding',
    requireWorkspaceMember() as any,
    controller.getCustomerOutstanding.bind(controller) as any
);

// ─── Invoice Settings (BEFORE /:invoiceId) ─────────────

router.get(
    '/settings/current',
    requireWorkspaceMember() as any,
    controller.getSettings.bind(controller) as any
);

router.patch(
    '/settings/current',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(updateInvoiceSettingsSchema),
    controller.updateSettings.bind(controller) as any
);

router.post(
    '/settings/current/logo',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    uploadImageMemory.single('file') as any,
    controller.uploadLogo.bind(controller) as any
);

// ─── Invoice CRUD ──────────────────────────────────────

router.get(
    '/',
    requireWorkspaceMember() as any,
    validate(invoiceQuerySchema, 'query'),
    controller.listInvoices.bind(controller) as any
);

router.post(
    '/',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(createInvoiceSchema),
    controller.createInvoice.bind(controller) as any
);

router.get(
    '/:invoiceId',
    requireWorkspaceMember() as any,
    controller.getInvoice.bind(controller) as any
);

router.patch(
    '/:invoiceId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(updateInvoiceSchema),
    controller.updateInvoice.bind(controller) as any
);

router.delete(
    '/:invoiceId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    controller.deleteInvoice.bind(controller) as any
);

// ─── Invoice Actions ───────────────────────────────────

router.post(
    '/:invoiceId/send',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    controller.sendInvoice.bind(controller) as any
);

router.post(
    '/:invoiceId/void',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    controller.voidInvoice.bind(controller) as any
);

export default router;
