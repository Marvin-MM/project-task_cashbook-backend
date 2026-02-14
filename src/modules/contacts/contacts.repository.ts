import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();

export class ContactsRepository {
    async findByWorkspaceId(workspaceId: string) {
        return prisma.contact.findMany({ where: { workspaceId, isActive: true }, orderBy: { name: 'asc' } });
    }

    async findById(id: string) {
        return prisma.contact.findUnique({ where: { id } });
    }

    async create(data: { workspaceId: string; name: string; email?: string; phone?: string; company?: string; notes?: string }) {
        return prisma.contact.create({ data });
    }

    async update(id: string, data: { name?: string; email?: string; phone?: string; company?: string; notes?: string }) {
        return prisma.contact.update({ where: { id }, data });
    }

    async softDelete(id: string) {
        return prisma.contact.update({ where: { id }, data: { isActive: false } });
    }
}
