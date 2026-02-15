import { injectable, inject } from 'tsyringe';
import { PrismaClient, WorkspaceRole } from '@prisma/client';
import crypto from 'crypto';
import { logger } from '../../utils/logger';

export interface PendingInviteData {
    email: string;
    workspaceId: string;
    role?: WorkspaceRole;
    invitedById: string;
}

/**
 * Manages invite flows for users who haven't registered yet.
 *
 * When a member is invited to a workspace but doesn't have an account,
 * we store a PendingInvite with a unique token and expiry. On
 * registration, the system resolves all pending invites for that email.
 */
@injectable()
export class InvitesService {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    /**
     * Create a pending invite for an unregistered email.
     */
    async createPendingInvite(data: PendingInviteData) {
        // Avoid duplicate invites (unique constraint on [workspaceId, email])
        const existing = await this.prisma.pendingInvite.findUnique({
            where: {
                workspaceId_email: {
                    workspaceId: data.workspaceId,
                    email: data.email,
                },
            },
        });

        if (existing) {
            logger.info('Pending invite already exists', { email: data.email, workspaceId: data.workspaceId });
            return existing;
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        return this.prisma.pendingInvite.create({
            data: {
                email: data.email,
                workspaceId: data.workspaceId,
                role: data.role ?? WorkspaceRole.MEMBER,
                invitedById: data.invitedById,
                token,
                expiresAt,
            },
        });
    }

    /**
     * After registration, resolve all pending invites for this email
     * by adding the user to the appropriate workspaces.
     */
    async resolveInvites(userId: string, email: string): Promise<number> {
        const invites = await this.prisma.pendingInvite.findMany({
            where: { email },
        });

        if (invites.length === 0) return 0;

        let resolved = 0;

        for (const invite of invites) {
            // Skip expired invites
            if (invite.expiresAt < new Date()) {
                await this.prisma.pendingInvite.delete({ where: { id: invite.id } });
                continue;
            }

            try {
                await this.prisma.$transaction(async (tx) => {
                    // Add to workspace if not already a member
                    const existingWsMember = await tx.workspaceMember.findUnique({
                        where: {
                            workspaceId_userId: {
                                workspaceId: invite.workspaceId,
                                userId,
                            },
                        },
                    });

                    if (!existingWsMember) {
                        await tx.workspaceMember.create({
                            data: {
                                workspaceId: invite.workspaceId,
                                userId,
                                role: invite.role,
                            },
                        });
                    }

                    // Remove the invite after resolving
                    await tx.pendingInvite.delete({
                        where: { id: invite.id },
                    });
                });

                resolved++;
            } catch (error) {
                logger.error('Failed to resolve invite', { inviteId: invite.id, error });
            }
        }

        logger.info(`Resolved ${resolved}/${invites.length} pending invites for ${email}`);
        return resolved;
    }

    /**
     * Get all pending invites for an email address.
     */
    async getPendingInvites(email: string) {
        return this.prisma.pendingInvite.findMany({
            where: {
                email,
                expiresAt: { gte: new Date() },
            },
            include: {
                workspace: { select: { id: true, name: true } },
                invitedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }
}
