import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();

export class PaymentModesRepository {
    async findByWorkspaceId(workspaceId: string) {
        return prisma.paymentMode.findMany({ where: { workspaceId, isActive: true }, orderBy: { name: 'asc' } });
    }

    async findById(id: string) {
        return prisma.paymentMode.findUnique({ where: { id } });
    }

    async findByNameAndWorkspace(workspaceId: string, name: string) {
        return prisma.paymentMode.findUnique({
            where: { workspaceId_name: { workspaceId, name } },
        });
    }

    async create(data: { workspaceId: string; name: string }) {
        return prisma.paymentMode.create({ data });
    }

    async update(id: string, data: { name?: string }) {
        return prisma.paymentMode.update({ where: { id }, data });
    }

    async softDelete(id: string) {
        return prisma.paymentMode.update({ where: { id }, data: { isActive: false } });
    }
}
