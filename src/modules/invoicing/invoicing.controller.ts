import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { InvoicingService } from './invoicing.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class InvoicingController {
    constructor(private service: InvoicingService) { }

    // ─── CRUD ──────────────────────────────────────────

    async createInvoice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createInvoice(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Invoice created successfully', data });
        } catch (error) { next(error); }
    }

    async updateInvoice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateInvoice(req.params.invoiceId as string, req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoice updated successfully', data });
        } catch (error) { next(error); }
    }

    async getInvoice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getInvoice(req.params.invoiceId as string, req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoice retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async listInvoices(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.service.listInvoices(req.params.workspaceId as string, req.query as any);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoices retrieved successfully', data: result.data, pagination: result.pagination });
        } catch (error) { next(error); }
    }

    async deleteInvoice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteInvoice(req.params.invoiceId as string, req.params.workspaceId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoice deleted successfully' });
        } catch (error) { next(error); }
    }

    // ─── Actions ───────────────────────────────────────

    async sendInvoice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.sendInvoice(req.params.invoiceId as string, req.params.workspaceId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoice sent successfully', data });
        } catch (error) { next(error); }
    }

    async voidInvoice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.voidInvoice(req.params.invoiceId as string, req.params.workspaceId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoice voided successfully', data });
        } catch (error) { next(error); }
    }

    // ─── Reporting ─────────────────────────────────────

    async getOverdueInvoices(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getOverdueInvoices(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Overdue invoices retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async getInvoiceSummary(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getInvoiceSummary(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoice summary retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async getCustomerOutstanding(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getCustomerOutstanding(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Customer outstanding balances retrieved successfully', data });
        } catch (error) { next(error); }
    }

    // ─── Settings ──────────────────────────────────────

    async getSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getSettings(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoice settings retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async updateSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateSettings(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Invoice settings updated successfully', data });
        } catch (error) { next(error); }
    }

    async uploadLogo(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const file = req.file;
            if (!file) {
                res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: 'No file uploaded' });
                return;
            }
            const data = await this.service.uploadLogo(req.params.workspaceId as string, req.user.userId, file);
            res.status(StatusCodes.OK).json({ success: true, message: 'Logo uploaded successfully', data });
        } catch (error) { next(error); }
    }
}
