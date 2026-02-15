import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';

@injectable()
export class ContactsRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    async findByWorkspaceId(workspaceId: string) {
        return this.prisma.contact.findMany({ where: { workspaceId, isActive: true }, orderBy: { name: 'asc' } });
    }

    async findById(id: string) {
        return this.prisma.contact.findUnique({ where: { id } });
    }

    async create(data: { workspaceId: string; name: string; email?: string; phone?: string; company?: string; notes?: string }) {
        return this.prisma.contact.create({ data });
    }

    async update(id: string, data: { name?: string; email?: string; phone?: string; company?: string; notes?: string }) {
        return this.prisma.contact.update({ where: { id }, data });
    }

    async softDelete(id: string) {
        return this.prisma.contact.update({ where: { id }, data: { isActive: false } });
    }
}
