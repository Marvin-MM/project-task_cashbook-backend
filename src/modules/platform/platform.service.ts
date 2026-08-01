/**
 * Platform (superadmin) operations.
 *
 * Replaces the old /admin controller, which talked to Prisma directly, had no
 * service or repository, and wrote no audit rows for any of its four actions.
 */
import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { superAdminEmails } from '../../config';
import { AppError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { logger } from '../../utils/logger';

export interface SuperAdminReconciliation {
    promoted: string[];
    demoted: string[];
    configured: string[];
}

@injectable()
export class PlatformService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    /**
     * Make the database agree with SUPER_ADMIN_EMAILS.
     *
     * Promotes every listed user and demotes every unlisted one, so the env var
     * is genuinely the source of truth. Previously the flag was set only at
     * signup, which meant adding an address did nothing for an existing account
     * and removing one did nothing at all.
     *
     * Runs on boot and after each successful login.
     */
    async reconcileSuperAdmins(): Promise<SuperAdminReconciliation> {
        const configured = superAdminEmails();

        const [shouldBe, currentlyAre] = await Promise.all([
            configured.length > 0
                ? this.prisma.user.findMany({
                    where: { email: { in: configured, mode: 'insensitive' } },
                    select: { id: true, email: true, isSuperAdmin: true },
                })
                : Promise.resolve([]),
            this.prisma.user.findMany({
                where: { isSuperAdmin: true },
                select: { id: true, email: true },
            }),
        ]);

        const toPromote = shouldBe.filter((u) => !u.isSuperAdmin);
        const shouldBeIds = new Set(shouldBe.map((u) => u.id));
        const toDemote = currentlyAre.filter((u) => !shouldBeIds.has(u.id));

        if (toPromote.length > 0) {
            await this.prisma.user.updateMany({
                where: { id: { in: toPromote.map((u) => u.id) } },
                data: { isSuperAdmin: true },
            });
        }

        if (toDemote.length > 0) {
            await this.prisma.user.updateMany({
                where: { id: { in: toDemote.map((u) => u.id) } },
                data: { isSuperAdmin: false },
            });
        }

        const result: SuperAdminReconciliation = {
            promoted: toPromote.map((u) => u.email),
            demoted: toDemote.map((u) => u.email),
            configured,
        };

        if (result.promoted.length > 0 || result.demoted.length > 0) {
            logger.info('Reconciled platform superadmins', result);
        }

        return result;
    }

    /**
     * Configured addresses alongside whether an account exists for each.
     * A configured address with no account is a common misconfiguration worth
     * surfacing rather than silently ignoring.
     */
    async listSuperAdmins() {
        const configured = superAdminEmails();
        const users = await this.prisma.user.findMany({
            where: {
                OR: [
                    { isSuperAdmin: true },
                    ...(configured.length > 0
                        ? [{ email: { in: configured, mode: 'insensitive' as const } }]
                        : []),
                ],
            },
            select: {
                id: true, email: true, firstName: true, lastName: true,
                isSuperAdmin: true, isActive: true, lastLoginAt: true,
            },
            orderBy: { email: 'asc' },
        });

        const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

        return {
            /** Managed by env var; not editable through the API. */
            source: 'SUPER_ADMIN_EMAILS',
            configured: configured.map((email) => ({
                email,
                user: byEmail.get(email) ?? null,
                status: byEmail.get(email) ? 'ACTIVE' : 'NO_ACCOUNT',
            })),
            /** Flagged in the database but absent from the env var — a stale grant. */
            unmanaged: users.filter(
                (u) => u.isSuperAdmin && !configured.includes(u.email.toLowerCase()),
            ),
        };
    }

    async getStats() {
        const [users, activeUsers, workspaces, cashbooks, entries, journals, reversedEntries] =
            await Promise.all([
                this.prisma.user.count(),
                this.prisma.user.count({ where: { isActive: true } }),
                this.prisma.workspace.count({ where: { isActive: true } }),
                this.prisma.cashbook.count({ where: { isActive: true } }),
                this.prisma.entry.count({ where: { status: 'POSTED' } }),
                this.prisma.journalEntry.count(),
                this.prisma.entry.count({ where: { status: 'REVERSED' } }),
            ]);

        return {
            users: { total: users, active: activeUsers },
            workspaces,
            cashbooks,
            entries: { posted: entries, reversed: reversedEntries },
            ledger: { journalEntries: journals },
        };
    }

    async listUsers(params: { page: number; limit: number; search?: string }) {
        const skip = (params.page - 1) * params.limit;
        const where = params.search
            ? {
                OR: [
                    { email: { contains: params.search, mode: 'insensitive' as const } },
                    { firstName: { contains: params.search, mode: 'insensitive' as const } },
                    { lastName: { contains: params.search, mode: 'insensitive' as const } },
                ],
            }
            : {};

        const [total, data] = await Promise.all([
            this.prisma.user.count({ where }),
            this.prisma.user.findMany({
                where,
                select: {
                    id: true, email: true, firstName: true, lastName: true,
                    isActive: true, isSuperAdmin: true, emailVerified: true,
                    provider: true, lastLoginAt: true, createdAt: true,
                    _count: { select: { ownedWorkspaces: true, workspaceMemberships: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: params.limit,
            }),
        ]);

        return { data, total, page: params.page, limit: params.limit };
    }

    async toggleUserStatus(targetUserId: string, actorUserId: string) {
        if (targetUserId === actorUserId) {
            throw new AppError(
                'You cannot deactivate your own account',
                400,
                'SELF_DEACTIVATION',
            );
        }

        const user = await this.prisma.user.findUnique({
            where: { id: targetUserId },
            select: { id: true, email: true, isActive: true, isSuperAdmin: true },
        });
        if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

        const updated = await this.prisma.user.update({
            where: { id: targetUserId },
            data: { isActive: !user.isActive },
            select: { id: true, email: true, isActive: true },
        });

        await this.prisma.auditLog.create({
            data: {
                userId: actorUserId,
                action: updated.isActive
                    ? AuditAction.ADMIN_USER_ACTIVATED
                    : AuditAction.ADMIN_USER_SUSPENDED,
                resource: 'user',
                resourceId: targetUserId,
                details: { email: user.email, isActive: updated.isActive } as never,
            },
        });

        return updated;
    }

    async listWorkspaces(params: { page: number; limit: number; search?: string }) {
        const skip = (params.page - 1) * params.limit;
        const where = params.search
            ? { name: { contains: params.search, mode: 'insensitive' as const } }
            : {};

        const [total, data] = await Promise.all([
            this.prisma.workspace.count({ where }),
            this.prisma.workspace.findMany({
                where,
                select: {
                    id: true, name: true, type: true, defaultCurrency: true,
                    isActive: true, createdAt: true,
                    revenueBasis: true, inventoryValuation: true,
                    owner: { select: { id: true, email: true, firstName: true, lastName: true } },
                    _count: {
                        select: { members: true, cashbooks: true, accounts: true, journalEntries: true },
                    },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: params.limit,
            }),
        ]);

        return { data, total, page: params.page, limit: params.limit };
    }

    /** Platform-wide audit trail. The old admin module had no way to read this. */
    async listAuditLogs(params: {
        page: number; limit: number; action?: string; workspaceId?: string;
    }) {
        const skip = (params.page - 1) * params.limit;
        const where = {
            ...(params.action ? { action: params.action } : {}),
            ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        };

        const [total, data] = await Promise.all([
            this.prisma.auditLog.count({ where }),
            this.prisma.auditLog.findMany({
                where,
                include: {
                    user: { select: { id: true, email: true, firstName: true, lastName: true } },
                    workspace: { select: { id: true, name: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: params.limit,
            }),
        ]);

        return { data, total, page: params.page, limit: params.limit };
    }
}
