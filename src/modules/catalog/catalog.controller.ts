import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { CatalogService } from './catalog.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class CatalogController {
    constructor(private service: CatalogService) { }

    // ─── Tax ───────────────────────────────────────────

    async getTaxes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTaxes(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Taxes retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async getTax(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getTax(req.params.taxId as string, req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Tax retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async createTax(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createTax(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Tax created successfully', data });
        } catch (error) { next(error); }
    }

    async updateTax(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateTax(req.params.taxId as string, req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Tax updated successfully', data });
        } catch (error) { next(error); }
    }

    async deleteTax(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteTax(req.params.taxId as string, req.params.workspaceId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Tax deactivated successfully' });
        } catch (error) { next(error); }
    }

    // ─── Products & Services ───────────────────────────

    async getProductsServices(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.service.getProductsServices(req.params.workspaceId as string, req.query as any);
            res.status(StatusCodes.OK).json({ success: true, message: 'Products/services retrieved successfully', data: result.data, pagination: result.pagination });
        } catch (error) { next(error); }
    }

    async getProductService(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getProductService(req.params.itemId as string, req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Product/service retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async createProductService(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createProductService(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Product/service created successfully', data });
        } catch (error) { next(error); }
    }

    async updateProductService(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateProductService(req.params.itemId as string, req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Product/service updated successfully', data });
        } catch (error) { next(error); }
    }

    async deleteProductService(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteProductService(req.params.itemId as string, req.params.workspaceId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Product/service deactivated successfully' });
        } catch (error) { next(error); }
    }
}
