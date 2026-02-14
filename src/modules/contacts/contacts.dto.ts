import { z } from 'zod';

export const createContactSchema = z.object({
    name: z.string().min(1, 'Contact name is required').max(200),
    email: z.string().email().optional(),
    phone: z.string().max(30).optional(),
    company: z.string().max(200).optional(),
    notes: z.string().max(1000).optional(),
});

export const updateContactSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(30).optional(),
    company: z.string().max(200).optional(),
    notes: z.string().max(1000).optional(),
});

export type CreateContactDto = z.infer<typeof createContactSchema>;
export type UpdateContactDto = z.infer<typeof updateContactSchema>;
