import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { CategoriesService } from './categories.service';
import { AuthenticatedRequest } from '../../core/types';

const categoriesService = new CategoriesService();

export class CategoriesController {
    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const categories = await categoriesService.getCategories(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Categories retrieved', data: categories });
        } catch (error) { next(error); }
    }

    async getOne(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const category = await categoriesService.getCategory(req.params.categoryId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Category retrieved', data: category });
        } catch (error) { next(error); }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const category = await categoriesService.createCategory(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Category created', data: category });
        } catch (error) { next(error); }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const category = await categoriesService.updateCategory(req.params.categoryId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Category updated', data: category });
        } catch (error) { next(error); }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await categoriesService.deleteCategory(req.params.categoryId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Category deleted' });
        } catch (error) { next(error); }
    }
}
