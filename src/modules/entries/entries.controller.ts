import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { EntriesService } from './entries.service';
import { AuthenticatedRequest, ApiResponse, CashbookRole } from '../../core/types';

const entriesService = new EntriesService();

export class EntriesController {
    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await entriesService.getEntries(req.params.cashbookId as string, req.query as any);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Entries retrieved successfully',
                ...result,
            });
        } catch (error) {
            next(error);
        }
    }

    async getOne(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const entry = await entriesService.getEntry(req.params.entryId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Entry retrieved successfully',
                data: entry,
            });
        } catch (error) {
            next(error);
        }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const entry = await entriesService.createEntry(
                req.params.cashbookId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'Entry created successfully',
                data: entry,
            });
        } catch (error) {
            next(error);
        }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const entry = await entriesService.updateEntry(
                req.params.entryId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Entry updated successfully',
                data: entry,
            });
        } catch (error) {
            next(error);
        }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const cashbookRole = (req as any).cashbookRole as CashbookRole;
            const result = await entriesService.deleteEntry(
                req.params.entryId as string,
                req.user.userId,
                req.body.reason,
                cashbookRole
            );
            res.status(StatusCodes.OK).json({
                success: true,
                ...result,
            });
        } catch (error) {
            next(error);
        }
    }

    // ─── Delete Requests ───────────────────────────────
    async getDeleteRequests(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const status = req.query.status as string | undefined;
            const requests = await entriesService.getDeleteRequests(req.params.cashbookId as string, status);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Delete requests retrieved',
                data: requests,
            });
        } catch (error) {
            next(error);
        }
    }

    async reviewDeleteRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await entriesService.reviewDeleteRequest(
                req.params.requestId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.OK).json({
                success: true,
                ...result,
            });
        } catch (error) {
            next(error);
        }
    }

    // ─── Audit Trail ───────────────────────────────────
    async getAuditTrail(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const audits = await entriesService.getEntryAuditTrail(req.params.entryId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Entry audit trail retrieved',
                data: audits,
            });
        } catch (error) {
            next(error);
        }
    }
}
