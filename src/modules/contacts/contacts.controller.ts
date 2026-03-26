import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ContactsService } from './contacts.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class ContactsController {
    constructor(private service: ContactsService) { }

    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getContacts(req.params.workspaceId as string, req.query as any);
            res.status(StatusCodes.OK).json({ success: true, message: 'Contacts retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async getOne(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getContact(req.params.contactId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Contact retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createContact(req.params.workspaceId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Contact created successfully', data });
        } catch (error) { next(error); }
    }

    async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateContact(req.params.contactId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Contact updated successfully', data });
        } catch (error) { next(error); }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteContact(req.params.contactId as string, req.user.userId);
            res.status(StatusCodes.OK).json({ success: true, message: 'Contact deleted successfully' });
        } catch (error) { next(error); }
    }

    // ─── Customer Profile ──────────────────────────────

    async getCustomerProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getCustomerProfile(req.params.contactId as string);
            res.status(StatusCodes.OK).json({ success: true, message: 'Customer profile retrieved successfully', data });
        } catch (error) { next(error); }
    }

    async createCustomerProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createCustomerProfile(req.params.contactId as string, req.user.userId, req.body);
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Customer profile created successfully', data });
        } catch (error) { next(error); }
    }

    async updateCustomerProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateCustomerProfile(req.params.contactId as string, req.user.userId, req.body);
            res.status(StatusCodes.OK).json({ success: true, message: 'Customer profile updated successfully', data });
        } catch (error) { next(error); }
    }
}
