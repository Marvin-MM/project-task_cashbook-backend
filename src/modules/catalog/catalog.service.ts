import { injectable, inject } from 'tsyringe';
import { PrismaClient, ProductServiceType } from '@prisma/client';
import { CatalogRepository } from './catalog.repository';
import { NotFoundError, AppError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import {
    CreateTaxDto,
    UpdateTaxDto,
    CreateProductServiceDto,
    UpdateProductServiceDto,
    CatalogQueryDto,
} from './catalog.dto';

@injectable()
export class CatalogService {
    constructor(
        private repository: CatalogRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    // ═══════════════════════════════════════════════════════
    // ─── Tax ───────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async getTaxes(workspaceId: string) {
        return this.repository.findTaxesByWorkspace(workspaceId);
    }

    async getTax(taxId: string, workspaceId: string) {
        const tax = await this.repository.findTaxById(taxId);
        if (!tax || tax.workspaceId !== workspaceId) throw new NotFoundError('Tax');
        return tax;
    }

    async createTax(workspaceId: string, userId: string, dto: CreateTaxDto) {
        const tax = await this.prisma.tax.create({
            data: {
                workspaceId,
                name: dto.name,
                rate: dto.rate,
                isCompound: dto.isCompound ?? false,
                isRecoverable: dto.isRecoverable ?? true,
            },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.TAX_CREATED, resource: 'tax', resourceId: tax.id, details: { name: dto.name, rate: dto.rate } as any },
        });

        return tax;
    }

    async updateTax(taxId: string, workspaceId: string, userId: string, dto: UpdateTaxDto) {
        const tax = await this.repository.findTaxById(taxId);
        if (!tax || tax.workspaceId !== workspaceId) throw new NotFoundError('Tax');

        const updated = await this.prisma.tax.update({
            where: { id: taxId },
            data: dto,
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.TAX_UPDATED, resource: 'tax', resourceId: taxId, details: dto as any },
        });

        return updated;
    }

    async deleteTax(taxId: string, workspaceId: string, userId: string) {
        const tax = await this.repository.findTaxById(taxId);
        if (!tax || tax.workspaceId !== workspaceId) throw new NotFoundError('Tax');

        await this.prisma.tax.update({
            where: { id: taxId },
            data: { isActive: false },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.TAX_DELETED, resource: 'tax', resourceId: taxId },
        });
    }

    // ═══════════════════════════════════════════════════════
    // ─── Products & Services ───────────────────────────────
    // ═══════════════════════════════════════════════════════

    async getProductsServices(workspaceId: string, query: CatalogQueryDto) {
        const page = Number(query.page) || 1;
        const limit = Number(query.limit) || 20;
        const skip = (page - 1) * limit;

        const { items, total } = await this.repository.findProductsServicesByWorkspace(workspaceId, {
            skip,
            take: limit,
            type: query.type,
            search: query.search,
            isActive: query.isActive !== undefined ? query.isActive === 'true' : undefined,
        });

        const totalPages = Math.ceil(total / limit);
        return {
            data: items,
            pagination: {
                page, limit, total, totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1,
            },
        };
    }

    async getProductService(id: string, workspaceId: string) {
        const item = await this.repository.findProductServiceById(id);
        if (!item || item.workspaceId !== workspaceId) throw new NotFoundError('Product/Service');
        return item;
    }

    async createProductService(workspaceId: string, userId: string, dto: CreateProductServiceDto) {
        // Validate taxId if provided
        if (dto.taxId) {
            const tax = await this.repository.findTaxById(dto.taxId);
            if (!tax || tax.workspaceId !== workspaceId || !tax.isActive) {
                throw new AppError('Invalid or inactive tax', 400, 'INVALID_TAX');
            }
        }

        // Validate inventoryItemId if provided (only meaningful for PRODUCT type)
        if (dto.inventoryItemId) {
            if (dto.type !== 'PRODUCT') {
                throw new AppError('inventoryItemId can only be set on PRODUCT type items', 400, 'INVALID_INVENTORY_LINK');
            }
            const invItem = await this.prisma.inventoryItem.findUnique({
                where: { id: dto.inventoryItemId },
                select: { id: true, workspaceId: true, isActive: true },
            });
            if (!invItem || invItem.workspaceId !== workspaceId || !invItem.isActive) {
                throw new AppError('Inventory item not found or inactive', 404, 'INVALID_INVENTORY_ITEM');
            }
        }

        // inventoryItemId is now in the Prisma client after db push + generate
        const item = await this.prisma.productService.create({
            data: {
                workspaceId,
                name: dto.name,
                description: dto.description || null,
                price: dto.price,
                type: dto.type as ProductServiceType,
                isSellable: dto.isSellable ?? true,
                isBuyable: dto.isBuyable ?? false,
                taxId: dto.taxId || null,
                inventoryItemId: dto.inventoryItemId || null,
            },
            include: { tax: true },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.PRODUCT_SERVICE_CREATED, resource: 'product_service', resourceId: item.id, details: { name: dto.name, type: dto.type, inventoryItemId: dto.inventoryItemId || null } as any },
        });

        return item;
    }

    async updateProductService(id: string, workspaceId: string, userId: string, dto: UpdateProductServiceDto) {
        const item = await this.repository.findProductServiceById(id);
        if (!item || item.workspaceId !== workspaceId) throw new NotFoundError('Product/Service');

        // Validate taxId if changing
        if (dto.taxId) {
            const tax = await this.repository.findTaxById(dto.taxId);
            if (!tax || tax.workspaceId !== workspaceId || !tax.isActive) {
                throw new AppError('Invalid or inactive tax', 400, 'INVALID_TAX');
            }
        }

        // Validate inventoryItemId if being set (only valid on PRODUCT type)
        const effectiveType = dto.type || (item as any).type;
        if (dto.inventoryItemId) {
            if (effectiveType !== 'PRODUCT') {
                throw new AppError('inventoryItemId can only be set on PRODUCT type items', 400, 'INVALID_INVENTORY_LINK');
            }
            const invItem = await this.prisma.inventoryItem.findUnique({
                where: { id: dto.inventoryItemId },
                select: { id: true, workspaceId: true, isActive: true },
            });
            if (!invItem || invItem.workspaceId !== workspaceId || !invItem.isActive) {
                throw new AppError('Inventory item not found or inactive', 404, 'INVALID_INVENTORY_ITEM');
            }
        }

        const updated = await this.prisma.productService.update({
            where: { id },
            data: {
                ...dto,
                type: dto.type ? (dto.type as ProductServiceType) : undefined,
                inventoryItemId: dto.inventoryItemId !== undefined ? (dto.inventoryItemId || null) : undefined,
            },
            include: { tax: true },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.PRODUCT_SERVICE_UPDATED, resource: 'product_service', resourceId: id, details: dto as any },
        });

        return updated;
    }

    async deleteProductService(id: string, workspaceId: string, userId: string) {
        const item = await this.repository.findProductServiceById(id);
        if (!item || item.workspaceId !== workspaceId) throw new NotFoundError('Product/Service');

        await this.prisma.productService.update({
            where: { id },
            data: { isActive: false },
        });

        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.PRODUCT_SERVICE_DELETED, resource: 'product_service', resourceId: id },
        });
    }
}
