import { injectable, inject } from 'tsyringe';
import { PrismaClient, ContactType } from '@prisma/client';
import { ContactsRepository } from './contacts.repository';
import { AppError, NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import {
    CreateContactDto,
    UpdateContactDto,
    ContactQueryDto,
    CreateCustomerProfileDto,
    UpdateCustomerProfileDto,
} from './contacts.dto';

@injectable()
export class ContactsService {
    constructor(
        private contactsRepository: ContactsRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    async getContacts(workspaceId: string, query?: ContactQueryDto) {
        return this.contactsRepository.findByWorkspaceId(workspaceId, query?.type);
    }

    async getContact(contactId: string) {
        const contact = await this.contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        return contact;
    }

    async createContact(workspaceId: string, userId: string, dto: CreateContactDto) {
        const contact = await this.contactsRepository.create({
            workspaceId,
            ...dto,
            type: (dto.type as ContactType) || ContactType.PERSONAL,
        });
        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.CONTACT_CREATED, resource: 'contact', resourceId: contact.id, details: { name: dto.name, type: dto.type } as any },
        });
        return contact;
    }

    async updateContact(contactId: string, userId: string, dto: UpdateContactDto) {
        const contact = await this.contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        const updated = await this.contactsRepository.update(contactId, {
            ...dto,
            type: dto.type ? (dto.type as ContactType) : undefined,
        });
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

    // ─── Customer Profile ──────────────────────────────

    async createCustomerProfile(contactId: string, userId: string, dto: CreateCustomerProfileDto) {
        const contact = await this.contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');

        // Auto-promote contact to CUSTOMER type if not already
        if (contact.type !== ContactType.CUSTOMER) {
            await this.contactsRepository.update(contactId, { type: ContactType.CUSTOMER });
        }

        // Check if profile already exists
        const existing = await this.contactsRepository.findCustomerProfile(contactId);
        if (existing) {
            throw new AppError('Customer profile already exists for this contact', 409, 'PROFILE_EXISTS');
        }

        const profile = await this.contactsRepository.createCustomerProfile(contactId, dto);
        await this.prisma.auditLog.create({
            data: { userId, workspaceId: contact.workspaceId, action: AuditAction.CUSTOMER_PROFILE_CREATED, resource: 'customer_profile', resourceId: profile.id },
        });
        return profile;
    }

    async updateCustomerProfile(contactId: string, userId: string, dto: UpdateCustomerProfileDto) {
        const contact = await this.contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');

        const existing = await this.contactsRepository.findCustomerProfile(contactId);
        if (!existing) {
            throw new NotFoundError('Customer Profile');
        }

        const updated = await this.contactsRepository.updateCustomerProfile(contactId, dto);
        await this.prisma.auditLog.create({
            data: { userId, workspaceId: contact.workspaceId, action: AuditAction.CUSTOMER_PROFILE_UPDATED, resource: 'customer_profile', resourceId: updated.id },
        });
        return updated;
    }

    async getCustomerProfile(contactId: string) {
        const contact = await this.contactsRepository.findById(contactId);
        if (!contact || !contact.isActive) throw new NotFoundError('Contact');
        return contact.customerProfile || null;
    }
}
