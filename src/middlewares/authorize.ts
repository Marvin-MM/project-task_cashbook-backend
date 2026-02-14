import { Response, NextFunction } from 'express';
import { getPrismaClient } from '../config/database';
import {
    AuthorizationError,
    NotFoundError,
} from '../core/errors/AppError';
import {
    AuthenticatedRequest,
    AuditAction,
    WorkspaceRole,
    CashbookRole,
    WorkspaceType,
} from '../core/types';
import { CashbookPermission, hasPermission } from '../core/types/permissions';
import { logger } from '../utils/logger';

const prisma = getPrismaClient();

// ─── Log Permission Failures ───────────────────────────
async function logPermissionDenied(
    userId: string,
    action: string,
    resource: string,
    resourceId?: string,
    details?: Record<string, any>
): Promise<void> {
    try {
        await prisma.auditLog.create({
            data: {
                userId,
                action: AuditAction.PERMISSION_DENIED,
                resource,
                resourceId,
                details: {
                    attemptedAction: action,
                    ...details,
                } as any,
            },
        });
    } catch (error) {
        logger.error('Failed to log permission denial', { error });
    }
}

// ─── Super Admin Guard ─────────────────────────────────
export function requireSuperAdmin() {
    return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
        try {
            if (!req.user?.isSuperAdmin) {
                await logPermissionDenied(req.user?.userId, 'SUPER_ADMIN_ACCESS', 'system');
                throw new AuthorizationError('Super admin access required');
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}

// ─── Workspace Membership Guard ────────────────────────
export function requireWorkspaceMember(allowedRoles?: WorkspaceRole[]) {
    return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
        try {
            const workspaceId = req.params.workspaceId as string;
            const userId = req.user.userId;

            if (!workspaceId) {
                throw new AuthorizationError('Workspace ID is required');
            }

            // Check if workspace exists
            const workspace = await prisma.workspace.findUnique({
                where: { id: workspaceId },
            });

            if (!workspace || !workspace.isActive) {
                throw new NotFoundError('Workspace');
            }

            // Personal workspace: owner-only bypass
            if (workspace.type === WorkspaceType.PERSONAL) {
                if (workspace.ownerId !== userId) {
                    await logPermissionDenied(userId, 'WORKSPACE_ACCESS', 'workspace', workspaceId);
                    throw new AuthorizationError('Access denied to this workspace');
                }
                (req as any).workspace = workspace;
                (req as any).workspaceRole = WorkspaceRole.OWNER;
                next();
                return;
            }

            // Business workspace: check membership
            const membership = await prisma.workspaceMember.findUnique({
                where: {
                    workspaceId_userId: { workspaceId, userId },
                },
            });

            // Also allow workspace owner
            if (!membership && workspace.ownerId !== userId) {
                await logPermissionDenied(userId, 'WORKSPACE_ACCESS', 'workspace', workspaceId);
                throw new AuthorizationError('You are not a member of this workspace');
            }

            const userRole = workspace.ownerId === userId
                ? WorkspaceRole.OWNER
                : (membership!.role as WorkspaceRole);

            if (allowedRoles && !allowedRoles.includes(userRole)) {
                await logPermissionDenied(userId, 'WORKSPACE_ROLE_CHECK', 'workspace', workspaceId, {
                    requiredRoles: allowedRoles,
                    userRole,
                });
                throw new AuthorizationError('Insufficient workspace role');
            }

            (req as any).workspace = workspace;
            (req as any).workspaceRole = userRole;
            next();
        } catch (error) {
            next(error);
        }
    };
}

// ─── Cashbook Membership Guard ─────────────────────────
export function requireCashbookMember(requiredPermission?: CashbookPermission) {
    return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
        try {
            const cashbookId = req.params.cashbookId as string;
            const userId = req.user.userId;

            if (!cashbookId) {
                throw new AuthorizationError('Cashbook ID is required');
            }

            const cashbook = await prisma.cashbook.findUnique({
                where: { id: cashbookId },
            });

            if (!cashbook || !cashbook.isActive) {
                throw new NotFoundError('Cashbook');
            }

            // Look up the workspace separately to check type
            const workspace = await prisma.workspace.findUnique({
                where: { id: cashbook.workspaceId },
            });

            // Personal workspace: owner bypass
            if (workspace && workspace.type === WorkspaceType.PERSONAL) {
                if (workspace.ownerId !== userId) {
                    await logPermissionDenied(userId, 'CASHBOOK_ACCESS', 'cashbook', cashbookId);
                    throw new AuthorizationError('Access denied to this cashbook');
                }
                (req as any).cashbook = cashbook;
                (req as any).cashbookRole = CashbookRole.PRIMARY_ADMIN;
                next();
                return;
            }

            // Business workspace: check cashbook membership
            const cbMembership = await prisma.cashbookMember.findUnique({
                where: {
                    cashbookId_userId: { cashbookId, userId },
                },
            });

            if (!cbMembership) {
                await logPermissionDenied(userId, 'CASHBOOK_ACCESS', 'cashbook', cashbookId);
                throw new AuthorizationError('You do not have access to this cashbook');
            }

            const userRole = cbMembership.role as CashbookRole;

            if (requiredPermission && !hasPermission(userRole, requiredPermission)) {
                await logPermissionDenied(userId, requiredPermission, 'cashbook', cashbookId, {
                    userRole,
                });
                throw new AuthorizationError(
                    `You do not have the '${requiredPermission}' permission for this cashbook`
                );
            }

            (req as any).cashbook = cashbook;
            (req as any).cashbookRole = userRole;
            (req as any).workspaceId = cashbook.workspaceId;
            next();
        } catch (error) {
            next(error);
        }
    };
}
