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

    /** Nested inventory snapshot for invoice/catalog UX (rent rates, mode). */
    private readonly inventoryInclude = {
        inventoryItem: {
            select: {
                id: true,
                name: true,
                sku: true,
                unit: true,
                currency: true,
                commercialMode: true,
                defaultSellingPrice: true,
                defaultRentalRate: true,
                defaultRentalPeriodUnit: true,
                isActive: true,
                stock: {
                    select: {
                        quantityOnHand: true,
                        quantityRentedOut: true,
                    },
                },
            },
        },
        tax: true,
    } as const;

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
        const AND: any[] = [];

        if (options.type) where.type = options.type;
        
        if (options.isActive !== undefined) {
            where.isActive = options.isActive;
            if (options.isActive === true) {
                AND.push({
                    OR: [
                        { inventoryItemId: null },
                        { inventoryItem: { isActive: true } }
                    ]
                });
            }
        }
        
        if (options.search) {
            AND.push({
                OR: [
                    { name: { contains: options.search, mode: 'insensitive' } },
                    { description: { contains: options.search, mode: 'insensitive' } },
                ]
            });
        }

        if (AND.length > 0) {
            where.AND = AND;
        }

        const [items, total] = await Promise.all([
            this.prisma.productService.findMany({
                where,
                skip: options.skip,
                take: options.take,
                orderBy: { name: 'asc' },
                include: this.inventoryInclude,
            }),
            this.prisma.productService.count({ where }),
        ]);
        return { items, total };
    }

    async findProductServiceById(id: string) {
        return this.prisma.productService.findUnique({
            where: { id },
            include: this.inventoryInclude,
        });
    }
}
