/**
 * Posting rules for receivables and payables. Pure — no I/O.
 *
 * Obligations are the accounting document; invoices are a presentation layer
 * over them. `sendInvoice` already creates the obligation, so posting from the
 * obligation gives one rule instead of two, makes double-posting an
 * invoice-backed receivable impossible, and gives manually-created obligations
 * (which posted nothing at all before) correct treatment for free.
 *
 * ─── Why the deferred offset ───
 *
 * The product recognizes revenue on CASH, but a balance sheet without
 * receivables is not a balance sheet. Booking `Dr AR / Cr Revenue` on send would
 * put AR on the balance sheet but break the rule that a payment entry adds its
 * full amount to Cashbook.totalIncome — the settlement journal would have no
 * income leg, and the ledger would silently disagree with every existing screen.
 *
 * So an obligation books `Dr AR / Cr Deferred Revenue`: AR appears as an asset,
 * offset by a liability, with zero effect on the P&L. When cash arrives, the
 * entry rules move the amount out of Deferred Revenue into Revenue. Revenue is
 * still recognized on cash, AR is still on the balance sheet, and every cache
 * identity holds exactly.
 */
import { JournalSourceType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from '../../finance/money';
import type { JournalDraft, LegDraft } from '../ledger.types';

export interface ObligationPostingInput {
    workspaceId: string;
    cashbookId: string;
    obligationId: string;
    version: number;
    type: 'RECEIVABLE' | 'PAYABLE';
    totalAmount: Decimal | string | number;
    title: string;
    entryDate: Date;
    currency: string;
    createdById: string;
    contactId?: string | null;
}

export function obligationPostingKey(obligationId: string, version: number): string {
    return `obligation:${obligationId}:v${version}`;
}

/**
 * RECEIVABLE: Dr Accounts Receivable / Cr Deferred Revenue
 * PAYABLE:    Dr Deferred Purchases / Cr Accounts Payable
 */
export function buildObligationJournal(input: ObligationPostingInput): JournalDraft {
    const total = toDecimal(input.totalAmount);
    const dims = {
        obligationId: input.obligationId,
        contactId: input.contactId ?? null,
    };

    const legs: LegDraft[] =
        input.type === 'RECEIVABLE'
            ? [
                { ref: { kind: 'SYSTEM', key: 'AR' }, debit: total, memo: input.title, dims },
                {
                    ref: { kind: 'SYSTEM', key: 'DEFERRED_REVENUE' },
                    credit: total,
                    memo: 'Cash-basis offset; recognized as revenue on payment',
                    dims,
                },
            ]
            : [
                {
                    ref: { kind: 'SYSTEM', key: 'DEFERRED_EXPENSE' },
                    debit: total,
                    memo: 'Cash-basis offset; recognized as expense on payment',
                    dims,
                },
                { ref: { kind: 'SYSTEM', key: 'AP' }, credit: total, memo: input.title, dims },
            ];

    return {
        workspaceId: input.workspaceId,
        cashbookId: input.cashbookId,
        currency: input.currency,
        entryDate: input.entryDate,
        description: `${input.type === 'RECEIVABLE' ? 'Receivable' : 'Payable'}: ${input.title}`,
        sourceType: JournalSourceType.OBLIGATION,
        sourceId: input.obligationId,
        postingKey: obligationPostingKey(input.obligationId, input.version),
        createdById: input.createdById,
        legs,
    };
}

// ─── Cancellation / write-off ─────────────────────────────

export interface ObligationWriteOffInput {
    workspaceId: string;
    cashbookId: string;
    obligationId: string;
    type: 'RECEIVABLE' | 'PAYABLE';
    /** The amount still owed. Already-settled amounts are untouched. */
    outstandingAmount: Decimal | string | number;
    title: string;
    entryDate: Date;
    currency: string;
    createdById: string;
    contactId?: string | null;
    reason: string;
}

export function obligationWriteOffPostingKey(obligationId: string): string {
    return `obligation:${obligationId}:writeoff`;
}

/**
 * Take a cancelled obligation's remaining balance off the books.
 *
 * Deliberately NOT a reversal of the opening journal. Reversing that would undo
 * the full original amount, so cancelling a partly-paid receivable would drive
 * AR negative by whatever had already been collected. Writing off only the
 * outstanding portion leaves settled amounts — and the revenue recognized
 * against them — exactly as they were.
 *
 * RECEIVABLE: Dr Deferred Revenue / Cr Accounts Receivable
 * PAYABLE:    Dr Accounts Payable / Cr Deferred Purchases
 */
export function buildObligationWriteOffJournal(input: ObligationWriteOffInput): JournalDraft {
    const outstanding = toDecimal(input.outstandingAmount);
    const dims = {
        obligationId: input.obligationId,
        contactId: input.contactId ?? null,
    };

    const legs: LegDraft[] =
        input.type === 'RECEIVABLE'
            ? [
                {
                    ref: { kind: 'SYSTEM', key: 'DEFERRED_REVENUE' },
                    debit: outstanding,
                    memo: `Cancelled: ${input.reason}`,
                    dims,
                },
                {
                    ref: { kind: 'SYSTEM', key: 'AR' },
                    credit: outstanding,
                    memo: `Written off: ${input.title}`,
                    dims,
                },
            ]
            : [
                {
                    ref: { kind: 'SYSTEM', key: 'AP' },
                    debit: outstanding,
                    memo: `Written off: ${input.title}`,
                    dims,
                },
                {
                    ref: { kind: 'SYSTEM', key: 'DEFERRED_EXPENSE' },
                    credit: outstanding,
                    memo: `Cancelled: ${input.reason}`,
                    dims,
                },
            ];

    return {
        workspaceId: input.workspaceId,
        cashbookId: input.cashbookId,
        currency: input.currency,
        entryDate: input.entryDate,
        description: `Cancelled ${input.type === 'RECEIVABLE' ? 'receivable' : 'payable'}: ${input.title}`,
        sourceType: JournalSourceType.OBLIGATION,
        sourceId: input.obligationId,
        postingKey: obligationWriteOffPostingKey(input.obligationId),
        createdById: input.createdById,
        legs,
    };
}
