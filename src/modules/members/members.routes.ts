import { Router } from 'express';
import { container } from 'tsyringe';
import { MembersController } from './members.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { inviteMemberSchema, updateMemberRoleSchema, importMembersSchema } from './members.dto';
import { WorkspacePermission } from '../../core/types/workspace-permissions';

/**
 * Two different grants reach member management, and neither is a superset of
 * the other: MANAGE_MEMBERS (owner, admin, HR) and the narrower
 * MANAGE_SUB_ACCOUNTANTS (accountant). The door checks that you hold one;
 * members.service then caps WHICH roles you may actually hand out, via
 * assignableRoles() — accountant to sub-accountant, HR to member.
 */
const MANAGE_PEOPLE = {
    anyOf: [
        WorkspacePermission.MANAGE_MEMBERS,
        WorkspacePermission.MANAGE_SUB_ACCOUNTANTS,
    ],
};

const router = Router({ mergeParams: true });
const membersController = container.resolve(MembersController);

router.use(authenticate as any);

// Get workspace members
router.get(
    '/',
    requireWorkspaceMember(WorkspacePermission.VIEW_MEMBERS) as any,
    membersController.getMembers.bind(membersController) as any
);

// Get pending invites for the workspace
router.get(
    '/invites/pending',
    requireWorkspaceMember(MANAGE_PEOPLE) as any,
    membersController.getPendingInvites.bind(membersController) as any
);

// Get importable members from other workspaces
router.get(
    '/importable',
    requireWorkspaceMember(WorkspacePermission.IMPORT_MEMBERS) as any,
    membersController.getImportableMembers.bind(membersController) as any
);

// Import members from another workspace
router.post(
    '/import',
    requireWorkspaceMember(WorkspacePermission.IMPORT_MEMBERS) as any,
    validate(importMembersSchema),
    membersController.importMembers.bind(membersController) as any
);

// Invite member
router.post(
    '/',
    requireWorkspaceMember(MANAGE_PEOPLE) as any,
    validate(inviteMemberSchema),
    membersController.inviteMember.bind(membersController) as any
);

// Update member role
router.patch(
    '/:userId',
    requireWorkspaceMember(MANAGE_PEOPLE) as any,
    validate(updateMemberRoleSchema),
    membersController.updateRole.bind(membersController) as any
);

// Remove member
router.delete(
    '/:userId',
    requireWorkspaceMember(MANAGE_PEOPLE) as any,
    membersController.removeMember.bind(membersController) as any
);

export default router;
