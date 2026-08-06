import { z } from 'zod';
import { ObligationType, ObligationStatus } from '@prisma/client';

const decimalString = z.string().regex(
    /^\d+(\.\d{1,4})?$/,
    'Amount must be a valid decimal number with up to 4 decimal places'
);

const inventoryLineItem = z.object({
    itemId: z.string().uuid('Invalid inventory item ID'),
    quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1'),
    unitCost: decimalString.optional(),
});

/**
 * Creating a receivable or payable, with or without interest.
 *
 * Two ways to say the same thing, and the schema accepts both:
 *
 *   totalAmount: '110000'                          — no interest, as before
 *   principalAmount: '100000', interestRate: '10'  — lend 100k at 10%
 *   principalAmount: '100000', interestAmount: '10000'
 *
 * `totalAmount` stays optional-but-supported so every existing caller keeps
 * working untouched; the service resolves whichever form arrived into the same
 * three stored figures.
 *
 * A rate AND a flat amount together is refused rather than silently preferring
 * one — that is how a form ends up charging a number nobody typed.
 */
export const createObligationSchema = z.object({
    type: z.nativeEnum(ObligationType).refine((val) => val !== undefined, { message: 'Invalid obligation type' }),
    contactId: z.string().uuid('Invalid contact ID').optional().nullable(),
    title: z.string().min(1, 'Title is required').max(200, 'Title is too long'),
    description: z.string().max(1000, 'Description is too long').optional(),
    totalAmount: decimalString.optional(),
    principalAmount: decimalString.optional(),
    /** Flat percentage of the principal, charged once. Not per-annum. */
    interestRate: z.string()
        .regex(/^\d+(\.\d{1,4})?$/, 'Interest rate must be a positive number')
        .refine((v) => Number(v) <= 1000, 'Interest rate looks too large')
        .optional(),
    interestAmount: decimalString.optional(),
    dueDate: z.string()
        .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid date format' })
        .optional(),
    inventoryItems: z.array(inventoryLineItem).optional(),
}).refine(
    (v) => Boolean(v.totalAmount) || Boolean(v.principalAmount),
    { message: 'Give an amount, or a principal to charge interest on', path: ['totalAmount'] },
).refine(
    (v) => !(v.interestRate && v.interestAmount),
    { message: 'Set the interest as a rate or as an amount, not both', path: ['interestRate'] },
).refine(
    (v) => !((v.interestRate || v.interestAmount) && !v.principalAmount),
    {
        message: 'Interest needs a principal to be charged on',
        path: ['principalAmount'],
    },
);

export const updateObligationSchema = z.object({
    title: z.string().min(1, 'Title is required').max(200, 'Title is too long').optional(),
    description: z.string().max(1000, 'Description is too long').optional().nullable(),
    dueDate: z.string()
        .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid date format' })
        .optional()
        .nullable(),
});

export const obligationQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    type: z.nativeEnum(ObligationType).optional(),
    status: z.nativeEnum(ObligationStatus).optional(),
    isOverdue: z.enum(['true', 'false']).transform(val => val === 'true').optional(),
    sortBy: z.enum(['createdAt', 'dueDate', 'totalAmount', 'outstandingAmount']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    includeArchived: z.enum(['true', 'false']).transform(val => val === 'true').optional(),
});

export type CreateObligationDto = z.infer<typeof createObligationSchema>;
export type UpdateObligationDto = z.infer<typeof updateObligationSchema>;
export type ObligationQueryDto = z.infer<typeof obligationQuerySchema>;
