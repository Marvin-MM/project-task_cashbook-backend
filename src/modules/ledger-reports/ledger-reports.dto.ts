import { z } from 'zod';

/** Guard against a client asking for a decade of general-ledger lines by accident. */
const MAX_RANGE_DAYS = 366 * 3;

const isoDate = z.string().datetime({ message: 'Must be a valid ISO date' });

const periodRefinement = <T extends { from: string; to: string }>(schema: z.ZodType<T>) =>
    schema
        .refine((v) => new Date(v.to) >= new Date(v.from), {
            message: 'to must be on or after from',
            path: ['to'],
        })
        .refine(
            (v) =>
                (new Date(v.to).getTime() - new Date(v.from).getTime()) / 86_400_000 <= MAX_RANGE_DAYS,
            { message: `Date range cannot exceed ${MAX_RANGE_DAYS} days`, path: ['to'] },
        );

export const balanceSheetQuerySchema = z.object({
    asOf: isoDate.optional(),
    /**
     * Start of the fiscal year, used for the "current period earnings" equity
     * line. Defaults to 1 January of asOf's year.
     */
    fiscalYearStart: isoDate.optional(),
});

export const incomeStatementQuerySchema = periodRefinement(
    z.object({
        from: isoDate,
        to: isoDate,
        /** Restrict to one book. Omit for every book plus the consolidated roll-up. */
        cashbookId: z.string().uuid().optional(),
    }),
);

export const trialBalanceQuerySchema = z.object({
    asOf: isoDate.optional(),
    includeZeroBalances: z.coerce.boolean().default(false),
});

export const generalLedgerQuerySchema = periodRefinement(
    z.object({
        ledgerAccountId: z.string().uuid(),
        from: isoDate,
        to: isoDate,
    }),
);

export const cashFlowQuerySchema = periodRefinement(
    z.object({ from: isoDate, to: isoDate }),
);

export const agingQuerySchema = z.object({
    type: z.enum(['RECEIVABLE', 'PAYABLE']).default('RECEIVABLE'),
    asOf: isoDate.optional(),
});

export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;
export type IncomeStatementQuery = z.infer<typeof incomeStatementQuerySchema>;
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;
export type GeneralLedgerQuery = z.infer<typeof generalLedgerQuerySchema>;
export type CashFlowQuery = z.infer<typeof cashFlowQuerySchema>;
export type AgingQuery = z.infer<typeof agingQuerySchema>;
