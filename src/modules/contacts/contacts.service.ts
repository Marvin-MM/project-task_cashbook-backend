import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { ContactsRepository } from './contacts.repository';
import { NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { CreateContactDto, UpdateContactDto } from './contacts.dto';

@injectable()
export class ContactsService {
    constructor(
        private contactsRepository: ContactsRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    async getContacts(workspaceId: string) {
        return this.contactsRepository.findByWorkspaceId(workspaceId);
    }

    async getContact(contactId: string) {
        const contact = await this.contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        return contact;
    }

    async createContact(workspaceId: string, userId: string, dto: CreateContactDto) {
        const contact = await this.contactsRepository.create({ workspaceId, ...dto });
        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.CONTACT_CREATED, resource: 'contact', resourceId: contact.id, details: { name: dto.name } as any },
        });
        return contact;
    }

    async updateContact(contactId: string, userId: string, dto: UpdateContactDto) {
        const contact = await this.contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        const updated = await this.contactsRepository.update(contactId, dto);
        await this.prisma.auditLog.create({
            data: { userId, workspaceId: contact.workspaceId, action: AuditAction.CONTACT_UPDATED, resource: 'contact', resourceId: contactId, details: dto as any },
        });
        return updated;
    }

    async deleteContact(contactId: string, userId: string) {
        const contact = await this.contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        await this.contactsRepository.softDelete(contactId);
        await this.prisma.auditLog.create({
            data: { userId, workspaceId: contact.workspaceId, action: AuditAction.CONTACT_DELETED, resource: 'contact', resourceId: contactId },
        });
    }
}
