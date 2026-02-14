import { ContactsRepository } from './contacts.repository';
import { NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { CreateContactDto, UpdateContactDto } from './contacts.dto';
import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();
const contactsRepository = new ContactsRepository();

export class ContactsService {
    async getContacts(workspaceId: string) {
        return contactsRepository.findByWorkspaceId(workspaceId);
    }

    async getContact(contactId: string) {
        const contact = await contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        return contact;
    }

    async createContact(workspaceId: string, userId: string, dto: CreateContactDto) {
        const contact = await contactsRepository.create({ workspaceId, ...dto });
        await prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.CONTACT_CREATED, resource: 'contact', resourceId: contact.id, details: { name: dto.name } as any },
        });
        return contact;
    }

    async updateContact(contactId: string, userId: string, dto: UpdateContactDto) {
        const contact = await contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        const updated = await contactsRepository.update(contactId, dto);
        await prisma.auditLog.create({
            data: { userId, workspaceId: contact.workspaceId, action: AuditAction.CONTACT_UPDATED, resource: 'contact', resourceId: contactId, details: dto as any },
        });
        return updated;
    }

    async deleteContact(contactId: string, userId: string) {
        const contact = await contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        await contactsRepository.softDelete(contactId);
        await prisma.auditLog.create({
            data: { userId, workspaceId: contact.workspaceId, action: AuditAction.CONTACT_DELETED, resource: 'contact', resourceId: contactId },
        });
    }
}
