import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';

@injectable()
export class CatalogRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    // ─── Tax ───────────────────────────────────────────

    async findTaxesByWorkspace(workspaceId: string) {
        return this.prisma.tax.findMany({
            where: { workspaceId, isActive: true },
            orderBy: { name: 'asc' },
        });
    }

    async findTaxById(id: string) {
        return this.prisma.tax.findUnique({ where: { id } });
    }

    // ─── Product/Service ───────────────────────────────

    async findProductsServicesByWorkspace(
        workspaceId: string,
        options: {
            skip: number;
            take: number;
            type?: string;
            search?: string;
            isActive?: boolean;
        }
    ) {
        const where: any = { workspaceId };
        if (options.type) where.type = options.type;
        if (options.isActive !== undefined) where.isActive = options.isActive;
        if (options.search) {
            where.OR = [
                { name: { contains: options.search, mode: 'insensitive' } },
                { description: { contains: options.search, mode: 'insensitive' } },
            ];
        }

        const [items, total] = await Promise.all([
            this.prisma.productService.findMany({
                where,
                skip: options.skip,
                take: options.take,
                orderBy: { name: 'asc' },
                include: { tax: true },
            }),
            this.prisma.productService.count({ where }),
        ]);
        return { items, total };
    }

    async findProductServiceById(id: string) {
        return this.prisma.productService.findUnique({
            where: { id },
            include: { tax: true },
        });
    }
}
