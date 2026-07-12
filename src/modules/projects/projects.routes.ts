import { Router } from 'express';
import { container } from 'tsyringe';
import { ProjectsController } from './projects.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import { WorkspaceRole } from '../../core/types';
import {
    createProjectSchema,
    updateProjectSchema,
    addProjectMemberSchema,
    updateProjectMemberRoleSchema,
    projectQuerySchema,
} from './projects.dto';

const router = Router({ mergeParams: true });
const controller = container.resolve(ProjectsController);

router.use(authenticate as any);

// ─── Static paths first ───────────────────────────────
router.get(
    '/',
    requireWorkspaceMember() as any,
    validate(projectQuerySchema, 'query'),
    controller.getProjects.bind(controller) as any,
);

router.post(
    '/',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(createProjectSchema),
    controller.createProject.bind(controller) as any,
);

// ─── Dynamic :projectId routes ────────────────────────
router.get(
    '/:projectId',
    requireWorkspaceMember() as any,
    validate(uuidParams('projectId'), 'params'),
    controller.getProject.bind(controller) as any,
);

router.patch(
    '/:projectId',
    requireWorkspaceMember() as any,
    validate(uuidParams('projectId'), 'params'),
    validate(updateProjectSchema),
    controller.updateProject.bind(controller) as any,
);

router.post(
    '/:projectId/archive',
    requireWorkspaceMember() as any,
    validate(uuidParams('projectId'), 'params'),
    controller.archiveProject.bind(controller) as any,
);

router.delete(
    '/:projectId',
    requireWorkspaceMember([WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) as any,
    validate(uuidParams('projectId'), 'params'),
    controller.deleteProject.bind(controller) as any,
);

// ─── Members ──────────────────────────────────────────
router.get(
    '/:projectId/members',
    requireWorkspaceMember() as any,
    validate(uuidParams('projectId'), 'params'),
    controller.getMembers.bind(controller) as any,
);

router.post(
    '/:projectId/members',
    requireWorkspaceMember() as any,
    validate(uuidParams('projectId'), 'params'),
    validate(addProjectMemberSchema),
    controller.addMember.bind(controller) as any,
);

router.patch(
    '/:projectId/members/:memberId',
    requireWorkspaceMember() as any,
    validate(uuidParams('projectId', 'memberId'), 'params'),
    validate(updateProjectMemberRoleSchema),
    controller.updateMemberRole.bind(controller) as any,
);

router.delete(
    '/:projectId/members/:memberId',
    requireWorkspaceMember() as any,
    validate(uuidParams('projectId', 'memberId'), 'params'),
    controller.removeMember.bind(controller) as any,
);

export default router;
