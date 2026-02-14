import { z } from 'zod';

export const createCashbookSchema = z.object({
    name: z.string().min(1, 'Cashbook name is required').max(200),
    description: z.string().max(1000).optional(),
    currency: z.string().length(3, 'Currency must be a 3-letter ISO code').default('USD'),
    allowBackdate: z.boolean().default(false),
});

export const updateCashbookSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    currency: z.string().length(3).optional(),
    allowBackdate: z.boolean().optional(),
});

export const addCashbookMemberSchema = z.object({
    email: z.string().email('Invalid email address'),
    role: z.enum(['ADMIN', 'BOOK_ADMIN', 'DATA_OPERATOR', 'VIEWER']).default('VIEWER'),
});

export const updateCashbookMemberRoleSchema = z.object({
    role: z.enum(['ADMIN', 'BOOK_ADMIN', 'DATA_OPERATOR', 'VIEWER']),
});

export type CreateCashbookDto = z.infer<typeof createCashbookSchema>;
export type UpdateCashbookDto = z.infer<typeof updateCashbookSchema>;
export type AddCashbookMemberDto = z.infer<typeof addCashbookMemberSchema>;
export type UpdateCashbookMemberRoleDto = z.infer<typeof updateCashbookMemberRoleSchema>;
