import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { CategoriesRepository } from './categories.repository';
import { NotFoundError, ConflictError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { CreateCategoryDto, UpdateCategoryDto } from './categories.dto';

@injectable()
export class CategoriesService {
    constructor(
        private categoriesRepository: CategoriesRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    async getCategories(workspaceId: string) {
        return this.categoriesRepository.findByWorkspaceId(workspaceId);
    }

    async getCategory(categoryId: string) {
        const category = await this.categoriesRepository.findById(categoryId);
        if (!category || !category.isActive) throw new NotFoundError('Category');
        return category;
    }

    async createCategory(workspaceId: string, userId: string, dto: CreateCategoryDto) {
        const existing = await this.categoriesRepository.findByNameAndWorkspace(workspaceId, dto.name);
        if (existing && existing.isActive) throw new ConflictError('A category with this name already exists');

        const category = await this.categoriesRepository.create({ workspaceId, ...dto });

        await this.prisma.auditLog.create({
            data: {
                userId, workspaceId,
                action: AuditAction.CATEGORY_CREATED,
                resource: 'category', resourceId: category.id,
                details: { name: dto.name } as any,
            },
        });

        return category;
    }

    async updateCategory(categoryId: string, userId: string, dto: UpdateCategoryDto) {
        const category = await this.categoriesRepository.findById(categoryId);
        if (!category || !category.isActive) throw new NotFoundError('Category');

        if (dto.name) {
            const existing = await this.categoriesRepository.findByNameAndWorkspace(category.workspaceId, dto.name);
            if (existing && existing.id !== categoryId && existing.isActive) {
                throw new ConflictError('A category with this name already exists');
            }
        }

        const updated = await this.categoriesRepository.update(categoryId, dto);

        await this.prisma.auditLog.create({
            data: {
                userId, workspaceId: category.workspaceId,
                action: AuditAction.CATEGORY_UPDATED,
                resource: 'category', resourceId: categoryId,
                details: dto as any,
            },
        });

        return updated;
    }

    async deleteCategory(categoryId: string, userId: string) {
        const category = await this.categoriesRepository.findById(categoryId);
        if (!category || !category.isActive) throw new NotFoundError('Category');

        await this.categoriesRepository.softDelete(categoryId);

        await this.prisma.auditLog.create({
            data: {
                userId, workspaceId: category.workspaceId,
                action: AuditAction.CATEGORY_DELETED,
                resource: 'category', resourceId: categoryId,
            },
        });
    }
}
