import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';

@injectable()
export class CategoriesRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    async findByWorkspaceId(workspaceId: string) {
        return this.prisma.category.findMany({
            where: { workspaceId, isActive: true },
            orderBy: { name: 'asc' },
        });
    }

    async findById(id: string) {
        return this.prisma.category.findUnique({ where: { id } });
    }

    async findByNameAndWorkspace(workspaceId: string, name: string) {
        return this.prisma.category.findUnique({
            where: { workspaceId_name: { workspaceId, name } },
        });
    }

    async create(data: { workspaceId: string; name: string; description?: string; color?: string; icon?: string }) {
        return this.prisma.category.create({ data });
    }

    async update(id: string, data: { name?: string; description?: string; color?: string; icon?: string }) {
        return this.prisma.category.update({ where: { id }, data });
    }

    async softDelete(id: string) {
        return this.prisma.category.update({ where: { id }, data: { isActive: false } });
    }
}
