import { Request, Response, NextFunction } from 'express';
import { injectable, inject } from 'tsyringe';
import { ApiKeysService } from './api-keys.service';

@injectable()
export class ApiKeysController {
    constructor(private apiKeysService: ApiKeysService) {}

    // GET /workspaces/:workspaceId/api-keys
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const workspaceId = String(req.params.workspaceId);
            const keys = await this.apiKeysService.listApiKeys(workspaceId);
            res.json({ success: true, data: keys });
        } catch (error) {
            next(error);
        }
    }

    // POST /workspaces/:workspaceId/api-keys
    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const workspaceId = String(req.params.workspaceId);
            const userId = (req as any).user.userId;
            const workspaceRole = (req as any).workspaceRole;
            const result = await this.apiKeysService.createApiKey(workspaceId, userId, workspaceRole, req.body);
            res.status(201).json({
                success: true,
                message: 'API key created. Store the rawKey securely — it will not be shown again.',
                data: result,
            });
        } catch (error) {
            next(error);
        }
    }

    // PATCH /workspaces/:workspaceId/api-keys/:keyId
    async update(req: Request, res: Response, next: NextFunction) {
        try {
            const workspaceId = String(req.params.workspaceId);
            const keyId = String(req.params.keyId);
            const userId = (req as any).user.userId;
            const workspaceRole = (req as any).workspaceRole;
            const result = await this.apiKeysService.updateApiKey(keyId, workspaceId, userId, workspaceRole, req.body);
            res.json({ success: true, data: result });
        } catch (error) {
            next(error);
        }
    }

    // POST /workspaces/:workspaceId/api-keys/:keyId/rotate
    async rotate(req: Request, res: Response, next: NextFunction) {
        try {
            const workspaceId = String(req.params.workspaceId);
            const keyId = String(req.params.keyId);
            const userId = (req as any).user.userId;
            const result = await this.apiKeysService.rotateApiKey(keyId, workspaceId, userId);
            res.json({
                success: true,
                message: 'API key rotated. Store the new rawKey — it will not be shown again.',
                data: result,
            });
        } catch (error) {
            next(error);
        }
    }

    // DELETE /workspaces/:workspaceId/api-keys/:keyId
    async revoke(req: Request, res: Response, next: NextFunction) {
        try {
            const workspaceId = String(req.params.workspaceId);
            const keyId = String(req.params.keyId);
            const userId = (req as any).user.userId;
            await this.apiKeysService.revokeApiKey(keyId, workspaceId, userId);
            res.json({ success: true, message: 'API key revoked' });
        } catch (error) {
            next(error);
        }
    }
}
