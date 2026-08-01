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
    chargeAmount: decimalString.optional(),
    description: z.string().min(1, 'Description is required').max(255, 'Description too long'),
    accountCategoryId: z.string().uuid('Invalid category ID').optional().nullable(),
    /** Business date of the movement. Defaults to now. Allows backdating to match a bank statement. */
    transactionDate: z.string().datetime({ message: 'Transaction date must be a valid ISO date' }).optional(),
    inventoryItems: z.array(z.object({
        itemId: z.string().uuid('Invalid inventory item ID'),
        quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1'),
        unitCost: decimalString.optional(),
    })).optional(),
});

export const updateAccountTransactionSchema = createAccountTransactionSchema.partial();

export type CreateAccountTransactionBody = z.infer<typeof createAccountTransactionSchema>;
export type UpdateAccountTransactionBody = z.infer<typeof updateAccountTransactionSchema>;
