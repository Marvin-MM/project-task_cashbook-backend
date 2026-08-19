import { Router } from 'express';
import { container } from 'tsyringe';
import { ApiKeysController } from './api-keys.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember, requireBusinessWorkspace } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
import { createApiKeySchema, updateApiKeySchema } from './api-keys.dto';

const router = Router({ mergeParams: true });
const ctrl = container.resolve(ApiKeysController);

router.use(authenticate as any);

// All routes require MANAGE_API_KEYS permission.
// Owner, Admin, General Manager, and Developer roles all hold this permission.
router.use(requireWorkspaceMember(WorkspacePermission.MANAGE_API_KEYS) as any);
router.use(requireBusinessWorkspace() as any);

// List API keys for a workspace
router.get('/', ctrl.list.bind(ctrl) as any);

// Create a new API key
router.post('/', validate(createApiKeySchema), ctrl.create.bind(ctrl) as any);

// Update an API key's metadata (name, allowed books, IPs, expiry)
router.patch('/:keyId', validate(updateApiKeySchema), ctrl.update.bind(ctrl) as any);

// Rotate a key (invalidates the old one, issues a new raw key)
router.post('/:keyId/rotate', ctrl.rotate.bind(ctrl) as any);

// Revoke (permanently disable) a key
router.delete('/:keyId', ctrl.revoke.bind(ctrl) as any);

export default router;
