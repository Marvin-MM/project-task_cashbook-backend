import { Router } from 'express';
import { container } from 'tsyringe';
import { ContactsController } from './contacts.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import {
    createContactSchema,
    updateContactSchema,
    contactQuerySchema,
    createCustomerProfileSchema,
    updateCustomerProfileSchema,
} from './contacts.dto';

const router = Router({ mergeParams: true });
const contactsController = container.resolve(ContactsController);

router.use(authenticate as any);

// ─── Contacts CRUD ─────────────────────────────────────

router.get('/:workspaceId', requireWorkspaceMember() as any, validate(contactQuerySchema, 'query'), contactsController.getAll.bind(contactsController) as any);
router.get('/:workspaceId/:contactId', requireWorkspaceMember() as any, contactsController.getOne.bind(contactsController) as any);
router.post('/:workspaceId', requireWorkspaceMember() as any, validate(createContactSchema), contactsController.create.bind(contactsController) as any);
router.patch('/:workspaceId/:contactId', requireWorkspaceMember() as any, validate(updateContactSchema), contactsController.update.bind(contactsController) as any);
router.delete('/:workspaceId/:contactId', requireWorkspaceMember() as any, contactsController.delete.bind(contactsController) as any);

// ─── Customer Profile ──────────────────────────────────

router.get('/:workspaceId/:contactId/profile', requireWorkspaceMember() as any, contactsController.getCustomerProfile.bind(contactsController) as any);
router.post('/:workspaceId/:contactId/profile', requireWorkspaceMember() as any, validate(createCustomerProfileSchema), contactsController.createCustomerProfile.bind(contactsController) as any);
router.patch('/:workspaceId/:contactId/profile', requireWorkspaceMember() as any, validate(updateCustomerProfileSchema), contactsController.updateCustomerProfile.bind(contactsController) as any);

export default router;
