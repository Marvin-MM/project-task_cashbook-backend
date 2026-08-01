/**
 * Superadmin reconciliation.
 *
 * The old behaviour set isSuperAdmin only at signup, so adding an address to
 * the config did nothing for an existing account and removing one did nothing
 * at all. These tests pin the new contract: the env var is the source of truth.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, testPrisma } from '../../test/setup';
import { resolveService } from '../../test/container';
import { createUser } from '../../test/factories';
import { PlatformService } from './platform.service';

const platform = () => resolveService(PlatformService);

const originalList = process.env.SUPER_ADMIN_EMAILS;
const originalSingle = process.env.SUPER_ADMIN_EMAIL;

/**
 * config is parsed once at import time, so the env var alone is not enough —
 * patch the parsed object the same way a deployment would restart the process.
 */
async function setConfiguredSuperAdmins(emails: string[]) {
    const { config } = await import('../../config');
    (config as { SUPER_ADMIN_EMAILS: string }).SUPER_ADMIN_EMAILS = emails.join(',');
    (config as { SUPER_ADMIN_EMAIL: string }).SUPER_ADMIN_EMAIL = 'admin@cashbook.com';
}

describe('superadmin reconciliation', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    afterEach(async () => {
        const { config } = await import('../../config');
        (config as { SUPER_ADMIN_EMAILS: string }).SUPER_ADMIN_EMAILS = originalList ?? '';
        (config as { SUPER_ADMIN_EMAIL: string }).SUPER_ADMIN_EMAIL =
            originalSingle ?? 'admin@cashbook.com';
    });

    it('promotes a pre-existing user when their address is added to the list', async () => {
        const user = await createUser({ email: 'cfo@example.com' });
        expect(user.isSuperAdmin).toBe(false);

        await setConfiguredSuperAdmins(['cfo@example.com']);
        const result = await platform().reconcileSuperAdmins();

        expect(result.promoted).toEqual(['cfo@example.com']);
        const after = await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(after.isSuperAdmin).toBe(true);
    });

    it('demotes a user once their address is removed', async () => {
        const user = await createUser({ email: 'former@example.com' });
        await testPrisma.user.update({
            where: { id: user.id },
            data: { isSuperAdmin: true },
        });

        await setConfiguredSuperAdmins([]);
        const result = await platform().reconcileSuperAdmins();

        expect(result.demoted).toEqual(['former@example.com']);
        const after = await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(after.isSuperAdmin).toBe(false);
    });

    it('handles a list of several addresses', async () => {
        await createUser({ email: 'a@example.com' });
        await createUser({ email: 'b@example.com' });
        await createUser({ email: 'c@example.com' });

        await setConfiguredSuperAdmins(['a@example.com', 'b@example.com']);
        await platform().reconcileSuperAdmins();

        const admins = await testPrisma.user.findMany({
            where: { isSuperAdmin: true },
            select: { email: true },
        });
        expect(admins.map((a: { email: string }) => a.email).sort()).toEqual(['a@example.com', 'b@example.com']);
    });

    it('matches addresses case-insensitively', async () => {
        const user = await createUser({ email: 'mixed@example.com' });
        await setConfiguredSuperAdmins(['MIXED@Example.COM']);

        await platform().reconcileSuperAdmins();

        const after = await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(after.isSuperAdmin).toBe(true);
    });

    it('is idempotent — running twice changes nothing the second time', async () => {
        await createUser({ email: 'stable@example.com' });
        await setConfiguredSuperAdmins(['stable@example.com']);

        const first = await platform().reconcileSuperAdmins();
        const second = await platform().reconcileSuperAdmins();

        expect(first.promoted).toHaveLength(1);
        expect(second.promoted).toHaveLength(0);
        expect(second.demoted).toHaveLength(0);
    });

    it('reports a configured address that has no account yet', async () => {
        await setConfiguredSuperAdmins(['ghost@example.com']);
        const listing = await platform().listSuperAdmins();

        expect(listing.configured).toHaveLength(1);
        expect(listing.configured[0].status).toBe('NO_ACCOUNT');
        expect(listing.configured[0].user).toBeNull();
    });

    it('flags a database grant that is no longer in the config', async () => {
        const user = await createUser({ email: 'stale@example.com' });
        await testPrisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
        await setConfiguredSuperAdmins(['someone-else@example.com']);

        const listing = await platform().listSuperAdmins();
        expect(listing.unmanaged.map((u) => u.email)).toContain('stale@example.com');
    });
});

describe('platform user management', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('refuses to let a superadmin deactivate themselves', async () => {
        const admin = await createUser({ email: 'self@example.com' });

        await expect(
            platform().toggleUserStatus(admin.id, admin.id),
        ).rejects.toThrow(/cannot deactivate your own account/i);
    });

    it('toggles another user and writes an audit row', async () => {
        const admin = await createUser({ email: 'admin@example.com' });
        const target = await createUser({ email: 'target@example.com' });

        const result = await platform().toggleUserStatus(target.id, admin.id);
        expect(result.isActive).toBe(false);

        // The old admin module wrote no audit rows for any of its actions.
        const audit = await testPrisma.auditLog.findFirstOrThrow({
            where: { resourceId: target.id, resource: 'user' },
        });
        expect(audit.userId).toBe(admin.id);
    });
});
