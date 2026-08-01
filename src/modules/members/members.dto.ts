import { z } from 'zod';

/**
 * OWNER is deliberately absent: ownership comes from creating the workspace and
 * is not grantable through this API. Whether the caller may actually assign a
 * given role is decided by assignableRoles() in members.service — an ACCOUNTANT
 * can only create SUB_ACCOUNTANTs, and HR can only create MEMBERs.
 *
 * This enum is a syntactic gate, not the authorization one. It has to list
 * every assignable role, or a role becomes unassignable by anybody; the matrix
 * decides who may actually use each.
 */
const assignableRole = z.enum(['ADMIN', 'ACCOUNTANT', 'SUB_ACCOUNTANT', 'PROJECT_MANAGER', 'HR', 'MEMBER']);

export const inviteMemberSchema = z.object({
    email: z.string().email('Invalid email address'),
    role: assignableRole.default('MEMBER'),
    // Book-level grants for a SUB_ACCOUNTANT are made separately, through
    // POST /cashbooks/:cashbookId/members, once the invite is accepted. They
    // cannot be applied here because an invite creates no membership until the
    // recipient accepts it.
});

export const updateMemberRoleSchema = z.object({
    role: assignableRole,
});

export const importMembersSchema = z.object({
    sourceWorkspaceId: z.string().uuid('Invalid source workspace ID'),
    members: z.array(
        z.object({
            userId: z.string().uuid('Invalid user ID'),
            role: assignableRole.default('MEMBER'),
        })
    ).min(1, 'At least one member must be selected for import'),
});

export type InviteMemberDto = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberRoleDto = z.infer<typeof updateMemberRoleSchema>;
export type ImportMembersDto = z.infer<typeof importMembersSchema>;
