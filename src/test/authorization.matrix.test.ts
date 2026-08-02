/**
 * Route-level authorization, exercised over real HTTP.
 *
 * The permission matrix is unit-tested separately; this proves the routes are
 * actually wired to it. The case that matters most: a plain MEMBER must not
 * reach any org-financial surface — before this work they could read full
 * inventory valuation and COGS.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { resetDatabase, testPrisma } from './setup';
import { createUser, createWorkspace, createCashbook, createAccount } from './factories';
import { provisionWorkspaceAccounting, ensureCashbookLedgerAccount } from '../core/ledger/coa.seed';

// Imported lazily so setup.ts has redirected DATABASE_URL first.
let app: import('express').Express;

beforeAll(async () => {
    // The route files resolve their controllers from the global container at
    // import time, so the container must be configured first.
    await import('../config/container');
    app = (await import('../app')).default;
});

/** Mint the cookie the auth middleware expects. */
async function tokenFor(userId: string, email: string, isSuperAdmin = false) {
    const { config } = await import('../config');
    return jwt.sign(
        { userId, email, isSuperAdmin, jti: `test-${userId}` },
        config.JWT_ACCESS_SECRET,
        { expiresIn: '15m' },
    );
}

interface Actor {
    userId: string;
    cookie: string;
}

async function makeActor(workspaceId: string, role: WorkspaceRole): Promise<Actor> {
    const user = await createUser({ email: `${role.toLowerCase()}-${Date.now()}@test.local` });
    await testPrisma.workspaceMember.create({
        data: { workspaceId, userId: user.id, role },
    });
    return {
        userId: user.id,
        cookie: `accessToken=${await tokenFor(user.id, user.email)}`,
    };
}

describe('route authorization by workspace role', () => {
    let workspaceId: string;
    let cashbookId: string;
    let owner: Actor;
    let admin: Actor;
    let accountant: Actor;
    let subAccountant: Actor;
    let projectManager: Actor;
    let hr: Actor;
    let member: Actor;

    beforeEach(async () => {
        await resetDatabase();

        const ownerUser = await createUser({ email: `owner-${Date.now()}@test.local` });
        const workspace = await createWorkspace(ownerUser.id);
        workspaceId = workspace.id;

        await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await provisionWorkspaceAccounting(tx, workspaceId, 'UGX');
        });

        const cashbook = await createCashbook(workspaceId, ownerUser.id);
        cashbookId = cashbook.id;
        await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await ensureCashbookLedgerAccount(tx, {
                id: cashbookId, workspaceId, name: cashbook.name, currency: 'UGX',
            });
        });

        owner = {
            userId: ownerUser.id,
            cookie: `accessToken=${await tokenFor(ownerUser.id, ownerUser.email)}`,
        };
        admin = await makeActor(workspaceId, WorkspaceRole.ADMIN);
        accountant = await makeActor(workspaceId, WorkspaceRole.ACCOUNTANT);
        subAccountant = await makeActor(workspaceId, WorkspaceRole.SUB_ACCOUNTANT);
        projectManager = await makeActor(workspaceId, WorkspaceRole.PROJECT_MANAGER);
        hr = await makeActor(workspaceId, WorkspaceRole.HR);
        member = await makeActor(workspaceId, WorkspaceRole.MEMBER);
    });

    const get = (path: string, actor: Actor) =>
        request(app).get(`/api/v1${path}`).set('Cookie', actor.cookie);

    describe('financial surfaces are closed to MEMBER', () => {
        it('denies net worth — the organisation\'s cash position', async () => {
            const res = await get(`/workspaces/${workspaceId}/accounts/net-worth`, member);
            expect(res.status).toBe(403);
        });

        it('denies wallet statements', async () => {
            const wallet = await testPrisma.account.findFirst({ where: { workspaceId } });
            if (!wallet) return;
            const res = await get(
                `/workspaces/${workspaceId}/accounts/${wallet.id}/transactions`,
                member,
            );
            expect(res.status).toBe(403);
        });

        it('denies inventory — the old leak let any member read valuation and COGS', async () => {
            expect((await get(`/workspaces/${workspaceId}/inventory/items`, member)).status).toBe(403);
            expect((await get(`/workspaces/${workspaceId}/inventory/reports/valuation`, member)).status).toBe(403);
            expect((await get(`/workspaces/${workspaceId}/inventory/reports/cogs`, member)).status).toBe(403);
        });

        it('denies invoices and the product catalog', async () => {
            expect((await get(`/workspaces/${workspaceId}/invoices`, member)).status).toBe(403);
            expect((await get(`/workspaces/${workspaceId}/catalog/products`, member)).status).toBe(403);
        });

        it('denies financial reports and the chart of accounts', async () => {
            const from = new Date('2026-01-01').toISOString();
            const to = new Date('2026-12-31').toISOString();
            expect((await get(`/workspaces/${workspaceId}/ledger-reports/balance-sheet`, member)).status).toBe(403);
            expect((await get(`/workspaces/${workspaceId}/ledger-reports/income-statement?from=${from}&to=${to}`, member)).status).toBe(403);
            expect((await get(`/workspaces/${workspaceId}/chart-of-accounts`, member)).status).toBe(403);
        });

        it('still allows workspace basics', async () => {
            expect((await get(`/workspaces/${workspaceId}`, member)).status).toBe(200);
        });
    });

    describe('a member assigned to a book can work in it', () => {
        beforeEach(async () => {
            await testPrisma.cashbookMember.create({
                data: { cashbookId, userId: member.userId, role: 'DATA_OPERATOR' },
            });
        });

        it('opens the book', async () => {
            expect((await get(`/cashbooks/${cashbookId}`, member)).status).toBe(200);
        });

        it('lists wallets, because an entry can be attached to one', async () => {
            // This is the case that regressed: the book page could not render a
            // wallet-linked entry, or offer the wallet picker, without this.
            const res = await get(`/workspaces/${workspaceId}/accounts`, member);
            expect(res.status).toBe(200);
        });

        it('sees wallet names but never balances', async () => {
            const bankType = await testPrisma.accountType.findFirstOrThrow({
                where: { workspaceId, name: 'Bank' },
            });
            await testPrisma.account.create({
                data: {
                    workspaceId,
                    accountTypeId: bankType.id,
                    name: 'Secret Bank',
                    currency: 'UGX',
                    balance: '999999',
                },
            });

            const asMember = await get(`/workspaces/${workspaceId}/accounts`, member);
            const wallet = asMember.body.data.find(
                (a: { name: string }) => a.name === 'Secret Bank',
            );
            expect(wallet).toBeTruthy();
            expect(wallet.name).toBe('Secret Bank');
            // Stripped server-side, so the figure never reaches the browser.
            expect(wallet.balance).toBeUndefined();

            const asOwner = await get(`/workspaces/${workspaceId}/accounts`, owner);
            const sameWallet = asOwner.body.data.find(
                (a: { name: string }) => a.name === 'Secret Bank',
            );
            expect(sameWallet.balance).toBeDefined();
        });

        it('can create an entry in that book', async () => {
            // Every entry must name the wallet the money moved through, so the
            // member needs one they can post against.
            const wallet = await createAccount(workspaceId, { name: 'Till' });

            const res = await request(app)
                .post(`/api/v1/entries/cashbook/${cashbookId}`)
                .set('Cookie', member.cookie)
                .send({
                    type: 'INCOME',
                    amount: '100',
                    description: 'member entry',
                    entryDate: new Date().toISOString(),
                    accountId: wallet.id,
                });
            expect(res.status).toBe(201);
        });

        it('refuses an entry that names no wallet', async () => {
            // The rule itself: an entry that records money moving without
            // recording where it moved is what lets a book's totals drift from
            // the cash actually on hand, with nothing to reconcile against.
            const res = await request(app)
                .post(`/api/v1/entries/cashbook/${cashbookId}`)
                .set('Cookie', member.cookie)
                .send({
                    type: 'INCOME',
                    amount: '100',
                    description: 'no wallet named',
                    entryDate: new Date().toISOString(),
                });
            expect(res.status).toBe(400);
        });
    });

    describe('financial surfaces are open to accountants', () => {
        it.each([
            ['owner', () => owner],
            ['admin', () => admin],
            ['accountant', () => accountant],
            ['sub-accountant', () => subAccountant],
        ])('allows %s to read wallets and the chart of accounts', async (_label, get_) => {
            const actor = get_();
            expect((await get(`/workspaces/${workspaceId}/accounts`, actor)).status).toBe(200);
            expect((await get(`/workspaces/${workspaceId}/chart-of-accounts`, actor)).status).toBe(200);
        });

        it.each([
            ['owner', () => owner],
            ['accountant', () => accountant],
            ['sub-accountant', () => subAccountant],
        ])('allows %s to run the balance sheet', async (_label, get_) => {
            const res = await get(`/workspaces/${workspaceId}/ledger-reports/balance-sheet`, get_());
            expect(res.status).toBe(200);
            expect(res.body.data.byCurrency[0].outOfBalance).toBe('0.0000');
        });
    });

    describe('chart of accounts management', () => {
        it('lets an accountant create an account but not a sub-accountant', async () => {
            const body = { code: '5260', name: 'Travel', class: 'EXPENSE' };

            const allowed = await request(app)
                .post(`/api/v1/workspaces/${workspaceId}/chart-of-accounts`)
                .set('Cookie', accountant.cookie)
                .send(body);
            expect(allowed.status).toBe(201);

            const denied = await request(app)
                .post(`/api/v1/workspaces/${workspaceId}/chart-of-accounts`)
                .set('Cookie', subAccountant.cookie)
                .send({ ...body, code: '5261' });
            expect(denied.status).toBe(403);
        });

        it('lets an accountant close a period but not a sub-accountant', async () => {
            const body = {
                startDate: new Date('2026-01-01').toISOString(),
                endDate: new Date('2026-03-31').toISOString(),
            };

            const denied = await request(app)
                .post(`/api/v1/workspaces/${workspaceId}/chart-of-accounts/periods/close`)
                .set('Cookie', subAccountant.cookie)
                .send(body);
            expect(denied.status).toBe(403);

            const allowed = await request(app)
                .post(`/api/v1/workspaces/${workspaceId}/chart-of-accounts/periods/close`)
                .set('Cookie', accountant.cookie)
                .send(body);
            expect(allowed.status).toBe(200);
        });
    });

    describe('member management', () => {
        it('lets an accountant invite a sub-accountant', async () => {
            const res = await request(app)
                .post(`/api/v1/workspaces/${workspaceId}/members`)
                .set('Cookie', accountant.cookie)
                .send({ email: 'new-sub@test.local', role: 'SUB_ACCOUNTANT' });

            expect([200, 201]).toContain(res.status);
        });

        it('stops an accountant from creating an ADMIN', async () => {
            const res = await request(app)
                .post(`/api/v1/workspaces/${workspaceId}/members`)
                .set('Cookie', accountant.cookie)
                .send({ email: 'new-admin@test.local', role: 'ADMIN' });

            expect(res.status).toBe(403);
            expect(res.body.message).toMatch(/can only assign/i);
        });

        it('stops a sub-accountant from managing anyone', async () => {
            const res = await request(app)
                .post(`/api/v1/workspaces/${workspaceId}/members`)
                .set('Cookie', subAccountant.cookie)
                .send({ email: 'nope@test.local', role: 'MEMBER' });

            expect(res.status).toBe(403);
        });
    });

    describe('implicit cashbook access', () => {
        it('lets an owner open a book they were never added to', async () => {
            // The old behaviour required an explicit CashbookMember row, so an
            // owner could be locked out of a book a member created.
            const res = await get(`/cashbooks/${cashbookId}`, owner);
            expect(res.status).toBe(200);
        });

        it('lets an accountant open any book', async () => {
            expect((await get(`/cashbooks/${cashbookId}`, accountant)).status).toBe(200);
        });

        it('denies a sub-accountant a book they have not been granted', async () => {
            const res = await get(`/cashbooks/${cashbookId}`, subAccountant);
            expect(res.status).toBe(403);
        });

        it('allows a sub-accountant once granted the book', async () => {
            await testPrisma.cashbookMember.create({
                data: { cashbookId, userId: subAccountant.userId, role: 'BOOK_ADMIN' },
            });
            expect((await get(`/cashbooks/${cashbookId}`, subAccountant)).status).toBe(200);
        });

        it('denies a plain member a book they have not been granted', async () => {
            expect((await get(`/cashbooks/${cashbookId}`, member)).status).toBe(403);
        });
    });

    describe('platform routes', () => {
        it('denies a workspace owner who is not a superadmin', async () => {
            expect((await get('/platform/stats', owner)).status).toBe(403);
        });

        it('allows a superadmin', async () => {
            const su = await createUser({ email: `su-${Date.now()}@test.local` });
            await testPrisma.user.update({
                where: { id: su.id },
                data: { isSuperAdmin: true },
            });

            const res = await request(app)
                .get('/api/v1/platform/stats')
                .set('Cookie', `accessToken=${await tokenFor(su.id, su.email, true)}`);
            expect(res.status).toBe(200);
        });

        it('denies a token whose superadmin claim is stale', async () => {
            const notAdmin = await createUser({ email: `stale-${Date.now()}@test.local` });
            // Token says superadmin; the database says otherwise. The database wins.
            const res = await request(app)
                .get('/api/v1/platform/stats')
                .set('Cookie', `accessToken=${await tokenFor(notAdmin.id, notAdmin.email, true)}`);
            expect(res.status).toBe(403);
        });
    });

    describe('the new roles are closed to money', () => {
        // The single most important assertion in the role expansion. A project
        // manager and an HR lead run the organisation's work and its people;
        // neither has any business reading its cash position.
        const financialPaths = (ws: string) => [
            `/workspaces/${ws}/accounts/net-worth`,
            `/workspaces/${ws}/inventory/items`,
            `/workspaces/${ws}/inventory/reports/valuation`,
            `/workspaces/${ws}/invoices`,
            `/workspaces/${ws}/catalog/products`,
            `/workspaces/${ws}/chart-of-accounts`,
            `/workspaces/${ws}/ledger-reports/balance-sheet`,
        ];

        it('denies every financial surface to PROJECT_MANAGER', async () => {
            for (const path of financialPaths(workspaceId)) {
                expect({ path, status: (await get(path, projectManager)).status })
                    .toEqual({ path, status: 403 });
            }
        });

        it('denies every financial surface to HR', async () => {
            for (const path of financialPaths(workspaceId)) {
                expect({ path, status: (await get(path, hr)).status })
                    .toEqual({ path, status: 403 });
            }
        });

        it('lets either reach a book they were explicitly added to', async () => {
            // No ACCESS_ALL_CASHBOOKS, so this must come from a real grant.
            await testPrisma.cashbookMember.create({
                data: { cashbookId, userId: projectManager.userId, role: 'DATA_OPERATOR' },
            });
            expect((await get(`/cashbooks/${cashbookId}`, projectManager)).status).toBe(200);
            // HR, with no grant, still cannot.
            expect((await get(`/cashbooks/${cashbookId}`, hr)).status).toBe(403);
        });
    });

    describe('delivery and people ops are separate', () => {
        it('lets a PROJECT_MANAGER create a project; HR and MEMBER cannot', async () => {
            const create = (actor: Actor) =>
                request(app)
                    .post(`/api/v1/workspaces/${workspaceId}/projects`)
                    .set('Cookie', actor.cookie)
                    .send({ name: `Project ${Date.now()}` });

            expect((await create(projectManager)).status).toBe(201);
            expect((await create(hr)).status).toBe(403);
            expect((await create(member)).status).toBe(403);
        });

        it('lets HR change attendance settings; a PROJECT_MANAGER cannot', async () => {
            const update = (actor: Actor) =>
                request(app)
                    .put(`/api/v1/workspaces/${workspaceId}/time-tracking/settings`)
                    .set('Cookie', actor.cookie)
                    .send({ attendanceClockInStart: '08:00', attendanceClockInEnd: '09:30' });

            expect((await update(hr)).status).toBe(200);
            expect((await update(projectManager)).status).toBe(403);
            expect((await update(member)).status).toBe(403);
        });

        it('lets both see the project and task modules at all', async () => {
            // USE_PROJECTS / USE_TASKS are held by every role; the row scoping
            // happens in the service, not here.
            for (const actor of [projectManager, hr, member]) {
                expect((await get(`/workspaces/${workspaceId}/projects`, actor)).status).toBe(200);
                expect((await get(`/workspaces/${workspaceId}/tasks`, actor)).status).toBe(200);
            }
        });
    });

    describe('member management is capped by role', () => {
        const invite = (actor: Actor, role: string) =>
            request(app)
                .post(`/api/v1/workspaces/${workspaceId}/members`)
                .set('Cookie', actor.cookie)
                .send({ email: `invitee-${Date.now()}-${role}@test.local`, role });

        it('lets HR bring in a MEMBER', async () => {
            expect((await invite(hr, 'MEMBER')).status).toBeLessThan(400);
        });

        it('stops HR granting anything above MEMBER', async () => {
            // Otherwise HR could hand itself the finances through a second
            // account, which is the whole reason for the cap.
            for (const role of ['ADMIN', 'ACCOUNTANT', 'SUB_ACCOUNTANT', 'HR', 'PROJECT_MANAGER']) {
                expect({ role, status: (await invite(hr, role)).status })
                    .toEqual({ role, status: 403 });
            }
        });

        it('stops a PROJECT_MANAGER inviting anybody', async () => {
            expect((await invite(projectManager, 'MEMBER')).status).toBe(403);
        });
    });

    describe('attendance policy is HR territory', () => {
        const patch = (actor: Actor) =>
            request(app)
                .patch(`/api/v1/workspaces/${workspaceId}/attendance/settings`)
                .set('Cookie', actor.cookie)
                .send({ geofenceEnforcement: 'ENFORCE' });

        it('lets HR change it', async () => {
            expect((await patch(hr)).status).toBe(200);
        });

        it('stops a project manager, an accountant and a member', async () => {
            for (const actor of [projectManager, accountant, member]) {
                expect((await patch(actor)).status).toBe(403);
            }
        });

        it('lets everyone read the rules that apply to them', async () => {
            for (const actor of [member, projectManager, hr]) {
                expect((await get(`/workspaces/${workspaceId}/attendance/settings`, actor)).status)
                    .toBe(200);
            }
        });
    });

    describe('presence is shared, location is not', () => {
        beforeEach(async () => {
            // One person clocked in, off-site, so there is detail to leak.
            await testPrisma.workSession.create({
                data: {
                    workspaceId,
                    userId: member.userId,
                    clockIn: new Date(),
                    businessDate: new Date(new Date().toISOString().slice(0, 10)),
                    presenceStatus: 'WORKING',
                    presenceChangedAt: new Date(),
                    clockInLocationLabel: 'Warehouse gate',
                    clockInWithinGeofence: false,
                },
            });
        });

        it('shows another member the status but not where they are', async () => {
            const res = await get(`/workspaces/${workspaceId}/attendance/team`, subAccountant);

            expect(res.status).toBe(200);
            expect(res.body.data[0].presenceStatus).toBe('WORKING');
            // The whole point of splitting these: knowing Jane is busy is fine,
            // knowing which gate she is standing at is not.
            expect(res.body.data[0].location).toBeUndefined();
            expect(res.body.data[0].clockIn).toBeUndefined();
        });

        it('shows HR the full picture', async () => {
            const res = await get(`/workspaces/${workspaceId}/attendance/team`, hr);

            expect(res.body.data[0].location).toBe('Warehouse gate');
            expect(res.body.data[0].withinGeofence).toBe(false);
        });
    });

    describe('attachment listing', () => {
        it('denies an entry belonging to a workspace the caller is not in', async () => {
            const outsiderUser = await createUser({ email: `outsider-${Date.now()}@test.local` });
            const entry = await testPrisma.entry.create({
                data: {
                    cashbookId,
                    type: 'INCOME',
                    amount: '100',
                    description: 'private',
                    entryDate: new Date(),
                    createdById: owner.userId,
                },
            });

            // Previously this route had no guard at all: any authenticated user
            // could list attachment metadata for any entry id.
            const res = await request(app)
                .get(`/api/v1/files/entries/${entry.id}`)
                .set('Cookie', `accessToken=${await tokenFor(outsiderUser.id, outsiderUser.email)}`);

            expect([403, 404]).toContain(res.status);
        });
    });
});
