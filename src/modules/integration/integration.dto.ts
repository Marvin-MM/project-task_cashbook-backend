import { z } from 'zod';

const decimalString = z.string().regex(
    /^\d+(\.\d{1,4})?$/,
    'Amount must be a valid decimal number with up to 4 decimal places'
);

/**
 * Schema for a single entry submitted via the external integration API.
 *
 * Deliberately simpler than the internal CreateEntryDto:
 *   - `bookRef` replaces the UUID cashbookId (developer-friendly short code)
 *   - no wallet/account is required from integrators; unlinked entries post
 *     against the cashbook's own ledger account
 *   - `externalRef` lets the caller supply their own idempotency key so
 *     re-submits on retry do not double-count
 */
export const integrateEntrySchema = z.object({
    /** The cashbook's human-readable reference code (e.g. "CB-2B2F..."). */
    bookRef: z.string().min(1, 'bookRef is required'),

    type: z.enum(['INCOME', 'EXPENSE'], {
        message: 'type must be INCOME or EXPENSE',
    }),

    amount: decimalString,

    /** Optional bank/mobile-money charge amount that came out alongside the main amount. */
    chargeAmount: decimalString.optional(),

    description: z.string().min(1, 'description is required').max(1000),

    /** ISO 8601 datetime. Defaults to now() if omitted. */
    entryDate: z.string().datetime().optional(),

    /**
     * Your own unique reference for this record. Used for idempotent submission:
     * if we see this ref already committed for the same workspace, we return the
     * existing entry rather than creating a duplicate.
     */
    externalRef: z.string().max(200).optional(),

    /** Optional category UUID. */
    categoryId: z.string().uuid().optional(),

    /** Optional contact UUID. */
    contactId: z.string().uuid().optional(),

    /** Optional payment mode UUID. */
    paymentModeId: z.string().uuid().optional(),
});

export const integrateBatchSchema = z.object({
    entries: z
        .array(integrateEntrySchema)
        .min(1, 'At least one entry is required')
        .max(100, 'Maximum 100 entries per batch'),
}).superRefine(({ entries }, ctx) => {
    const bookRef = entries[0]?.bookRef;
    if (entries.some((entry) => entry.bookRef !== bookRef)) {
        ctx.addIssue({ code: 'custom', path: ['entries'], message: 'Every batch entry must use the same bookRef' });
    }
});

export type IntegrateEntryDto = z.infer<typeof integrateEntrySchema>;
export type IntegrateBatchDto = z.infer<typeof integrateBatchSchema>;
