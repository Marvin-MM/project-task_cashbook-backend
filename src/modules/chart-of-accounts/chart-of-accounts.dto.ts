import { z } from 'zod';

const decimalString = z.string().regex(
    /^\d+(\.\d{1,4})?$/,
    'Must be a positive decimal with up to 4 decimal places',
);

/** Account codes drive report ordering, so keep them short and sortable. */
const accountCode = z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9.\-]+$/, 'Code may contain letters, digits, dots and hyphens only');

const ledgerClass = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);

export const createLedgerAccountSchema = z.object({
    code: accountCode,
    name: z.string().min(1).max(120),
    class: ledgerClass,
    parentId: z.string().uuid().nullable().optional(),
    /** Counts toward the cash flow statement. Only meaningful for assets. */
    isCashEquivalent: z.boolean().default(false),
    /** False makes it a presentation-only roll-up that cannot be posted to. */
    isPostable: z.boolean().default(true),
});

export const updateLedgerAccountSchema = z.object({
    code: accountCode.optional(),
    name: z.string().min(1).max(120).optional(),
    class: ledgerClass.optional(),
    parentId: z.string().uuid().nullable().optional(),
    isCashEquivalent: z.boolean().optional(),
    isActive: z.boolean().optional(),
});

export const mapCategorySchema = z.object({
    /** Null unmaps, falling back to the default revenue/expense account. */
    ledgerAccountId: z.string().uuid().nullable(),
});

export const manualJournalSchema = z
    .object({
        description: z.string().min(1).max(500),
        entryDate: z.string().datetime({ message: 'Must be a valid ISO date' }),
        /** Optional: attributes the journal to a book on the income statement. */
        cashbookId: z.string().uuid().nullable().optional(),
        /**
         * Caller-supplied idempotency handle. Reposting with the same reference
         * is rejected by the unique posting key rather than silently duplicated.
         */
        reference: z.string().min(1).max(80).optional(),
        lines: z
            .array(
                z
                    .object({
                        ledgerAccountId: z.string().uuid(),
                        debit: decimalString.optional(),
                        credit: decimalString.optional(),
                        memo: z.string().max(255).optional(),
                        contactId: z.string().uuid().nullable().optional(),
                        categoryId: z.string().uuid().nullable().optional(),
                    })
                    .refine(
                        (l) => Boolean(l.debit) !== Boolean(l.credit),
                        'Each line must carry exactly one of debit or credit',
                    )
                    .refine(
                        (l) => Number(l.debit ?? l.credit) > 0,
                        'Line amounts must be greater than zero',
                    ),
            )
            .min(2, 'A journal needs at least two lines'),
    })
    .refine(
        (v) => {
            const debit = v.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
            const credit = v.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
            // Compared at 4dp to match the column precision; the service re-checks
            // with Decimal, and the database trigger is the final backstop.
            return Math.abs(debit - credit) < 0.00005;
        },
        { message: 'Debits must equal credits', path: ['lines'] },
    );

export const reverseJournalSchema = z.object({
    reason: z.string().min(1, 'A reason is required').max(500),
});

export const closePeriodSchema = z.object({
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    note: z.string().max(500).optional(),
});

export const reopenPeriodSchema = z.object({
    reason: z.string().min(1, 'A reason is required').max(500),
});

export const journalQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    sourceType: z
        .enum([
            'CASHBOOK_ENTRY',
            'ACCOUNT_TRANSACTION',
            'ACCOUNT_TRANSFER',
            'ACCOUNT_OPENING',
            'OBLIGATION',
            'INVENTORY',
            'MANUAL',
        ])
        .optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
});

export const chartQuerySchema = z.object({
    includeArchived: z.coerce.boolean().default(false),
});

export type CreateLedgerAccountDto = z.infer<typeof createLedgerAccountSchema>;
export type UpdateLedgerAccountDto = z.infer<typeof updateLedgerAccountSchema>;
export type MapCategoryDto = z.infer<typeof mapCategorySchema>;
export type ManualJournalDto = z.infer<typeof manualJournalSchema>;
export type ReverseJournalDto = z.infer<typeof reverseJournalSchema>;
export type ClosePeriodDto = z.infer<typeof closePeriodSchema>;
export type ReopenPeriodDto = z.infer<typeof reopenPeriodSchema>;
export type JournalQueryDto = z.infer<typeof journalQuerySchema>;
