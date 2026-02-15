import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ContactsService } from './contacts.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class ContactsController {
    constructor(private contactsService: ContactsService) { }

    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const contacts = await this.contactsService.getContacts(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Contacts retrieved', data: contacts });
        } catch (error) { next(error); }
    }

    async getOne(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const contact = await this.contactsService.getContact(req.params.contactId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Contact retrieved', data: contact });
        } catch (error) { next(error); }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const contact = await this.contactsService.createContact(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Contact created', data: contact });
        } catch (error) { next(error); }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const contact = await this.contactsService.updateContact(req.params.contactId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Contact updated', data: contact });
        } catch (error) { next(error); }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.contactsService.deleteContact(req.params.contactId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Contact deleted' });
        } catch (error) { next(error); }
    }
}
