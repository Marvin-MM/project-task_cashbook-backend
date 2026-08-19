import { Request, Response, NextFunction } from 'express';
import { injectable, inject } from 'tsyringe';
import { IntegrationService } from './integration.service';

type ApiKeyReq = Request & {
    apiKey?: { id: string; workspaceId: string; createdById: string; scopes: string[]; allowedBookIds: string[] };
    resolvedCashbookId?: string;
};

@injectable()
export class IntegrationController {
    constructor(private integrationService: IntegrationService) {}

    // POST /integrate/entries
    async submitEntry(req: ApiKeyReq, res: Response, next: NextFunction) {
        try {
            const cashbookId = req.resolvedCashbookId!;
            const workspaceId = req.apiKey!.workspaceId;
            const result = await this.integrationService.submitEntry(
                cashbookId, workspaceId, req.apiKey!.id, req.apiKey!.createdById, req.body,
            );
            const status = result.idempotent ? 200 : 201;
            res.status(status).json({
                success: true,
                message: result.idempotent
                    ? 'Entry already exists (idempotent)'
                    : 'Entry recorded successfully',
                data: result.entry,
            });
        } catch (error) {
            next(error);
        }
    }

    // POST /integrate/entries/batch
    async submitBatch(req: ApiKeyReq, res: Response, next: NextFunction) {
        try {
            const cashbookId = req.resolvedCashbookId!;
            const workspaceId = req.apiKey!.workspaceId;
            const results = await this.integrationService.submitBatch(
                cashbookId, workspaceId, req.apiKey!.id, req.apiKey!.createdById, req.body,
            );
            const successCount = results.filter((r) => r.status === 'ok').length;
            res.json({
                success: true,
                message: `${successCount}/${results.length} entries recorded`,
                data: results,
            });
        } catch (error) {
            next(error);
        }
    }

    // GET /integrate/book/:bookRef
    async getBookSummary(req: ApiKeyReq, res: Response, next: NextFunction) {
        try {
            const cashbookId = req.resolvedCashbookId!;
            const data = await this.integrationService.getBookSummary(cashbookId);
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }
}
