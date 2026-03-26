import { Router } from 'express';
import { container } from 'tsyringe';
import { CatalogController } from './catalog.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { WorkspaceRole } from '../../core/types';
import {
    createTaxSchema,
    updateTaxSchema,
    createProductServiceSchema,
    updateProductServiceSchema,
    catalogQuerySchema,
} from './catalog.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(CatalogController);

router.use(authenticate as any);

// ─── Tax Routes ────────────────────────────────────────

router.get(
    '/taxes',
    requireWorkspaceMember() as any,
    controller.getTaxes.bind(controller) as any
);

router.get(
    '/taxes/:taxId',
    requireWorkspaceMember() as any,
    controller.getTax.bind(controller) as any
);

router.post(
    '/taxes',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(createTaxSchema),
    controller.createTax.bind(controller) as any
);

router.patch(
    '/taxes/:taxId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(updateTaxSchema),
    controller.updateTax.bind(controller) as any
);

router.delete(
    '/taxes/:taxId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    controller.deleteTax.bind(controller) as any
);

// ─── Product/Service Routes ────────────────────────────

router.get(
    '/products',
    requireWorkspaceMember() as any,
    validate(catalogQuerySchema, 'query'),
    controller.getProductsServices.bind(controller) as any
);

router.get(
    '/products/:itemId',
    requireWorkspaceMember() as any,
    controller.getProductService.bind(controller) as any
);

router.post(
    '/products',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(createProductServiceSchema),
    controller.createProductService.bind(controller) as any
);

router.patch(
    '/products/:itemId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(updateProductServiceSchema),
    controller.updateProductService.bind(controller) as any
);

router.delete(
    '/products/:itemId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    controller.deleteProductService.bind(controller) as any
);

export default router;
