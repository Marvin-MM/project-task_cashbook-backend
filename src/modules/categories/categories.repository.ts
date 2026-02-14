import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();

export class CategoriesRepository {
    async findByWorkspaceId(workspaceId: string) {
        return prisma.category.findMany({
            where: { workspaceId, isActive: true },
            orderBy: { name: 'asc' },
        });
    }

    async findById(id: string) {
        return prisma.category.findUnique({ where: { id } });
    }

    async findByNameAndWorkspace(workspaceId: string, name: string) {
        return prisma.category.findUnique({
            where: { workspaceId_name: { workspaceId, name } },
        });
    }

    async create(data: { workspaceId: string; name: string; description?: string; color?: string; icon?: string }) {
        return prisma.category.create({ data });
    }

    async update(id: string, data: { name?: string; description?: string; color?: string; icon?: string }) {
        return prisma.category.update({ where: { id }, data });
    }

    async softDelete(id: string) {
        return prisma.category.update({ where: { id }, data: { isActive: false } });
    }
}
