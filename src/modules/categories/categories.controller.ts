import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { CategoriesService } from './categories.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class CategoriesController {
    constructor(private categoriesService: CategoriesService) { }

    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const categories = await this.categoriesService.getCategories(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Categories retrieved', data: categories });
        } catch (error) { next(error); }
    }

    async getOne(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const category = await this.categoriesService.getCategory(req.params.categoryId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Category retrieved', data: category });
        } catch (error) { next(error); }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const category = await this.categoriesService.createCategory(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Category created', data: category });
        } catch (error) { next(error); }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const category = await this.categoriesService.updateCategory(req.params.categoryId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Category updated', data: category });
        } catch (error) { next(error); }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.categoriesService.deleteCategory(req.params.categoryId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Category deleted' });
        } catch (error) { next(error); }
    }
}
