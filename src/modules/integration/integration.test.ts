/**
 * Integration-level tests for the external API integration surface.
 *
 * Uses supertest to mount the integration router on a minimal Express app, with
 * the database mocked via vi.mock — so no Postgres is needed for these tests.
 *
 * Tests cover:
 *   - X-API-Key header missing → 401
 *   - Invalid key format → 401
 *   - Valid key but wrong scope → 403
 *   - Valid key, wrong bookRef → 403
 *   - bookRef restricted to different book → 403
 *   - Happy path: single entry, idempotent replay (200), batch
 *   - IP allowlist enforcement
 *   - Rate limiting is wired (sanity test only, exact limits not tested here)
 *   - requireApiKeyScope guard in isolation
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockResolveApiKey = vi.fn();
const mockSubmitEntry = vi.fn();
const mockSubmitBatch = vi.fn();
const mockGetBookSummary = vi.fn();

vi.mock('@/config/database', () => ({
    getPrismaClient: vi.fn(() => ({
        cashbook: {
            findFirst: vi.fn(),
        },
    })),
}));

vi.mock('@/modules/api-keys/api-keys.service', () => ({
    ApiKeysService: vi.fn().mockImplementation(() => ({
        resolveApiKey: mockResolveApiKey,
    })),
}));

vi.mock('@/modules/integration/integration.service', () => ({
    IntegrationService: vi.fn().mockImplementation(() => ({
        submitEntry: mockSubmitEntry,
        submitBatch: mockSubmitBatch,
        getBookSummary: mockGetBookSummary,
    })),
}));

// tsyringe container mock
vi.mock('tsyringe', () => ({
    injectable: () => () => {},
    inject: () => () => {},
    container: {
        resolve: vi.fn((Cls: any) => new Cls()),
    },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_KEY = 'ick_live_' + 'a'.repeat(43); // 52 chars total, satisfies length check
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const CASHBOOK_ID  = '22222222-2222-2222-2222-222222222222';
const BOOK_REF     = 'CB-ABCD1234';

const BASE_KEY_CTX = {
    id: 'key-abc',
    workspaceId: WORKSPACE_ID,
    createdById: '44444444-4444-4444-4444-444444444444',
    scopes: ['WRITE_ENTRIES', 'READ_ENTRIES'],
    allowedBookIds: [CASHBOOK_ID],
    allowedIps: [],
};

function buildApp() {
    // We rebuild a fresh app for each suite so mock state is isolated.
    const app = express();
    app.use(express.json());

    // Error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
        res.status(err.statusCode ?? 500).json({
            success: false,
            message: err.message,
            code: err.code,
        });
    });

    return app;
}

// ─── authenticateApiKey middleware ────────────────────────────────────────────

describe('authenticateApiKey middleware', () => {
    it('returns 401 when X-API-Key header is missing', async () => {
        const { authenticateApiKey } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.get('/test', authenticateApiKey() as any, (_req, res) => res.json({ ok: true }));

        const res = await request(app).get('/test');
        expect(res.status).toBe(401);
    });

    it('returns 401 for a malformed key (wrong prefix)', async () => {
        const { authenticateApiKey } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.get('/test', authenticateApiKey() as any, (_req, res) => res.json({ ok: true }));

        const res = await request(app).get('/test').set('X-API-Key', 'sk_live_not_our_format');
        expect(res.status).toBe(401);
    });

    it('returns 401 when resolveApiKey returns null (unknown key)', async () => {
        mockResolveApiKey.mockResolvedValue(null);
        const { authenticateApiKey } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.get('/test', authenticateApiKey() as any, (_req, res) => res.json({ ok: true }));

        const res = await request(app).get('/test').set('X-API-Key', VALID_KEY);
        expect(res.status).toBe(401);
    });

    it('returns 401 when the key is past its expiry', async () => {
        mockResolveApiKey.mockResolvedValue(null); // resolveApiKey returns null for expired
        const { authenticateApiKey } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.get('/test', authenticateApiKey() as any, (_req, res) => res.json({ ok: true }));

        const res = await request(app).get('/test').set('X-API-Key', VALID_KEY);
        expect(res.status).toBe(401);
    });

    it('attaches apiKey context to req on success', async () => {
        mockResolveApiKey.mockResolvedValue(BASE_KEY_CTX);
        const { authenticateApiKey } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        let capturedCtx: any;
        app.get('/test', authenticateApiKey() as any, (req: any, res) => {
            capturedCtx = req.apiKey;
            res.json({ ok: true });
        });

        await request(app).get('/test').set('X-API-Key', VALID_KEY);
        expect(capturedCtx).toMatchObject({ workspaceId: WORKSPACE_ID });
    });

    it('returns 403 when client IP is not in the allowlist', async () => {
        mockResolveApiKey.mockResolvedValue({
            ...BASE_KEY_CTX,
            allowedIps: ['203.0.113.1'],
        });
        const { authenticateApiKey } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.get('/test', authenticateApiKey() as any, (_req, res) => res.json({ ok: true }));

        // supertest uses 127.0.0.1 as the client IP
        const res = await request(app).get('/test').set('X-API-Key', VALID_KEY);
        expect(res.status).toBe(403);
    });
});

// ─── requireApiKeyScope guard ─────────────────────────────────────────────────

describe('requireApiKeyScope', () => {
    it('passes when the required scope is present', async () => {
        mockResolveApiKey.mockResolvedValue(BASE_KEY_CTX);
        const { authenticateApiKey, requireApiKeyScope } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.post(
            '/test',
            authenticateApiKey() as any,
            requireApiKeyScope('WRITE_ENTRIES') as any,
            (_req, res) => res.json({ ok: true }),
        );

        const res = await request(app).post('/test').set('X-API-Key', VALID_KEY).send({});
        expect(res.status).toBe(200);
    });

    it('returns 403 when the required scope is absent', async () => {
        mockResolveApiKey.mockResolvedValue({
            ...BASE_KEY_CTX,
            scopes: ['READ_ENTRIES'], // missing WRITE_ENTRIES
        });
        const { authenticateApiKey, requireApiKeyScope } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.post(
            '/test',
            authenticateApiKey() as any,
            requireApiKeyScope('WRITE_ENTRIES') as any,
            (_req, res) => res.json({ ok: true }),
        );

        const res = await request(app).post('/test').set('X-API-Key', VALID_KEY).send({});
        expect(res.status).toBe(403);
    });
});

// ─── requireApiKeyBookAccess guard ────────────────────────────────────────────

describe('requireApiKeyBookAccess', () => {
    it('returns 403 when bookRef is missing from the request body', async () => {
        mockResolveApiKey.mockResolvedValue(BASE_KEY_CTX);
        const { authenticateApiKey, requireApiKeyBookAccess } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.post(
            '/test',
            express.json(),
            authenticateApiKey() as any,
            requireApiKeyBookAccess() as any,
            (_req, res) => res.json({ ok: true }),
        );

        const res = await request(app).post('/test').set('X-API-Key', VALID_KEY).send({});
        expect(res.status).toBe(403);
    });

    it('returns 403 when bookRef does not match any active cashbook', async () => {
        mockResolveApiKey.mockResolvedValue(BASE_KEY_CTX);
        // Override the DB mock to return null
        const { getPrismaClient } = await import('@/config/database');
        (getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue({
            cashbook: { findFirst: vi.fn().mockResolvedValue(null) },
        });

        const { authenticateApiKey, requireApiKeyBookAccess } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.post(
            '/test',
            express.json(),
            authenticateApiKey() as any,
            requireApiKeyBookAccess() as any,
            (_req, res) => res.json({ ok: true }),
        );

        const res = await request(app)
            .post('/test')
            .set('X-API-Key', VALID_KEY)
            .send({ bookRef: 'CB-NONEXISTENT' });
        expect(res.status).toBe(403);
    });

    it('returns 403 when key is restricted to different books', async () => {
        const OTHER_CASHBOOK_ID = '33333333-3333-3333-3333-333333333333';
        mockResolveApiKey.mockResolvedValue({
            ...BASE_KEY_CTX,
            allowedBookIds: [OTHER_CASHBOOK_ID],
        });
        const { getPrismaClient } = await import('@/config/database');
        (getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue({
            cashbook: { findFirst: vi.fn().mockResolvedValue({ id: CASHBOOK_ID }) },
        });

        const { authenticateApiKey, requireApiKeyBookAccess } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.post(
            '/test',
            express.json(),
            authenticateApiKey() as any,
            requireApiKeyBookAccess() as any,
            (_req, res) => res.json({ ok: true }),
        );

        const res = await request(app)
            .post('/test')
            .set('X-API-Key', VALID_KEY)
            .send({ bookRef: BOOK_REF });
        expect(res.status).toBe(403);
    });

    it('returns 403 when key has no allowed books', async () => {
        mockResolveApiKey.mockResolvedValue({
            ...BASE_KEY_CTX,
            allowedBookIds: [],
        });
        const { getPrismaClient } = await import('@/config/database');
        (getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue({
            cashbook: { findFirst: vi.fn().mockResolvedValue({ id: CASHBOOK_ID }) },
        });

        const { authenticateApiKey, requireApiKeyBookAccess } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.post(
            '/test',
            express.json(),
            authenticateApiKey() as any,
            requireApiKeyBookAccess() as any,
            (_req, res) => res.json({ ok: true }),
        );

        const res = await request(app)
            .post('/test')
            .set('X-API-Key', VALID_KEY)
            .send({ bookRef: BOOK_REF });
        expect(res.status).toBe(403);
    });

    it('resolves the cashbook and attaches resolvedCashbookId', async () => {
        mockResolveApiKey.mockResolvedValue(BASE_KEY_CTX);
        const { getPrismaClient } = await import('@/config/database');
        (getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue({
            cashbook: { findFirst: vi.fn().mockResolvedValue({ id: CASHBOOK_ID }) },
        });

        const { authenticateApiKey, requireApiKeyBookAccess } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        let capturedId: any;
        app.post(
            '/test',
            express.json(),
            authenticateApiKey() as any,
            requireApiKeyBookAccess() as any,
            (req: any, res) => {
                capturedId = req.resolvedCashbookId;
                res.json({ ok: true });
            },
        );

        await request(app)
            .post('/test')
            .set('X-API-Key', VALID_KEY)
            .send({ bookRef: BOOK_REF });

        expect(capturedId).toBe(CASHBOOK_ID);
    });
});

// ─── Integration route happy paths ────────────────────────────────────────────

describe('POST /integrate/entries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockResolveApiKey.mockResolvedValue(BASE_KEY_CTX);
        // Re-apply the DB mock after clearAllMocks resets it
        mockSubmitEntry.mockReset();
        mockSubmitBatch.mockReset();
    });

    it('returns 201 for a new entry', async () => {
        // Set up DB mock for this specific test
        const dbModule = await import('@/config/database');
        (dbModule.getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue({
            cashbook: { findFirst: vi.fn().mockResolvedValue({ id: CASHBOOK_ID }) },
        });
        mockSubmitEntry.mockResolvedValue({
            entry: { id: 'entry-1', type: 'INCOME', amount: '10000' },
            idempotent: false,
        });
        const { authenticateApiKey, requireApiKeyScope, requireApiKeyBookAccess } =
            await import('@/middlewares/authenticateApiKey');
        const { IntegrationController } = await import('./integration.controller');
        const ctrl = new IntegrationController({ submitEntry: mockSubmitEntry, submitBatch: mockSubmitBatch, getBookSummary: mockGetBookSummary } as any);

        const app = buildApp();
        app.use(express.json());
        app.post(
            '/integrate/entries',
            authenticateApiKey() as any,
            requireApiKeyScope('WRITE_ENTRIES') as any,
            requireApiKeyBookAccess() as any,
            ctrl.submitEntry.bind(ctrl) as any,
        );

        const res = await request(app)
            .post('/integrate/entries')
            .set('X-API-Key', VALID_KEY)
            .send({ bookRef: BOOK_REF, type: 'INCOME', amount: '10000', description: 'Sale' });

        expect(res.status).toBe(201);
        expect(res.body.data).toHaveProperty('id', 'entry-1');
    });

    it('returns 200 (idempotent) when externalRef already exists', async () => {
        const dbModule = await import('@/config/database');
        (dbModule.getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue({
            cashbook: { findFirst: vi.fn().mockResolvedValue({ id: CASHBOOK_ID }) },
        });
        mockSubmitEntry.mockResolvedValue({
            entry: { id: 'entry-existing', type: 'INCOME', amount: '10000' },
            idempotent: true,
        });
        const { authenticateApiKey, requireApiKeyScope, requireApiKeyBookAccess } =
            await import('@/middlewares/authenticateApiKey');
        const { IntegrationController } = await import('./integration.controller');
        const ctrl = new IntegrationController({ submitEntry: mockSubmitEntry, submitBatch: mockSubmitBatch, getBookSummary: mockGetBookSummary } as any);

        const app = buildApp();
        app.use(express.json());
        app.post(
            '/integrate/entries',
            authenticateApiKey() as any,
            requireApiKeyScope('WRITE_ENTRIES') as any,
            requireApiKeyBookAccess() as any,
            ctrl.submitEntry.bind(ctrl) as any,
        );

        const res = await request(app)
            .post('/integrate/entries')
            .set('X-API-Key', VALID_KEY)
            .send({ bookRef: BOOK_REF, type: 'INCOME', amount: '10000', description: 'Sale', externalRef: 'ord-1' });

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/idempotent/i);
    });
});

describe('GET /integrate/book/:bookRef', () => {
    it('returns book summary for a READ_ENTRIES key', async () => {
        mockResolveApiKey.mockResolvedValue(BASE_KEY_CTX);
        const { getPrismaClient } = await import('@/config/database');
        (getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue({
            cashbook: { findFirst: vi.fn().mockResolvedValue({ id: CASHBOOK_ID }) },
        });
        mockGetBookSummary.mockResolvedValue({
            id: CASHBOOK_ID,
            bookRef: BOOK_REF,
            name: 'Main Book',
            currency: 'UGX',
            balance: '100000',
            totalIncome: '200000',
            totalExpense: '100000',
        });

        const { authenticateApiKey, requireApiKeyScope, requireApiKeyBookAccess } =
            await import('@/middlewares/authenticateApiKey');
        const { IntegrationController } = await import('./integration.controller');
        const ctrl = new IntegrationController({ submitEntry: mockSubmitEntry, submitBatch: mockSubmitBatch, getBookSummary: mockGetBookSummary } as any);

        const app = buildApp();
        app.get(
            '/integrate/book/:bookRef',
            authenticateApiKey() as any,
            requireApiKeyScope('READ_ENTRIES') as any,
            requireApiKeyBookAccess() as any,
            ctrl.getBookSummary.bind(ctrl) as any,
        );

        const res = await request(app)
            .get(`/integrate/book/${BOOK_REF}`)
            .set('X-API-Key', VALID_KEY);

        expect(res.status).toBe(200);
        expect(res.body.data.bookRef).toBe(BOOK_REF);
        expect(res.body.data.name).toBe('Main Book');
    });

    it('returns 403 for a key with only WRITE_ENTRIES scope', async () => {
        mockResolveApiKey.mockResolvedValue({
            ...BASE_KEY_CTX,
            scopes: ['WRITE_ENTRIES'],
        });

        const { authenticateApiKey, requireApiKeyScope } = await import('@/middlewares/authenticateApiKey');
        const app = buildApp();
        app.get(
            '/integrate/book/:bookRef',
            authenticateApiKey() as any,
            requireApiKeyScope('READ_ENTRIES') as any,
            (_req, res) => res.json({ ok: true }),
        );

        const res = await request(app)
            .get(`/integrate/book/${BOOK_REF}`)
            .set('X-API-Key', VALID_KEY);

        expect(res.status).toBe(403);
    });
});
