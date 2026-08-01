/**
 * Posting rules for cashbook entries. Pure — no I/O, no database, no clock.
 *
 * These reproduce src/core/finance/money.ts exactly. That is not a coincidence
 * to be maintained by hand: money.test.ts asserts the equivalence across the
 * full input matrix, so a rule that drifts from the documented cash semantics
 * fails the build.
 *
 * The product's defining rule — a wallet-linked entry moves the wallet but not
 * the cashbook's book balance, while still counting in money-in/out totals —
 * is not implemented as a condition anywhere below. It is simply where the cash
 * leg is routed: BOOK_CASH when unlinked, WALLET when linked. The income and
 * expense legs are identical either way, which is why the totals are unaffected.
 */
import { JournalSourceType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from '../../finance/money';
import type { JournalDraft, LedgerRef, LegDraft } from '../ledger.types';

export interface EntryPostingInput {
    workspaceId: string;
    cashbookId: string;
    entryId: string;
    /** Bumped on each edit; makes the posting key unique per version. */
    version: number;
    type: 'INCOME' | 'EXPENSE';
    amount: Decimal | string | number;
    chargeAmount?: Decimal | string | number | null;
    description: string;
    entryDate: Date;
    currency: string;
    createdById: string;
    /** Present when the user linked a wallet. */
    accountId?: string | null;
    categoryId?: string | null;
    contactId?: string | null;
    /** Present when this entry settles a receivable or payable. */
    obligation?: { id: string; type: 'RECEIVABLE' | 'PAYABLE' } | null;
}

export function entryPostingKey(entryId: string, version: number): string {
    return `entry:${entryId}:v${version}`;
}

/**
 * Build the balanced journal for one cashbook entry.
 *
 * INCOME, no obligation:    Dr Cash (A−C) · Dr Fees (C) · Cr Revenue (A)
 * EXPENSE, no obligation:   Dr Expense (A) · Dr Fees (C) · Cr Cash (A+C)
 *
 * Settling a RECEIVABLE additionally moves the amount out of deferred revenue
 * into revenue, so cash-basis income is recognized when the cash arrives while
 * the receivable leaves the balance sheet:
 *   Dr Cash (A−C) · Dr Fees (C) · Cr AR (A) · Dr Deferred Revenue (A) · Cr Revenue (A)
 *
 * Settling a PAYABLE is the mirror image.
 */
export function buildEntryJournal(input: EntryPostingInput): JournalDraft {
    const amount = toDecimal(input.amount);
    const charge = toDecimal(input.chargeAmount);

    // The whole wallet-link rule, in one expression.
    const cashRef: LedgerRef = input.accountId
        ? { kind: 'WALLET', accountId: input.accountId }
        : { kind: 'BOOK_CASH', cashbookId: input.cashbookId };

    const dims = {
        entryId: input.entryId,
        categoryId: input.categoryId ?? null,
        contactId: input.contactId ?? null,
    };

    const legs: LegDraft[] =
        input.type === 'INCOME'
            ? buildIncomeLegs(input, amount, charge, cashRef, dims)
            : buildExpenseLegs(input, amount, charge, cashRef, dims);

    return {
        workspaceId: input.workspaceId,
        cashbookId: input.cashbookId,
        currency: input.currency,
        entryDate: input.entryDate,
        description: input.description,
        sourceType: JournalSourceType.CASHBOOK_ENTRY,
        sourceId: input.entryId,
        postingKey: entryPostingKey(input.entryId, input.version),
        createdById: input.createdById,
        legs,
    };
}

function buildIncomeLegs(
    input: EntryPostingInput,
    amount: Decimal,
    charge: Decimal,
    cashRef: LedgerRef,
    dims: Record<string, string | null>,
): LegDraft[] {
    const settlesReceivable = input.obligation?.type === 'RECEIVABLE';

    const legs: LegDraft[] = [
        // Cash received is net of the charge — matches effectiveCashAmount.
        { ref: cashRef, debit: amount.sub(charge), memo: input.description, dims },
        // The charge is expense activity even on an income entry; this leg is
        // what makes incomeExpenseDeltas' totalExpenseDelta come out right.
        { ref: { kind: 'SYSTEM', key: 'TRANSACTION_FEES' }, debit: charge, memo: 'Transaction charge', dims },
    ];

    if (settlesReceivable) {
        // Clear the receivable...
        legs.push({
            ref: { kind: 'SYSTEM', key: 'AR' },
            credit: amount,
            memo: 'Receivable settled',
            dims: { ...dims, obligationId: input.obligation!.id },
        });
        // ...and recognize the revenue now that cash has landed.
        legs.push({
            ref: { kind: 'SYSTEM', key: 'DEFERRED_REVENUE' },
            debit: amount,
            memo: 'Revenue recognized on cash receipt',
            dims: { ...dims, obligationId: input.obligation!.id },
        });
        legs.push({
            ref: { kind: 'CATEGORY', categoryId: input.categoryId ?? null, fallback: 'SALES_REVENUE' },
            credit: amount,
            memo: input.description,
            dims,
        });
    } else {
        legs.push({
            ref: { kind: 'CATEGORY', categoryId: input.categoryId ?? null, fallback: 'SALES_REVENUE' },
            credit: amount,
            memo: input.description,
            dims,
        });
    }

    return legs;
}

function buildExpenseLegs(
    input: EntryPostingInput,
    amount: Decimal,
    charge: Decimal,
    cashRef: LedgerRef,
    dims: Record<string, string | null>,
): LegDraft[] {
    const settlesPayable = input.obligation?.type === 'PAYABLE';

    const legs: LegDraft[] = [];

    if (settlesPayable) {
        // Clear the payable...
        legs.push({
            ref: { kind: 'SYSTEM', key: 'AP' },
            debit: amount,
            memo: 'Payable settled',
            dims: { ...dims, obligationId: input.obligation!.id },
        });
        // ...and recognize the expense now that cash has left.
        legs.push({
            ref: { kind: 'CATEGORY', categoryId: input.categoryId ?? null, fallback: 'GENERAL_EXPENSES' },
            debit: amount,
            memo: input.description,
            dims,
        });
        legs.push({
            ref: { kind: 'SYSTEM', key: 'DEFERRED_EXPENSE' },
            credit: amount,
            memo: 'Expense recognized on cash payment',
            dims: { ...dims, obligationId: input.obligation!.id },
        });
    } else {
        legs.push({
            ref: { kind: 'CATEGORY', categoryId: input.categoryId ?? null, fallback: 'GENERAL_EXPENSES' },
            debit: amount,
            memo: input.description,
            dims,
        });
    }

    legs.push({
        ref: { kind: 'SYSTEM', key: 'TRANSACTION_FEES' },
        debit: charge,
        memo: 'Transaction charge',
        dims,
    });
    // Cash paid includes the charge — matches effectiveCashAmount.
    legs.push({ ref: cashRef, credit: amount.add(charge), memo: input.description, dims });

    return legs;
}
