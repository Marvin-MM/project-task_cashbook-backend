import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { PaymentModesService } from './payment-modes.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class PaymentModesController {
    constructor(private paymentModesService: PaymentModesService) { }

    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const modes = await this.paymentModesService.getPaymentModes(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Payment modes retrieved', data: modes });
        } catch (error) { next(error); }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const mode = await this.paymentModesService.createPaymentMode(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Payment mode created', data: mode });
        } catch (error) { next(error); }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const mode = await this.paymentModesService.updatePaymentMode(req.params.paymentModeId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Payment mode updated', data: mode });
        } catch (error) { next(error); }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.paymentModesService.deletePaymentMode(req.params.paymentModeId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Payment mode deleted' });
        } catch (error) { next(error); }
    }
}
