/**
 * Who may work the ticket desk.
 *
 * Ticketing is gated twice, and the two gates answer different questions:
 *
 *   1. Does this module EXIST for this organisation? A superadmin unlocks it per
 *      org with a `WorkspaceFeature` row. Without one the routes answer 404, not
 *      403 — an org that was never granted ticketing should not learn it is
 *      there.
 *   2. May this person use it? Normally the role matrix answers, exactly as it
 *      does everywhere else.
 *
 * The wrinkle this file exists for is the attendant. A ticket attendant is not a
 * role: they hold precisely MEMBER's permissions plus the ability to work the
 * desk. Minting an ATTENDANT role would have added a matrix entry identical to
 * MEMBER but for its name, and then a second one for maintenance, and a third
 * for the bar. So the job is carried by `WorkspaceMember.staffTag`, and TICKETING
 * is the one tag that grants anything.
 *
 * That grant is resolved HERE rather than inside WORKSPACE_PERMISSION_MATRIX,
 * which is keyed by role alone and must stay that way — a matrix that sometimes
 * depended on a second column would stop being checkable by reading it.
 *
 * The consequence to keep in mind: because the tag is permission-bearing,
 * assigning it is not a plain member-management action. members.service requires
 * MANAGE_TICKETING to set it, so HR — who may manage members — cannot hand
 * somebody the ability to post money.
 */
import { PrismaClient } from '@prisma/client';
import { StaffTag, WorkspaceRole, FeatureKey } from '../types';
import { WorkspacePermission, hasWorkspacePermission } from '../types/workspace-permissions';

type PrismaLike = Pick<PrismaClient, 'workspaceFeature'>;

/**
 * What the TICKETING staff tag grants on its own.
 *
 * Deliberately the desk and nothing else: see the day's sales, ring one up,
 * reverse one. No settings, no analytics, no memberships, no shift close — an
 * attendant must not be able to reconcile their own drawer, and must not be able
 * to change the prices they are selling at.
 *
 * VOID_TICKET_SALE here is the narrow form. Held without MANAGE_TICKETING it
 * reaches only the holder's OWN sale on the current open day; the service
 * applies that narrowing, because it depends on the row rather than the caller.
 */
const TICKETING_TAG_GRANTS: readonly WorkspacePermission[] = [
    WorkspacePermission.VIEW_TICKETING,
    WorkspacePermission.SELL_TICKETS,
    WorkspacePermission.VOID_TICKET_SALE,
];

/** Every permission in the ticketing group, in a stable order for the client. */
export const TICKETING_PERMISSIONS: readonly WorkspacePermission[] = [
    WorkspacePermission.VIEW_TICKETING,
    WorkspacePermission.SELL_TICKETS,
    WorkspacePermission.VOID_TICKET_SALE,
    WorkspacePermission.MANAGE_TICKETING,
    WorkspacePermission.RECONCILE_TICKET_SHIFT,
    WorkspacePermission.MANAGE_MEMBERSHIPS,
    WorkspacePermission.VIEW_TICKET_ANALYTICS,
];

/**
 * Everything the caller may do at the desk: what their role grants, plus what
 * their staff tag grants.
 *
 * Pure and synchronous, so route guards, services and the `/access` endpoint the
 * frontend gates on all compute the same answer from the same two inputs.
 */
export function ticketDeskCapabilities(
    role: WorkspaceRole | null | undefined,
    staffTag: StaffTag | null | undefined,
): Set<WorkspacePermission> {
    const capabilities = new Set<WorkspacePermission>();
    if (!role) return capabilities;

    for (const permission of TICKETING_PERMISSIONS) {
        if (hasWorkspacePermission(role, permission)) capabilities.add(permission);
    }

    if (staffTag === StaffTag.TICKETING) {
        for (const permission of TICKETING_TAG_GRANTS) capabilities.add(permission);
    }

    return capabilities;
}

/** Convenience wrapper for the common single-permission question. */
export function canAtTicketDesk(
    role: WorkspaceRole | null | undefined,
    staffTag: StaffTag | null | undefined,
    permission: WorkspacePermission,
): boolean {
    return ticketDeskCapabilities(role, staffTag).has(permission);
}

/** Whether a superadmin has unlocked ticketing for this organisation. */
export async function isTicketingEnabled(
    prisma: PrismaLike,
    workspaceId: string,
): Promise<boolean> {
    const row = await prisma.workspaceFeature.findUnique({
        where: { workspaceId_feature: { workspaceId, feature: FeatureKey.TICKETING } },
        select: { id: true },
    });
    return row !== null;
}
