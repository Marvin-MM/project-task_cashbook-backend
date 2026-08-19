/**
 * API key authentication middleware for external integration routes.
 *
 * Reads the raw key from the `X-API-Key` header, validates it (SHA-256 hash
 * lookup, status check, expiry check, optional IP allowlist), and attaches
 * the resolved key context to the request for downstream handlers.
 *
 * This middleware intentionally does NOT use cookie-based JWT auth so that
 * external applications can call the integration surface with a simple header.
 */
import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import { ApiKeysService } from '../modules/api-keys/api-keys.service';
import { AuthenticationError, AuthorizationError } from '../core/errors/AppError';
import { getPrismaClient } from '../config/database';

export interface ApiKeyRequest extends Request {
    apiKey?: {
        id: string;
        workspaceId: string;
        createdById: string;
        scopes: string[];
        allowedBookIds: string[];
        allowedIps: string[];
    };
}

export function authenticateApiKey() {
    return async (req: ApiKeyRequest, _res: Response, next: NextFunction): Promise<void> => {
        try {
            const apiKeysService = container.resolve(ApiKeysService);
            const header = req.headers['x-api-key'];
            const rawKey = typeof header === 'string' ? header : undefined;

            if (!rawKey) {
                throw new AuthenticationError('X-API-Key header is required');
            }

            // Basic format check to fail fast without a DB round-trip on junk input
            if (!rawKey.startsWith('ick_live_') || rawKey.length < 40) {
                throw new AuthenticationError('Invalid API key format');
            }

            const key = await apiKeysService.resolveApiKey(rawKey);

            if (!key) {
                throw new AuthenticationError('Invalid, expired, or revoked API key');
            }

            // IP allowlist check (if configured on the key)
            if (key.allowedIps.length > 0) {
                // req.ip honours Express's configured trust-proxy policy. Do
                // not read X-Forwarded-For directly: clients can forge it.
                const clientIp = req.ip || req.socket.remoteAddress || '';
                if (!key.allowedIps.includes(clientIp)) {
                    throw new AuthorizationError(
                        `Request from IP ${clientIp} is not allowed for this API key`
                    );
                }
            }

            req.apiKey = key;
            next();
        } catch (error) {
            next(error);
        }
    };
}

/** Guard that the authenticated API key carries the required scope. */
export function requireApiKeyScope(scope: 'WRITE_ENTRIES' | 'READ_ENTRIES') {
    return (req: ApiKeyRequest, _res: Response, next: NextFunction): void => {
        if (!req.apiKey?.scopes.includes(scope)) {
            next(
                new AuthorizationError(
                    `This API key does not have the '${scope}' scope`
                )
            );
            return;
        }
        next();
    };
}

/**
 * Guard that the authenticated API key is allowed to operate on the
 * cashbook identified by `req.body.bookRef` or `req.params.bookRef`.
 *
 * API keys are least-privilege: every active key must name the books it can
 * access. An empty `allowedBookIds` list is treated as no book access.
 *
 * Attaches the resolved cashbook UUID to `req.resolvedCashbookId`.
 */
export function requireApiKeyBookAccess() {
    return async (
        req: ApiKeyRequest & { resolvedCashbookId?: string },
        _res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const bookRef: string | undefined =
                (req.body?.bookRef as string) ||
                (req.params?.bookRef as string) ||
                (req.query?.bookRef as string);

            if (!bookRef) {
                next(new AuthorizationError('bookRef is required'));
                return;
            }

            // Resolve bookRef → internal UUID
            const prisma = getPrismaClient();

            const cashbook = await prisma.cashbook.findFirst({
                where: {
                    bookRef,
                    workspaceId: req.apiKey!.workspaceId,
                    isActive: true,
                },
                select: { id: true },
            });

            if (!cashbook) {
                next(
                    new AuthorizationError(
                        `No active cashbook with bookRef '${bookRef}' found in this workspace`
                    )
                );
                return;
            }

            if (!req.apiKey!.allowedBookIds.includes(cashbook.id)) {
                next(
                    new AuthorizationError(
                        `This API key is not permitted to access cashbook '${bookRef}'`
                    )
                );
                return;
            }

            req.resolvedCashbookId = cashbook.id;
            next();
        } catch (error) {
            next(error);
        }
    };
}
