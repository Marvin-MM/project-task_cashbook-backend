import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';

@injectable()
export class PaymentModesRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    async findByWorkspaceId(workspaceId: string) {
        return this.prisma.paymentMode.findMany({ where: { workspaceId, isActive: true }, orderBy: { name: 'asc' } });
    }

    async findById(id: string) {
        return this.prisma.paymentMode.findUnique({ where: { id } });
    }

    async findByNameAndWorkspace(workspaceId: string, name: string) {
        return this.prisma.paymentMode.findUnique({
            where: { workspaceId_name: { workspaceId, name } },
        });
    }

    async create(data: { workspaceId: string; name: string }) {
        return this.prisma.paymentMode.create({ data });
    }

    async update(id: string, data: { name?: string }) {
        return this.prisma.paymentMode.update({ where: { id }, data });
    }

    async softDelete(id: string) {
        return this.prisma.paymentMode.update({ where: { id }, data: { isActive: false } });
    }
}
