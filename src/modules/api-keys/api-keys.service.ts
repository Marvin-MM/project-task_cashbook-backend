import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { CreateApiKeyDto, UpdateApiKeyDto } from './api-keys.dto';
import { NotFoundError, AuthorizationError, AppError } from '../../core/errors/AppError';
import { AuditAction, WorkspaceRole, WorkspaceType } from '../../core/types';
import { WorkspacePermission, hasWorkspacePermission } from '../../core/types/workspace-permissions';

// ─── Key Helpers ───────────────────────────────────────

/**
 * Generate a cryptographically secure API key.
 * Format: ick_live_<32 random bytes as base64url>
 * The prefix "ick" = InChange Key, "live" distinguishes prod from test.
 */
function generateRawKey(): string {
    const bytes = crypto.randomBytes(32);
    const b64 = bytes.toString('base64url');
    return `ick_live_${b64}`;
}

/** SHA-256 the raw key and hex-encode for storage. */
function hashKey(rawKey: string): string {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/** Take the first 12 chars of the raw key as a display prefix. */
function keyPrefix(rawKey: string): string {
    return rawKey.substring(0, 12);
}

// ─── Service ───────────────────────────────────────────

@injectable()
export class ApiKeysService {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
    ) {}

    // ─── List keys ────────────────────────────────────
    async listApiKeys(workspaceId: string) {
        return this.prisma.apiKey.findMany({
            where: { workspaceId },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                status: true,
                allowedBookIds: true,
                allowedIps: true,
                lastUsedAt: true,
                expiresAt: true,
                createdAt: true,
                createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                revokedAt: true,
                revokedBy: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    // ─── Create key ───────────────────────────────────
    /**
     * Returns the raw key ONCE. We do not store it — only its SHA-256 hash.
     * The caller must display it to the user immediately; it cannot be recovered.
     */
    async createApiKey(workspaceId: string, userId: string, workspaceRole: WorkspaceRole, dto: CreateApiKeyDto) {
        if (!dto.allowedBookIds?.length) {
            throw new AppError('Select at least one cashbook', 400, 'BOOK_ACCESS_REQUIRED');
        }

        // Validate that all allowedBookIds belong to this workspace
        const books = await this.prisma.cashbook.findMany({
            where: { workspaceId, id: { in: dto.allowedBookIds }, isActive: true },
            select: { id: true },
        });
        if (books.length !== dto.allowedBookIds.length) {
            throw new AppError(
                'One or more book IDs do not belong to this workspace or are inactive',
                400,
                'INVALID_BOOK_IDS'
            );
        }
        await this.assertActorCanAccessBooks(userId, workspaceRole, dto.allowedBookIds);

        const rawKey = generateRawKey();
        const keyHash = hashKey(rawKey);
        const prefix = keyPrefix(rawKey);

        // Explicitly selected books become integration-enabled as part of key
        // setup. This preserves the opt-in model for old and new cashbooks.
        await this.activateBooks(workspaceId, userId, dto.allowedBookIds);

        const apiKey = await this.prisma.apiKey.create({
            data: {
                workspaceId,
                name: dto.name,
                keyHash,
                keyPrefix: prefix,
                scopes: dto.scopes as any,
                allowedBookIds: dto.allowedBookIds,
                allowedIps: dto.allowedIps ?? [],
                expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
                createdById: userId,
            },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                status: true,
                allowedBookIds: true,
                allowedIps: true,
                expiresAt: true,
                createdAt: true,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.API_KEY_CREATED,
                resource: 'api_key',
                resourceId: apiKey.id,
                details: { name: dto.name, scopes: dto.scopes } as any,
            },
        });

        // Return raw key ONCE — this is the only time it will be available
        return { ...apiKey, rawKey };
    }

    // ─── Rotate key ───────────────────────────────────
    /**
     * Replace the current key hash with a new one. All other metadata is preserved.
     * Old key is immediately invalidated; the new raw key is returned once.
     */
    async rotateApiKey(apiKeyId: string, workspaceId: string, userId: string) {
        const key = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId } });

        if (!key || key.workspaceId !== workspaceId) {
            throw new NotFoundError('API key');
        }
        if (key.status === 'REVOKED') {
            throw new AppError('Cannot rotate a revoked API key', 400, 'API_KEY_REVOKED');
        }

        const rawKey = generateRawKey();
        const keyHash = hashKey(rawKey);
        const prefix = keyPrefix(rawKey);

        const updated = await this.prisma.apiKey.update({
            where: { id: apiKeyId },
            data: {
                keyHash,
                keyPrefix: prefix,
                lastUsedAt: null,
                updatedAt: new Date(),
            },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                status: true,
                allowedBookIds: true,
                allowedIps: true,
                expiresAt: true,
                createdAt: true,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.API_KEY_ROTATED,
                resource: 'api_key',
                resourceId: apiKeyId,
                details: { name: key.name } as any,
            },
        });

        return { ...updated, rawKey };
    }

    // ─── Revoke key ───────────────────────────────────
    async revokeApiKey(apiKeyId: string, workspaceId: string, userId: string) {
        const key = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId } });

        if (!key || key.workspaceId !== workspaceId) {
            throw new NotFoundError('API key');
        }
        if (key.status === 'REVOKED') {
            throw new AppError('API key is already revoked', 400, 'API_KEY_ALREADY_REVOKED');
        }

        await this.prisma.apiKey.update({
            where: { id: apiKeyId },
            data: {
                status: 'REVOKED',
                revokedAt: new Date(),
                revokedById: userId,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.API_KEY_REVOKED,
                resource: 'api_key',
                resourceId: apiKeyId,
                details: { name: key.name } as any,
            },
        });
    }

    // ─── Update key metadata ──────────────────────────
    async updateApiKey(
        apiKeyId: string,
        workspaceId: string,
        userId: string,
        workspaceRole: WorkspaceRole,
        dto: UpdateApiKeyDto,
    ) {
        const key = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId } });

        if (!key || key.workspaceId !== workspaceId) {
            throw new NotFoundError('API key');
        }
        if (key.status === 'REVOKED') {
            throw new AppError('Cannot update a revoked API key', 400, 'API_KEY_REVOKED');
        }

        if (dto.allowedBookIds) {
            if (!dto.allowedBookIds.length) {
                throw new AppError('Select at least one cashbook', 400, 'BOOK_ACCESS_REQUIRED');
            }
            const books = await this.prisma.cashbook.findMany({
                where: { workspaceId, id: { in: dto.allowedBookIds }, isActive: true },
                select: { id: true },
            });
            if (books.length !== dto.allowedBookIds.length) {
                throw new AppError(
                    'One or more book IDs do not belong to this workspace',
                    400,
                    'INVALID_BOOK_IDS'
                );
            }
        }

        if (dto.allowedBookIds) {
            await this.assertActorCanAccessBooks(userId, workspaceRole, dto.allowedBookIds);
            await this.activateBooks(workspaceId, userId, dto.allowedBookIds);
        }

        const updated = await this.prisma.apiKey.update({
            where: { id: apiKeyId },
            data: {
                ...(dto.name && { name: dto.name }),
                ...(dto.allowedBookIds !== undefined && { allowedBookIds: dto.allowedBookIds }),
                ...(dto.allowedIps !== undefined && { allowedIps: dto.allowedIps }),
                ...(dto.expiresAt !== undefined && {
                    expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
                }),
            },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                status: true,
                allowedBookIds: true,
                allowedIps: true,
                expiresAt: true,
                createdAt: true,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.API_KEY_UPDATED,
                resource: 'api_key',
                resourceId: apiKeyId,
                details: {
                    nameChanged: dto.name !== undefined,
                    allowedBookIdsChanged: dto.allowedBookIds !== undefined,
                    allowedIpsChanged: dto.allowedIps !== undefined,
                    expiresAtChanged: dto.expiresAt !== undefined,
                } as any,
            },
        });

        return updated;
    }

    // ─── Resolve key for integration middleware ────────
    /**
     * Validate a raw API key presented in a request header.
     * Updates lastUsedAt on success. Returns the full ApiKey row (without hash).
     * Returns null if the key is not found, revoked, or expired.
     */
    async resolveApiKey(rawKey: string): Promise<{
        id: string;
        workspaceId: string;
        createdById: string;
        scopes: string[];
        allowedBookIds: string[];
        allowedIps: string[];
        status: string;
    } | null> {
        const hash = hashKey(rawKey);

        const key = await this.prisma.apiKey.findUnique({
            where: { keyHash: hash },
            select: {
                id: true,
                workspaceId: true,
                createdById: true,
                scopes: true,
                allowedBookIds: true,
                allowedIps: true,
                status: true,
                expiresAt: true,
                workspace: { select: { type: true } },
            },
        });

        if (!key) return null;
        if (key.workspace.type !== WorkspaceType.BUSINESS) return null;
        if (key.status !== 'ACTIVE') return null;
        if (key.expiresAt && key.expiresAt < new Date()) return null;

        // Touch lastUsedAt (fire-and-forget to keep the request fast)
        this.prisma.apiKey
            .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
            .catch(() => {/* non-fatal */});

        const { workspace: _workspace, ...safeKey } = key;
        return safeKey;
    }

    private async assertActorCanAccessBooks(
        userId: string,
        workspaceRole: WorkspaceRole,
        bookIds: string[],
    ) {
        const uniqueBookIds = [...new Set(bookIds)];
        if (uniqueBookIds.length !== bookIds.length) {
            throw new AppError('Duplicate book IDs are not allowed', 400, 'DUPLICATE_BOOK_IDS');
        }

        if (hasWorkspacePermission(workspaceRole, WorkspacePermission.ACCESS_ALL_CASHBOOKS)) {
            return;
        }

        const memberships = await this.prisma.cashbookMember.findMany({
            where: { userId, cashbookId: { in: uniqueBookIds } },
            select: { cashbookId: true },
        });
        const accessible = new Set(memberships.map((member) => member.cashbookId));
        if (uniqueBookIds.some((cashbookId) => !accessible.has(cashbookId))) {
            throw new AuthorizationError('You can only create API keys for books you have been assigned to');
        }
    }

    /** Activate only the books deliberately selected for an API key. */
    private async activateBooks(workspaceId: string, userId: string, bookIds: string[]) {
        for (const cashbookId of bookIds) {
            const existing = await this.prisma.cashbook.findFirst({
                where: { id: cashbookId, workspaceId, isActive: true },
                select: { bookRef: true },
            });
            if (!existing) {
                throw new AppError('One or more book IDs do not belong to this workspace or are inactive', 400, 'INVALID_BOOK_IDS');
            }
            if (existing.bookRef) continue;

            let activated = false;
            for (let attempt = 0; attempt < 5 && !activated; attempt++) {
                const bookRef = `CB-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
                try {
                    const result = await this.prisma.cashbook.updateMany({
                        where: { id: cashbookId, workspaceId, isActive: true, bookRef: null },
                        data: { bookRef },
                    });
                    activated = result.count === 1;
                } catch (error: any) {
                    if (error?.code !== 'P2002') throw error;
                }
            }

            const activatedBook = await this.prisma.cashbook.findUnique({
                where: { id: cashbookId },
                select: { bookRef: true },
            });
            if (!activatedBook?.bookRef) {
                throw new AppError('Could not allocate an integration reference. Please retry.', 503, 'BOOK_REF_ALLOCATION_FAILED');
            }
            if (activated) {
                await this.prisma.auditLog.create({
                    data: {
                        userId,
                        workspaceId,
                        action: AuditAction.CASHBOOK_INTEGRATION_ACTIVATED,
                        resource: 'cashbook',
                        resourceId: cashbookId,
                        details: { bookRef: activatedBook.bookRef, source: 'api_key_book_selection' } as any,
                    },
                });
            }
        }
    }
}
