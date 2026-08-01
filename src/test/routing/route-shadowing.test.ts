/**
 * Literal paths must not be shadowed by parameterised ones.
 *
 * Express matches routes in declaration order. A `/:taskId` declared before
 * `/assignment-requests` binds taskId to the literal string
 * "assignment-requests"; the uuid guard then rejects it and the endpoint
 * answers 400 to every caller, forever, with a validation error that names a
 * field the client never sent.
 *
 * Both cases below shipped that way. Neither threw, neither was caught by a
 * type, and the routes file carried a comment claiming the order was already
 * correct — so the only thing that can hold this is a request.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { WorkspaceRole } from '@prisma/client';
import { resetDatabase, testPrisma } from '../setup';
import { createCashbook, createUser, createWorkspace } from '../factories';

let app: import('express').Express;

beforeAll(async () => {
    await import('../../config/container');
    app = (await import('../../app')).default;
});

async function cookieFor(userId: string, email: string) {
    const { config } = await import('../../config');
    const token = jwt.sign(
        { userId, email, isSuperAdmin: false, jti: `test-${userId}` },
        config.JWT_ACCESS_SECRET,
        { expiresIn: '15m' },
    );
    return `accessToken=${token}`;
}

let workspaceId: string;
let cashbookId: string;
let cookie: string;

beforeEach(async () => {
    await resetDatabase();
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    workspaceId = workspace.id;
    await testPrisma.workspaceMember.create({
        data: { workspaceId, userId: owner.id, role: WorkspaceRole.OWNER },
    });
    cashbookId = (await createCashbook(workspaceId, owner.id)).id;
    cookie = await cookieFor(owner.id, owner.email);
});

describe('task assignment requests', () => {
    it('reaches its own handler rather than GET /:taskId', async () => {
        const res = await request(app)
            .get(`/api/v1/workspaces/${workspaceId}/tasks/assignment-requests`)
            .set('Cookie', cookie);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('accepts a taskId filter — the exact call that was 400ing', async () => {
        const taskId = '34c2ee28-9ca8-4e04-a0f7-91f407c55202';
        const res = await request(app)
            .get(`/api/v1/workspaces/${workspaceId}/tasks/assignment-requests`)
            .query({ taskId })
            .set('Cookie', cookie);

        expect(res.status).toBe(200);
    });

    it('still rejects a genuinely malformed task id', async () => {
        // The uuid guard must keep working on the route that actually has one.
        const res = await request(app)
            .get(`/api/v1/workspaces/${workspaceId}/tasks/not-a-uuid`)
            .set('Cookie', cookie);

        expect(res.status).toBe(400);
    });
});

describe('entry delete requests', () => {
    it('reaches its own handler rather than GET /:entryId/cashbook/:cashbookId', async () => {
        // Same shape, three segments deep, and with no uuid guard on the
        // shadowing route it went to Prisma with entryId = "delete-requests".
        const res = await request(app)
            .get(`/api/v1/entries/delete-requests/cashbook/${cashbookId}`)
            .set('Cookie', cookie);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
    });
});
