import { z } from 'zod';
import { ApprovalStatus, ExpensePaymentSource } from '@prisma/client';

const decimalString = z.string().regex(
    /^\d+(\.\d{1,4})?$/,
    'Amount must be a valid decimal number with up to 4 decimal places',
);

export const createExpenseClaimSchema = z.object({
    taskId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    amount: decimalString,
    currency: z.string().length(3, 'Use a 3-letter currency code'),
    description: z.string().min(1, 'Say what the expense was for').max(500),
    /** Calendar date, not an instant — an expense happened on a day. */
    incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    paymentSource: z.nativeEnum(ExpensePaymentSource),
    accountId: z.string().uuid().optional(),
}).superRefine((d, ctx) => {
    if (d.paymentSource === ExpensePaymentSource.ORG_WALLET && !d.accountId) {
        ctx.addIssue({
            code: 'custom',
            message: 'Say which wallet the money came from',
            path: ['accountId'],
        });
    }
    if (d.paymentSource === ExpensePaymentSource.OWN_MONEY && d.accountId) {
        // Otherwise the claim looks like it came from a wallet that was never
        // debited, and the approver would post against the wrong source.
        ctx.addIssue({
            code: 'custom',
            message: 'Money you paid yourself does not come from a wallet',
            path: ['accountId'],
        });
    }
});

export const reviewExpenseClaimSchema = z.object({
    approve: z.boolean(),
    /** Which book the expense belongs to. Required to approve, not to decline. */
    cashbookId: z.string().uuid().optional(),
    /**
     * Required when declining — enforced in the service, because the rule
     * depends on `approve` and a cross-field refine would report the error
     * against the wrong field.
     */
    reviewNote: z.string().max(1000).optional(),
});

export const expenseClaimQuerySchema = z.object({
    status: z.nativeEnum(ApprovalStatus).optional(),
    taskId: z.string().uuid().optional(),
    /** Force the "only mine" view even when the caller could see everything. */
    mine: z.coerce.boolean().optional(),
});

export type CreateExpenseClaimDto = z.infer<typeof createExpenseClaimSchema>;
export type ReviewExpenseClaimDto = z.infer<typeof reviewExpenseClaimSchema>;
export type ExpenseClaimQueryDto = z.infer<typeof expenseClaimQuerySchema>;
