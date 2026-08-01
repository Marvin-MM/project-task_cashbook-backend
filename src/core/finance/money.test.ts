/**
 * Unit tests for the finance money math.
 *
 * These formulas are the semantic contract that the double-entry posting rules
 * must reproduce exactly (see src/core/ledger/rules/entry.rules.ts). Treat this
 * file as the oracle: if a posting rule disagrees with it, the posting rule is
 * wrong.
 *
 * Ported from the pre-Vitest money.selftest.ts script.
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import {
    cashbookBalanceDelta,
    cashbookIncrementPayload,
    effectiveCashAmount,
    incomeExpenseDeltas,
    invoiceStatusFromOutstanding,
    obligationStatusFromAmounts,
    recomputeCashbookFromEntries,
    recomputeWalletBalance,
    shouldAffectCashbookBalance,
    walletBalanceDelta,
} from './money';

const dec = (v: string | number) => new Decimal(v);

describe('effectiveCashAmount', () => {
    it('subtracts the charge from income (fee reduces cash received)', () => {
        expect(effectiveCashAmount('INCOME', '100', '5').toString()).toBe('95');
    });

    it('adds the charge to expense (fee increases cash paid)', () => {
        expect(effectiveCashAmount('EXPENSE', '100', '5').toString()).toBe('105');
    });

    it('treats a null charge as zero', () => {
        expect(effectiveCashAmount('INCOME', '100', null).toString()).toBe('100');
        expect(effectiveCashAmount('EXPENSE', '100', undefined).toString()).toBe('100');
    });
});

describe('incomeExpenseDeltas', () => {
    it('counts an income charge as expense activity', () => {
        const d = incomeExpenseDeltas('INCOME', '100', '5');
        expect(d.totalIncomeDelta.toString()).toBe('100');
        expect(d.totalExpenseDelta.toString()).toBe('5');
    });

    it('rolls the charge into the expense total', () => {
        const d = incomeExpenseDeltas('EXPENSE', '100', '5');
        expect(d.totalIncomeDelta.toString()).toBe('0');
        expect(d.totalExpenseDelta.toString()).toBe('105');
    });
});

describe('cashbook balance vs wallet link', () => {
    it('only unlinked entries move book cash', () => {
        expect(shouldAffectCashbookBalance(false)).toBe(true);
        expect(shouldAffectCashbookBalance(true)).toBe(false);
    });

    it('computes signed book-cash deltas for unlinked entries', () => {
        expect(cashbookBalanceDelta('INCOME', '100', '5', false).toString()).toBe('95');
        expect(cashbookBalanceDelta('EXPENSE', '100', '5', false).toString()).toBe('-105');
    });

    it('contributes zero book cash when wallet-linked', () => {
        expect(cashbookBalanceDelta('INCOME', '100', '5', true).toString()).toBe('0');
        expect(cashbookBalanceDelta('EXPENSE', '100', '5', true).toString()).toBe('0');
    });

    it('still moves the wallet regardless of link state', () => {
        expect(walletBalanceDelta('INCOME', '100', '5').toString()).toBe('95');
        expect(walletBalanceDelta('EXPENSE', '100', '5').toString()).toBe('-105');
    });
});

describe('cashbookIncrementPayload', () => {
    it('omits balance but keeps activity totals for wallet-linked entries', () => {
        const payload = cashbookIncrementPayload('INCOME', '100', '5', true, 'apply');
        expect(payload.balance).toBeUndefined();
        expect(payload.totalIncome!.increment.toString()).toBe('100');
        expect(payload.totalExpense!.increment.toString()).toBe('5');
    });

    it('includes balance for unlinked entries', () => {
        const payload = cashbookIncrementPayload('INCOME', '100', '5', false, 'apply');
        expect(payload.balance!.increment.toString()).toBe('95');
    });

    it('negates every delta in reverse mode', () => {
        const apply = cashbookIncrementPayload('EXPENSE', '100', '5', false, 'apply');
        const reverse = cashbookIncrementPayload('EXPENSE', '100', '5', false, 'reverse');
        expect(reverse.balance!.increment.toString()).toBe(apply.balance!.increment.negated().toString());
        expect(reverse.totalExpense!.increment.toString()).toBe(
            apply.totalExpense!.increment.negated().toString(),
        );
    });

    it('apply then reverse nets to zero for every input shape', () => {
        const shapes = [
            { type: 'INCOME', amount: '200', charge: '10', linked: false },
            { type: 'INCOME', amount: '200', charge: '10', linked: true },
            { type: 'EXPENSE', amount: '75.25', charge: null, linked: false },
            { type: 'EXPENSE', amount: '75.25', charge: '0.75', linked: true },
        ] as const;

        for (const s of shapes) {
            const apply = cashbookIncrementPayload(s.type, s.amount, s.charge, s.linked, 'apply');
            const reverse = cashbookIncrementPayload(s.type, s.amount, s.charge, s.linked, 'reverse');
            for (const field of ['balance', 'totalIncome', 'totalExpense'] as const) {
                const a = apply[field]?.increment ?? dec(0);
                const r = reverse[field]?.increment ?? dec(0);
                expect(a.add(r).toString(), `${s.type} ${s.amount}/${s.charge} ${field}`).toBe('0');
            }
        }
    });
});

describe('recomputeCashbookFromEntries', () => {
    const entries = [
        { type: 'INCOME', amount: '200', chargeAmount: '10', hasWalletLink: false },
        { type: 'EXPENSE', amount: '50', chargeAmount: null, hasWalletLink: false },
        { type: 'INCOME', amount: '30', chargeAmount: null, hasWalletLink: true },
    ];

    it('includes wallet-linked entries in activity totals', () => {
        const r = recomputeCashbookFromEntries(entries);
        expect(r.totalIncome.toString()).toBe('230');
        expect(r.totalExpense.toString()).toBe('60');
    });

    it('excludes wallet-linked entries from book cash', () => {
        const r = recomputeCashbookFromEntries(entries);
        expect(r.balance.toString()).toBe('140');
        expect(r.bookIncome.toString()).toBe('200');
        expect(r.bookExpense.toString()).toBe('60');
        expect(r.walletLinkedCount).toBe(1);
        expect(r.unallocatedCount).toBe(2);
    });

    it('book cash must NOT equal activity net when any entry is wallet-linked', () => {
        const r = recomputeCashbookFromEntries(entries);
        const activityNet = r.totalIncome.sub(r.totalExpense);
        expect(r.balance.equals(activityNet)).toBe(false);
    });
});

describe('recomputeWalletBalance', () => {
    it('applies transfer fees to the outgoing side only', () => {
        const bal = recomputeWalletBalance(
            [{ type: 'INCOME', amount: '1000', chargeAmount: null }],
            [
                { direction: 'OUT', amount: '200', feeAmount: '5' },
                { direction: 'IN', amount: '50' },
            ],
        );
        expect(bal.toString()).toBe('845');
    });
});

describe('obligationStatusFromAmounts', () => {
    it.each([
        ['100', '100', undefined, 'OPEN'],
        ['100', '40', undefined, 'PARTIAL'],
        ['100', '0', undefined, 'PAID'],
        ['100', '-5', undefined, 'PAID'],
        ['100', '0', 'CANCELLED', 'CANCELLED'],
    ])('total=%s outstanding=%s current=%s -> %s', (total, outstanding, current, expected) => {
        expect(obligationStatusFromAmounts(total, outstanding, current as never)).toBe(expected);
    });
});

describe('invoiceStatusFromOutstanding', () => {
    it.each([
        ['100', '0', 'SENT', 'PAID'],
        ['100', '40', 'SENT', 'PARTIALLY_PAID'],
        ['100', '100', 'OVERDUE', 'OVERDUE'],
        ['100', '0', 'VOID', 'VOID'],
        ['100', '100', 'DRAFT', 'DRAFT'],
    ])('total=%s outstanding=%s previous=%s -> %s', (total, outstanding, previous, expected) => {
        expect(invoiceStatusFromOutstanding(total, outstanding, previous)).toBe(expected);
    });
});
