import { Router } from 'express';
import { container } from 'tsyringe';
import { ProjectsController } from './projects.controller';
import { authenticate } from '../../middlewares/authenticate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { uuidParams } from '../../middlewares/uuidParam';
import { WorkspacePermission } from '../../core/types/workspace-permissions';
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

/*
 * Route gating, in two tiers.
 *
 * USE_PROJECTS is held by every role, so a read route reaching this point still
 * has to be scoped: ProjectsService filters the list to projects the caller is
 * a member of unless they hold MANAGE_PROJECTS. The middleware answers "may you
 * use this module at all"; the service answers "which rows".
 *
 * MANAGE_PROJECTS replaces the hard-coded [OWNER, ADMIN] arrays that used to be
 * here — those were why a new role could not be introduced without editing
 * every route file.
 */

// ─── Static paths first ───────────────────────────────
router.get(
    '/',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(projectQuerySchema, 'query'),
    controller.getProjects.bind(controller) as any,
);

router.post(
    '/',
    requireWorkspaceMember(WorkspacePermission.MANAGE_PROJECTS) as any,
    validate(createProjectSchema),
    controller.createProject.bind(controller) as any,
);

// ─── Dynamic :projectId routes ────────────────────────
router.get(
    '/:projectId',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(uuidParams('projectId'), 'params'),
    controller.getProject.bind(controller) as any,
);

router.patch(
    '/:projectId',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(uuidParams('projectId'), 'params'),
    validate(updateProjectSchema),
    controller.updateProject.bind(controller) as any,
);

router.post(
    '/:projectId/archive',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(uuidParams('projectId'), 'params'),
    controller.archiveProject.bind(controller) as any,
);

router.post(
    '/:projectId/unarchive',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(uuidParams('projectId'), 'params'),
    controller.unarchiveProject.bind(controller) as any,
);

router.delete(
    '/:projectId',
    requireWorkspaceMember(WorkspacePermission.MANAGE_PROJECTS) as any,
    validate(uuidParams('projectId'), 'params'),
    controller.deleteProject.bind(controller) as any,
);

// ─── Members ──────────────────────────────────────────
router.get(
    '/:projectId/members',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(uuidParams('projectId'), 'params'),
    controller.getMembers.bind(controller) as any,
);

router.post(
    '/:projectId/members',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(uuidParams('projectId'), 'params'),
    validate(addProjectMemberSchema),
    controller.addMember.bind(controller) as any,
);

router.patch(
    '/:projectId/members/:memberId',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(uuidParams('projectId', 'memberId'), 'params'),
    validate(updateProjectMemberRoleSchema),
    controller.updateMemberRole.bind(controller) as any,
);

router.delete(
    '/:projectId/members/:memberId',
    requireWorkspaceMember(WorkspacePermission.USE_PROJECTS) as any,
    validate(uuidParams('projectId', 'memberId'), 'params'),
    controller.removeMember.bind(controller) as any,
);

export default router;
