import { z } from 'zod';
import { EntryType } from '@prisma/client';

const decimalString = z.string().regex(
    /^\d+(\.\d{1,4})?$/,
    'Amount must be a valid decimal number with up to 4 decimal places'
);

export const createAccountTransactionSchema = z.object({
    type: z.nativeEnum(EntryType, {
        message: 'Invalid transaction type'
    }),
    amount: decimalString,
    description: z.string().min(1, 'Description is required').max(255, 'Description too long'),
    accountCategoryId: z.string().uuid('Invalid category ID').optional().nullable(),
});

export const updateAccountTransactionSchema = createAccountTransactionSchema.partial();

export type CreateAccountTransactionBody = z.infer<typeof createAccountTransactionSchema>;
export type UpdateAccountTransactionBody = z.infer<typeof updateAccountTransactionSchema>;
