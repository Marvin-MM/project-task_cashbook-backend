/**
 * Resolving a caller's workspace role inside a service.
 *
 * `requireWorkspaceMember` already puts the role on the request, and a service
 * that can take it as a parameter should. But three services grew their own
 * private `isWorkspaceManager` helper that hard-coded `owner || ADMIN`, and
 * those had drifted from WORKSPACE_PERMISSION_MATRIX — an ACCOUNTANT with
 * near-admin rights everywhere else was not a "manager" to any of them, and no
 * new role could ever become one without editing three files.
 *
 * This is the single implementation they now share. It is still a query, so
 * prefer passing the role down from the middleware where the call graph allows
 * it; use this where it does not.
 */
import { PrismaClient } from '@prisma/client';
import { WorkspaceRole } from '../types';
import { WorkspacePermission, hasWorkspacePermission } from '../types/workspace-permissions';

type PrismaLike = Pick<PrismaClient, 'workspace' | 'workspaceMember'>;

/**
 * The caller's effective role, or null if they are not in the workspace.
 *
 * The owner is OWNER whether or not a `WorkspaceMember` row exists — workspace
 * creation does not write one, so relying on the membership table alone would
 * lock owners out of their own organisation.
 */
export async function resolveWorkspaceRole(
    prisma: PrismaLike,
    workspaceId: string,
    userId: string,
): Promise<WorkspaceRole | null> {
    const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { ownerId: true, isActive: true },
    });
    if (!workspace || !workspace.isActive) return null;
    if (workspace.ownerId === userId) return WorkspaceRole.OWNER;

    const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { role: true },
    });
    return (membership?.role as WorkspaceRole) ?? null;
}

/** Whether the caller holds a permission in this workspace. */
export async function workspaceUserCan(
    prisma: PrismaLike,
    workspaceId: string,
    userId: string,
    permission: WorkspacePermission,
): Promise<boolean> {
    return hasWorkspacePermission(
        await resolveWorkspaceRole(prisma, workspaceId, userId),
        permission,
    );
}
