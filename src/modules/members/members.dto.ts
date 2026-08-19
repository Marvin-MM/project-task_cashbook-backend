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
const assignableRole = z.enum([
    'ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT', 'SUB_ACCOUNTANT', 'PROJECT_MANAGER', 'HR', 'MEMBER', 'DEVELOPER',
]);

/**
 * What job this person does, separate from what they may do.
 *
 * Every value here is a label except TICKETING, which admits its holder to the
 * ticket desk. Setting that one requires MANAGE_TICKETING rather than plain
 * member management — see assertCanAssignStaffTag in members.service.
 */
const staffTag = z.enum([
    'BAR', 'RESTAURANT', 'KITCHEN', 'TICKETING', 'MAINTENANCE',
    'SOCIAL_MEDIA', 'SUPERVISOR', 'SECURITY', 'OTHER',
]);

export const inviteMemberSchema = z.object({
    email: z.string().email('Invalid email address'),
    role: assignableRole.default('MEMBER'),
    // Book-level grants for a SUB_ACCOUNTANT are made separately, through
    // POST /cashbooks/:cashbookId/members, once the invite is accepted. They
    // cannot be applied here because an invite creates no membership until the
    // recipient accepts it.
});

/**
 * Both halves are optional so a manager can retag somebody without restating
 * their role, but a body that changes neither is a mistake rather than a no-op.
 * `staffTag: null` clears the tag.
 */
export const updateMemberRoleSchema = z.object({
    role: assignableRole.optional(),
    staffTag: staffTag.nullable().optional(),
}).refine(
    (v) => v.role !== undefined || v.staffTag !== undefined,
    { message: 'Provide a role, a staff tag, or both' },
);

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
