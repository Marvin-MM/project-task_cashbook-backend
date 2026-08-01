import { Router } from 'express';
import { container } from 'tsyringe';
import { WorkspacesController } from './workspaces.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { createWorkspaceSchema, updateWorkspaceSchema } from './workspaces.dto';
import { WorkspacePermission } from '../../core/types/workspace-permissions';

const router = Router();
const workspacesController = container.resolve(WorkspacesController);

router.use(authenticate as any);

// Get all user workspaces
router.get('/', workspacesController.getAll.bind(workspacesController) as any);

// Create business workspace
router.post(
    '/',
    validate(createWorkspaceSchema),
    workspacesController.create.bind(workspacesController) as any
);

// Get single workspace
router.get(
    '/:workspaceId',
    requireWorkspaceMember(WorkspacePermission.VIEW_WORKSPACE) as any,
    workspacesController.getOne.bind(workspacesController) as any
);

// Update workspace
router.patch(
    '/:workspaceId',
    requireWorkspaceMember(WorkspacePermission.UPDATE_WORKSPACE) as any,
    validate(updateWorkspaceSchema),
    workspacesController.update.bind(workspacesController) as any
);

// Delete workspace
router.delete(
    '/:workspaceId',
    requireWorkspaceMember(WorkspacePermission.DELETE_WORKSPACE) as any,
    workspacesController.delete.bind(workspacesController) as any
);

export default router;
