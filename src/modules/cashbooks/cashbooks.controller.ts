import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { CashbooksService } from './cashbooks.service';
import { AuthenticatedRequest, ApiResponse } from '../../core/types';

const cashbooksService = new CashbooksService();

export class CashbooksController {
    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const cashbooks = await cashbooksService.getCashbooks(
                req.params.workspaceId as string,
                req.user.userId
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Cashbooks retrieved successfully',
                data: cashbooks,
            });
        } catch (error) {
            next(error);
        }
    }

    async getOne(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const cashbook = await cashbooksService.getCashbook(req.params.cashbookId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Cashbook retrieved successfully',
                data: cashbook,
            });
        } catch (error) {
            next(error);
        }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const cashbook = await cashbooksService.createCashbook(
                req.params.workspaceId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'Cashbook created successfully',
                data: cashbook,
            });
        } catch (error) {
            next(error);
        }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const cashbook = await cashbooksService.updateCashbook(
                req.params.cashbookId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Cashbook updated successfully',
                data: cashbook,
            });
        } catch (error) {
            next(error);
        }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await cashbooksService.deleteCashbook(req.params.cashbookId as string, req.user.userId);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Cashbook deleted successfully',
            });
        } catch (error) {
            next(error);
        }
    }

    // ─── Members ───────────────────────────────────────
    async getMembers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const members = await cashbooksService.getCashbookMembers(req.params.cashbookId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Cashbook members retrieved',
                data: members,
            });
        } catch (error) {
            next(error);
        }
    }

    async addMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const member = await cashbooksService.addCashbookMember(
                req.params.cashbookId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'Member added to cashbook',
                data: member,
            });
        } catch (error) {
            next(error);
        }
    }

    async updateMemberRole(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const member = await cashbooksService.updateCashbookMemberRole(
                req.params.cashbookId as string,
                req.params.userId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Member role updated',
                data: member,
            });
        } catch (error) {
            next(error);
        }
    }

    async removeMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await cashbooksService.removeCashbookMember(
                req.params.cashbookId as string,
                req.params.userId as string,
                req.user.userId
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Member removed from cashbook',
            });
        } catch (error) {
            next(error);
        }
    }

    // ─── Financial Summary ─────────────────────────────
    async getSummary(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const summary = await cashbooksService.getFinancialSummary(req.params.cashbookId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Financial summary retrieved',
                data: summary,
            });
        } catch (error) {
            next(error);
        }
    }
}
