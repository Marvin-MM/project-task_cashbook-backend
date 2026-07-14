import { z } from 'zod';

const decimalString = z.string().regex(
    /^\d+(\.\d{1,4})?$/,
    'Amount must be a valid decimal number with up to 4 decimal places'
);

export const createAccountSchema = z.object({
    accountTypeId: z.string().uuid('Invalid account type ID'),
    name: z.string().min(1, 'Name is required').max(100, 'Name must be at most 100 characters'),
    currency: z.string().length(3, 'Currency must be a 3-letter code'),
    icon: z.string().optional(),
    excludeFromTotal: z.boolean().optional(),
    allowNegative: z.boolean().optional(),
    note: z.string().max(500).optional(),
    initialBalance: decimalString.optional(),
});

export const updateAccountSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    icon: z.string().optional(),
    excludeFromTotal: z.boolean().optional(),
    allowNegative: z.boolean().optional(),
    note: z.string().max(500).optional(),
});

export const archiveAccountSchema = z.object({
    archive: z.boolean(),
});

export const createAccountTransferSchema = z.object({
    fromAccountId: z.string().uuid('Invalid source account ID'),
    toAccountId: z.string().uuid('Invalid destination account ID'),
    amount: decimalString,
    feeAmount: decimalString.optional(),
    description: z.string().min(1).max(500),
    transferredAt: z.string().datetime().optional(),
}).refine((data) => data.fromAccountId !== data.toAccountId, {
    message: 'Source and destination accounts must be different',
    path: ['toAccountId'],
});

export type CreateAccountBody = z.infer<typeof createAccountSchema>;
export type UpdateAccountBody = z.infer<typeof updateAccountSchema>;
export type ArchiveAccountBody = z.infer<typeof archiveAccountSchema>;
export type CreateAccountTransferBody = z.infer<typeof createAccountTransferSchema>;
