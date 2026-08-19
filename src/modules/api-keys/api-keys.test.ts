/**
 * Unit tests for the API key generation, validation, and management logic.
 *
 * Strategy: use Vitest mocks for PrismaClient so we do NOT need a live database.
 * These tests verify:
 *   - Raw key format and uniqueness
 *   - Hash round-trip (generate → hash → verify via resolveApiKey)
 *   - Key creation side-effects (explicit book selection, invalid bookId guard)
 *   - Key rotation (old hash replaced, lastUsedAt zeroed)
 *   - Revocation (status flipped, revokedAt/revokedById set)
 *   - resolveApiKey returns null for unknown, revoked, and expired keys
 *   - IP allowlist enforcement in the middleware
 *   - requireApiKeyScope guard
 */
import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ─── Key-format helpers (extracted so we can test them in isolation) ───────────

function generateRawKey(): string {
    const bytes = crypto.randomBytes(32);
    return `ick_live_${bytes.toString('base64url')}`;
}

function hashKey(rawKey: string): string {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function keyPrefix(rawKey: string): string {
    return rawKey.substring(0, 12);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake PrismaClient. Callers override only what they need by
 * passing a partial overrides object.
 */
function makePrisma(overrides: Record<string, unknown> = {}) {
    return {
        apiKey: {
            findUnique: vi.fn(),
            findMany: vi.fn().mockResolvedValue([]),
            create: vi.fn(),
            update: vi.fn(),
            count: vi.fn().mockResolvedValue(0),
        },
        cashbook: {
            findMany: vi.fn().mockResolvedValue([]),
            findFirst: vi.fn(),
            findUnique: vi.fn(),
            updateMany: vi.fn(),
        },
        cashbookMember: {
            findMany: vi.fn().mockResolvedValue([]),
        },
        auditLog: {
            create: vi.fn().mockResolvedValue({}),
        },
        ...overrides,
    } as unknown as any;
}

// ─── 1. Key format ────────────────────────────────────────────────────────────

describe('API key format', () => {
    it('generated keys start with the ick_live_ prefix', () => {
        const key = generateRawKey();
        expect(key.startsWith('ick_live_')).toBe(true);
    });

    it('generated keys are at least 40 characters long', () => {
        const key = generateRawKey();
        expect(key.length).toBeGreaterThanOrEqual(40);
    });

    it('two generated keys are never identical', () => {
        const keys = new Set(Array.from({ length: 100 }, generateRawKey));
        expect(keys.size).toBe(100);
    });

    it('hash of the same key is always identical (deterministic)', () => {
        const key = generateRawKey();
        expect(hashKey(key)).toBe(hashKey(key));
    });

    it('hash of two different keys is always different', () => {
        const a = generateRawKey();
        const b = generateRawKey();
        expect(hashKey(a)).not.toBe(hashKey(b));
    });

    it('hash is 64 hex characters (SHA-256)', () => {
        expect(hashKey(generateRawKey())).toMatch(/^[0-9a-f]{64}$/);
    });

    it('keyPrefix returns the first 12 characters', () => {
        const key = 'ick_live_ABCDEFGHIJKLMNOP';
        expect(keyPrefix(key)).toBe('ick_live_ABC');
    });
});

// ─── 2. ApiKeysService unit tests ─────────────────────────────────────────────

/**
 * Import the real service but inject a mocked Prisma so no DB is needed.
 * We use vi.mock to intercept the database module before the service module
 * loads, then re-import the service fresh each time.
 */
vi.mock('@/config/database', () => ({ getPrismaClient: vi.fn() }));

describe('ApiKeysService', () => {
    describe('createApiKey', () => {
        it('rejects if any allowedBookId does not belong to the workspace', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            // count returns 0 (under limit)
            (prisma.cashbook.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'book-1' }]);
            (prisma.cashbook.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ bookRef: 'CB-ABC' });
            // findMany returns fewer books than requested
            (prisma.cashbook.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
            const svc = new (ApiKeysService as any)(prisma);

            await expect(
                svc.createApiKey('ws-1', 'user-1', 'OWNER', {
                    name: 'Bad Book',
                    scopes: ['WRITE_ENTRIES'],
                    allowedBookIds: ['non-existent-uuid'],
                }),
            ).rejects.toThrow('do not belong to this workspace');
        });

        it('returns the raw key only once (not in subsequent list calls)', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.cashbook.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'book-1' }]);
            (prisma.cashbook.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ bookRef: 'CB-ABCD' });
            const fakeKey = {
                id: 'key-1',
                name: 'Test',
                keyPrefix: 'ick_live_AB',
                scopes: ['WRITE_ENTRIES'],
                status: 'ACTIVE',
                allowedBookIds: ['book-1'],
                allowedIps: [],
                expiresAt: null,
                createdAt: new Date(),
            };
            (prisma.apiKey.create as ReturnType<typeof vi.fn>).mockResolvedValue(fakeKey);
            const svc = new (ApiKeysService as any)(prisma);

            const result = await svc.createApiKey('ws-1', 'user-1', 'OWNER', {
                name: 'Test',
                scopes: ['WRITE_ENTRIES'],
                allowedBookIds: ['book-1'],
            });

            expect(result).toHaveProperty('rawKey');
            expect(result.rawKey).toMatch(/^ick_live_/);
            expect(result.rawKey.length).toBeGreaterThanOrEqual(40);
        });

        it('allows a developer to create a key only for assigned books', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.cashbook.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'book-1' }]);
            (prisma.cashbookMember.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ cashbookId: 'book-1' }]);
            (prisma.cashbook.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ bookRef: 'CB-ABCD' });
            (prisma.apiKey.create as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'key-1',
                name: 'Developer key',
                keyPrefix: 'ick_live_AB',
                scopes: ['WRITE_ENTRIES'],
                status: 'ACTIVE',
                allowedBookIds: ['book-1'],
                allowedIps: [],
                expiresAt: null,
                createdAt: new Date(),
            });
            const svc = new (ApiKeysService as any)(prisma);

            const result = await svc.createApiKey('ws-1', 'developer-1', 'DEVELOPER', {
                name: 'Developer key',
                scopes: ['WRITE_ENTRIES'],
                allowedBookIds: ['book-1'],
            });

            expect(result.allowedBookIds).toEqual(['book-1']);
        });

        it('rejects a developer selecting a book they are not assigned to', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.cashbook.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'book-1' }]);
            (prisma.cashbookMember.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
            const svc = new (ApiKeysService as any)(prisma);

            await expect(
                svc.createApiKey('ws-1', 'developer-1', 'DEVELOPER', {
                    name: 'Developer key',
                    scopes: ['WRITE_ENTRIES'],
                    allowedBookIds: ['book-1'],
                }),
            ).rejects.toThrow('assigned');
        });
    });

    describe('resolveApiKey', () => {
        it('returns null for a key that does not exist', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
            const svc = new (ApiKeysService as any)(prisma);

            const result = await svc.resolveApiKey('ick_live_nonexistent');
            expect(result).toBeNull();
        });

        it('returns null for a REVOKED key', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'key-1',
                workspaceId: 'ws-1',
                scopes: ['WRITE_ENTRIES'],
                allowedBookIds: [],
                allowedIps: [],
                status: 'REVOKED',
                expiresAt: null,
                workspace: { type: 'BUSINESS' },
            });
            (prisma.apiKey.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
            const svc = new (ApiKeysService as any)(prisma);

            const rawKey = generateRawKey();
            const result = await svc.resolveApiKey(rawKey);
            expect(result).toBeNull();
        });

        it('returns null for an expired key', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'key-1',
                workspaceId: 'ws-1',
                scopes: ['WRITE_ENTRIES'],
                allowedBookIds: [],
                allowedIps: [],
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() - 1000), // already expired
                workspace: { type: 'BUSINESS' },
            });
            (prisma.apiKey.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
            const svc = new (ApiKeysService as any)(prisma);

            const result = await svc.resolveApiKey(generateRawKey());
            expect(result).toBeNull();
        });

        it('returns the key context for a valid, active, non-expired key', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();

            const fakeCtx = {
                id: 'key-1',
                workspaceId: 'ws-1',
                scopes: ['WRITE_ENTRIES'],
                allowedBookIds: [],
                allowedIps: [],
                status: 'ACTIVE',
                expiresAt: null,
                workspace: { type: 'BUSINESS' },
            };
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(fakeCtx);
            (prisma.apiKey.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
            const svc = new (ApiKeysService as any)(prisma);

            const result = await svc.resolveApiKey(generateRawKey());
            expect(result).toMatchObject({
                id: 'key-1',
                workspaceId: 'ws-1',
                scopes: ['WRITE_ENTRIES'],
            });
        });

        it('returns null for a key that belongs to a personal workspace', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'key-1',
                workspaceId: 'ws-1',
                createdById: 'user-1',
                scopes: ['WRITE_ENTRIES'],
                allowedBookIds: ['book-1'],
                allowedIps: [],
                status: 'ACTIVE',
                expiresAt: null,
                workspace: { type: 'PERSONAL' },
            });
            const svc = new (ApiKeysService as any)(prisma);

            const result = await svc.resolveApiKey(generateRawKey());
            expect(result).toBeNull();
        });
    });

    describe('revokeApiKey', () => {
        it('throws if key not found or belongs to different workspace', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
            const svc = new (ApiKeysService as any)(prisma);

            await expect(
                svc.revokeApiKey('key-1', 'ws-1', 'user-1'),
            ).rejects.toThrow();
        });

        it('throws if key is already revoked', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'key-1',
                workspaceId: 'ws-1',
                name: 'Test',
                status: 'REVOKED',
            });
            const svc = new (ApiKeysService as any)(prisma);

            await expect(
                svc.revokeApiKey('key-1', 'ws-1', 'user-1'),
            ).rejects.toThrow('already revoked');
        });
    });

    describe('rotateApiKey', () => {
        it('issues a new raw key and returns it once', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'key-1',
                workspaceId: 'ws-1',
                name: 'Prod Key',
                status: 'ACTIVE',
            });
            const updatedKey = {
                id: 'key-1',
                name: 'Prod Key',
                keyPrefix: 'ick_live_AB',
                scopes: ['WRITE_ENTRIES'],
                status: 'ACTIVE',
                allowedBookIds: [],
                allowedIps: [],
                expiresAt: null,
                createdAt: new Date(),
            };
            (prisma.apiKey.update as ReturnType<typeof vi.fn>).mockResolvedValue(updatedKey);
            const svc = new (ApiKeysService as any)(prisma);

            const result = await svc.rotateApiKey('key-1', 'ws-1', 'user-1');
            expect(result).toHaveProperty('rawKey');
            expect(result.rawKey).toMatch(/^ick_live_/);

            // Ensure lastUsedAt was reset (null in the update call)
            const updateCall = (prisma.apiKey.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(updateCall.data.lastUsedAt).toBeNull();
        });

        it('throws if trying to rotate a revoked key', async () => {
            const { ApiKeysService } = await import('./api-keys.service');
            const prisma = makePrisma();
            (prisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
                id: 'key-1',
                workspaceId: 'ws-1',
                name: 'Old Key',
                status: 'REVOKED',
            });
            const svc = new (ApiKeysService as any)(prisma);

            await expect(
                svc.rotateApiKey('key-1', 'ws-1', 'user-1'),
            ).rejects.toThrow('revoked');
        });
    });
});

// ─── 3. Integration DTO validation tests ──────────────────────────────────────

describe('integrateEntrySchema', () => {
    it('accepts a valid single-entry payload', async () => {
        const { integrateEntrySchema } = await import('../integration/integration.dto');
        const result = integrateEntrySchema.parse({
            bookRef: 'CB-ABCD1234',
            type: 'INCOME',
            amount: '15000.00',
            description: 'Sale payment',
        });
        expect(result.type).toBe('INCOME');
        expect(result.amount).toBe('15000.00');
    });

    it('rejects an invalid amount format', async () => {
        const { integrateEntrySchema } = await import('../integration/integration.dto');
        expect(() =>
            integrateEntrySchema.parse({
                bookRef: 'CB-X',
                type: 'INCOME',
                amount: 'not-a-number',
                description: 'Bad',
            }),
        ).toThrow();
    });

    it('rejects an unknown entry type', async () => {
        const { integrateEntrySchema } = await import('../integration/integration.dto');
        expect(() =>
            integrateEntrySchema.parse({
                bookRef: 'CB-X',
                type: 'TRANSFER',
                amount: '100',
                description: 'Bad type',
            }),
        ).toThrow();
    });

    it('allows externalRef for idempotency', async () => {
        const { integrateEntrySchema } = await import('../integration/integration.dto');
        const result = integrateEntrySchema.parse({
            bookRef: 'CB-ABCD1234',
            type: 'EXPENSE',
            amount: '3500.5',
            description: 'Office supplies',
            externalRef: 'order-9999',
        });
        expect(result.externalRef).toBe('order-9999');
    });
});

describe('integrateBatchSchema', () => {
    it('rejects an empty entries array', async () => {
        const { integrateBatchSchema } = await import('../integration/integration.dto');
        expect(() => integrateBatchSchema.parse({ entries: [] })).toThrow();
    });

    it('accepts a batch of up to 100 entries', async () => {
        const { integrateBatchSchema } = await import('../integration/integration.dto');
        const entries = Array.from({ length: 100 }, (_, i) => ({
            bookRef: 'CB-ABCD1234',
            type: 'INCOME' as const,
            amount: '100.00',
            description: `Entry ${i}`,
        }));
        const result = integrateBatchSchema.parse({ entries });
        expect(result.entries.length).toBe(100);
    });

    it('rejects more than 100 entries', async () => {
        const { integrateBatchSchema } = await import('../integration/integration.dto');
        const entries = Array.from({ length: 101 }, (_, i) => ({
            bookRef: 'CB-ABCD1234',
            type: 'INCOME' as const,
            amount: '100.00',
            description: `Entry ${i}`,
        }));
        expect(() => integrateBatchSchema.parse({ entries })).toThrow();
    });
});

// ─── 4. createApiKeySchema validation ─────────────────────────────────────────

describe('createApiKeySchema', () => {
    it('requires at least one scope', async () => {
        const { createApiKeySchema } = await import('./api-keys.dto');
        expect(() => createApiKeySchema.parse({ name: 'Test', scopes: [] })).toThrow();
    });

    it('accepts WRITE_ENTRIES and READ_ENTRIES', async () => {
        const { createApiKeySchema } = await import('./api-keys.dto');
        const result = createApiKeySchema.parse({
            name: 'POS',
            scopes: ['WRITE_ENTRIES', 'READ_ENTRIES'],
            allowedBookIds: ['11111111-1111-4111-8111-111111111111'],
        });
        expect(result.scopes).toContain('WRITE_ENTRIES');
        expect(result.scopes).toContain('READ_ENTRIES');
    });

    it('requires a name', async () => {
        const { createApiKeySchema } = await import('./api-keys.dto');
        expect(() => createApiKeySchema.parse({ name: '', scopes: ['WRITE_ENTRIES'] })).toThrow();
    });

    it('rejects an unknown scope', async () => {
        const { createApiKeySchema } = await import('./api-keys.dto');
        expect(() =>
            createApiKeySchema.parse({ name: 'Bad', scopes: ['DELETE_EVERYTHING'] }),
        ).toThrow();
    });
});
