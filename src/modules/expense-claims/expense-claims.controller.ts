import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ExpenseClaimsService } from './expense-claims.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class ExpenseClaimsController {
    constructor(private service: ExpenseClaimsService) { }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createClaim(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'Claim filed. Attach the receipt before it can be approved.',
                data,
            });
        } catch (e) { next(e); }
    }

    async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.listClaims(
                req.params.workspaceId as string,
                req.user.userId,
                req.query as any,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Claims retrieved', data });
        } catch (e) { next(e); }
    }

    async get(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getClaim(
                req.params.claimId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Claim retrieved', data });
        } catch (e) { next(e); }
    }

    async review(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.reviewClaim(
                req.params.claimId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: req.body.approve ? 'Claim approved and recorded' : 'Claim declined',
                data,
            });
        } catch (e) { next(e); }
    }

    async withdraw(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.withdrawClaim(
                req.params.claimId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Claim withdrawn', data });
        } catch (e) { next(e); }
    }

    async attachReceipt(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.file) {
                res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    message: 'No file was uploaded',
                });
                return;
            }
            const data = await this.service.attachReceipt(
                req.params.claimId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.file,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Receipt attached', data });
        } catch (e) { next(e); }
    }

    async listReceipts(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.listReceipts(
                req.params.claimId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Receipts retrieved', data });
        } catch (e) { next(e); }
    }
}
