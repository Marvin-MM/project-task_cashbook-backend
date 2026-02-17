import { Router } from 'express';
import { container } from 'tsyringe';
import { FilesController } from './files.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireCashbookMember } from '../../middlewares/authorize';
import { CashbookPermission } from '../../core/types/permissions';
import { upload, validateFileContent } from '../../middlewares/upload';
import { uploadRateLimiter } from '../../middlewares/rateLimiter';

const router = Router({ mergeParams: true });
const filesController = container.resolve(FilesController);

router.use(authenticate as any);

// Upload attachment to an entry
router.post(
    '/entry/:entryId/cashbook/:cashbookId',
    uploadRateLimiter,
    requireCashbookMember(CashbookPermission.CREATE_ENTRY) as any,
    upload.single('file'),
    validateFileContent,
    filesController.upload.bind(filesController) as any
);

// Get all attachments for an entry
router.get(
    '/entry/:entryId/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.VIEW_ENTRIES) as any,
    filesController.getAll.bind(filesController) as any
);

// View/stream file (proxy from MinIO)
router.get(
    '/:attachmentId/view/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.VIEW_ENTRIES) as any,
    filesController.viewFile.bind(filesController) as any
);

// Delete attachment
router.delete(
    '/:attachmentId/cashbook/:cashbookId',
    requireCashbookMember(CashbookPermission.DELETE_ENTRY) as any,
    filesController.delete.bind(filesController) as any
);

export default router;
