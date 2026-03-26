import { injectable, inject } from 'tsyringe';
import { PrismaClient, ContactType } from '@prisma/client';

@injectable()
export class ContactsRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    async findByWorkspaceId(workspaceId: string, type?: string) {
        const where: any = { workspaceId, isActive: true };
        if (type) where.type = type;
        return this.prisma.contact.findMany({
            where,
            orderBy: { name: 'asc' },
            include: { customerProfile: true },
        });
    }

    async findById(id: string) {
        return this.prisma.contact.findUnique({
            where: { id },
            include: { customerProfile: true },
        });
    }

    async create(data: {
        workspaceId: string;
        name: string;
        email?: string;
        phone?: string;
        company?: string;
        notes?: string;
        type?: ContactType;
    }) {
        return this.prisma.contact.create({
            data,
            include: { customerProfile: true },
        });
    }

    async update(id: string, data: {
        name?: string;
        email?: string;
        phone?: string;
        company?: string;
        notes?: string;
        type?: ContactType;
    }) {
        return this.prisma.contact.update({
            where: { id },
            data,
            include: { customerProfile: true },
        });
    }

    async softDelete(id: string) {
        return this.prisma.contact.update({ where: { id }, data: { isActive: false } });
    }

    // ─── Customer Profile ──────────────────────────────

    async findCustomerProfile(contactId: string) {
        return this.prisma.customerProfile.findUnique({ where: { contactId } });
    }

    async createCustomerProfile(contactId: string, data: {
        billingAddress?: any;
        shippingAddress?: any;
        currency?: string;
        accountNumber?: string;
        taxId?: string;
        notes?: string;
    }) {
        return this.prisma.customerProfile.create({
            data: { contactId, ...data },
        });
    }

    async updateCustomerProfile(contactId: string, data: {
        billingAddress?: any;
        shippingAddress?: any;
        currency?: string | null;
        accountNumber?: string | null;
        taxId?: string | null;
        notes?: string | null;
    }) {
        return this.prisma.customerProfile.update({
            where: { contactId },
            data,
        });
    }
}
