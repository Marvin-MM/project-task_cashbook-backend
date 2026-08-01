import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class ChartOfAccountsController {
    constructor(private service: ChartOfAccountsService) { }

    // ─── Chart of accounts ────────────────────────────────

    async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.list(req.params.workspaceId as string, {
                includeArchived: req.query.includeArchived === 'true',
            });
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Chart of accounts retrieved',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.create(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'Ledger account created',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.update(
                req.params.id as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Ledger account updated',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async archive(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.archive(
                req.params.id as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Ledger account archived',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async mapCategory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.mapCategory(
                req.params.workspaceId as string,
                req.params.categoryId as string,
                req.body.ledgerAccountId ?? null,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: req.body.ledgerAccountId
                    ? 'Category mapped to ledger account'
                    : 'Category unmapped; it will use the default account',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    // ─── Journals ─────────────────────────────────────────

    async listJournals(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.service.listJournals(req.params.workspaceId as string, {
                page: Number(req.query.page) || 1,
                limit: Math.min(Number(req.query.limit) || 20, 100),
                sourceType: req.query.sourceType as string | undefined,
                from: req.query.from ? new Date(req.query.from as string) : undefined,
                to: req.query.to ? new Date(req.query.to as string) : undefined,
            });
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Journals retrieved',
                data: result.data,
                pagination: {
                    page: result.page,
                    limit: result.limit,
                    total: result.total,
                    totalPages: Math.ceil(result.total / result.limit),
                },
            });
        } catch (error) {
            next(error);
        }
    }

    async postManualJournal(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.postManualJournal(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'Journal posted',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async reverseJournal(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.reverseJournal(
                req.params.workspaceId as string,
                req.params.journalId as string,
                req.user.userId,
                req.body.reason,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Journal reversed',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    // ─── Fiscal periods ───────────────────────────────────

    async listPeriods(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.listPeriods(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Fiscal periods retrieved',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async closePeriod(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.closePeriod(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Period closed; no further postings will be accepted into it',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async reopenPeriod(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.reopenPeriod(
                req.params.workspaceId as string,
                req.params.periodId as string,
                req.user.userId,
                req.body.reason,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Period reopened',
                data,
            });
        } catch (error) {
            next(error);
        }
    }
}
