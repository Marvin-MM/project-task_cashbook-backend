/**
 * Interest on an obligation, and what counts as profit when.
 *
 * The policy under test is COST RECOVERY: repayments pay down capital first,
 * and nothing is profit until the capital is whole. These cases pin that down,
 * because the alternatives (pro-rata, interest-first) produce different — and
 * plausible-looking — numbers from the same inputs, and a silent switch between
 * them would misstate earnings without failing anything.
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import {
    obligationBreakdown,
    resolveInterest,
    emptyPosition,
    accumulate,
} from './obligation-interest';

const d = (v: string | number) => new Decimal(v);

/** The worked example from the brief: lend 100k at 10%, expect 110k back. */
const LOAN = {
    totalAmount: d(110_000),
    principalAmount: d(100_000),
    interestAmount: d(10_000),
};

const withRepaid = (repaid: number) => ({
    ...LOAN,
    outstandingAmount: d(110_000 - repaid),
});

describe('resolveInterest', () => {
    it('turns a principal and a rate into the amount actually owed', () => {
        const result = resolveInterest({ principalAmount: '100000', interestRate: '10' });

        expect(result.principalAmount.toString()).toBe('100000');
        expect(result.interestAmount.toString()).toBe('10000');
        expect(result.totalAmount.toString()).toBe('110000');
        expect(result.interestRate!.toString()).toBe('10');
    });

    it('accepts a flat charge and derives the rate for display', () => {
        const result = resolveInterest({ principalAmount: '100000', interestAmount: '12500' });

        expect(result.interestAmount.toString()).toBe('12500');
        expect(result.totalAmount.toString()).toBe('112500');
        expect(result.interestRate!.toString()).toBe('12.5');
    });

    it('leaves an interest-free obligation exactly as it was', () => {
        const result = resolveInterest({ principalAmount: '50000' });

        expect(result.interestAmount.toString()).toBe('0');
        expect(result.interestRate).toBeNull();
        expect(result.totalAmount.toString()).toBe('50000');
    });

    it('prefers the rate when both are somehow supplied', () => {
        // The DTO refuses this, but the function must still be deterministic
        // rather than picking whichever branch happens to run last.
        const result = resolveInterest({
            principalAmount: '100000', interestRate: '10', interestAmount: '99999',
        });
        expect(result.interestAmount.toString()).toBe('10000');
    });

    it('has no rate to report for a flat charge on nothing', () => {
        const result = resolveInterest({ principalAmount: '0', interestAmount: '500' });
        expect(result.interestRate).toBeNull();
        expect(result.totalAmount.toString()).toBe('500');
    });

    it('keeps total exactly equal to principal + interest, which the DB asserts', () => {
        // A rate that does not divide cleanly is where rounding both figures
        // independently would drift the total by a cent and trip the CHECK.
        const result = resolveInterest({ principalAmount: '10000.01', interestRate: '33.333' });

        expect(result.totalAmount.toString())
            .toBe(result.principalAmount.add(result.interestAmount).toString());
        expect(result.interestAmount.decimalPlaces()).toBeLessThanOrEqual(4);
    });
});

describe('cost recovery: capital comes back before anything is profit', () => {
    it('reports nothing earned while the loan is untouched', () => {
        const b = obligationBreakdown(withRepaid(0));

        expect(b.amountSettled.toString()).toBe('0');
        expect(b.principalRecovered.toString()).toBe('0');
        expect(b.principalAtRisk.toString()).toBe('100000');
        expect(b.interestRealized.toString()).toBe('0');
        expect(b.interestPending.toString()).toBe('10000');
        expect(b.isCapitalRecovered).toBe(false);
    });

    it('reports nothing earned at the half-way point — the position is still down', () => {
        const b = obligationBreakdown(withRepaid(55_000));

        expect(b.principalRecovered.toString()).toBe('55000');
        expect(b.principalAtRisk.toString()).toBe('45000');
        // The whole point of the policy: 5,000 here would be profit on money
        // that has not come back.
        expect(b.interestRealized.toString()).toBe('0');
        expect(b.isCapitalRecovered).toBe(false);
    });

    it('still reports nothing at the exact moment the capital is whole', () => {
        const b = obligationBreakdown(withRepaid(100_000));

        expect(b.principalRecovered.toString()).toBe('100000');
        expect(b.principalAtRisk.toString()).toBe('0');
        expect(b.interestRealized.toString()).toBe('0');
        expect(b.interestPending.toString()).toBe('10000');
        expect(b.isCapitalRecovered).toBe(true);
    });

    it('books profit only on what comes in beyond the capital', () => {
        const b = obligationBreakdown(withRepaid(104_000));

        expect(b.principalRecovered.toString()).toBe('100000');
        expect(b.interestRealized.toString()).toBe('4000');
        expect(b.interestPending.toString()).toBe('6000');
    });

    it('books the full interest once it is repaid in full', () => {
        const b = obligationBreakdown(withRepaid(110_000));

        expect(b.principalRecovered.toString()).toBe('100000');
        expect(b.principalAtRisk.toString()).toBe('0');
        expect(b.interestRealized.toString()).toBe('10000');
        expect(b.interestPending.toString()).toBe('0');
        expect(b.isCapitalRecovered).toBe(true);
    });
});

describe('obligations that carry no interest', () => {
    it('treats everything settled as capital returning', () => {
        const b = obligationBreakdown({
            totalAmount: d(50_000),
            principalAmount: d(50_000),
            interestAmount: d(0),
            outstandingAmount: d(20_000),
        });

        expect(b.principalRecovered.toString()).toBe('30000');
        expect(b.principalAtRisk.toString()).toBe('20000');
        expect(b.interestRealized.toString()).toBe('0');
        expect(b.interestPending.toString()).toBe('0');
        expect(b.hasInterest).toBe(false);
    });
});

describe('rows that do not add up', () => {
    /*
     * A cancelled obligation is written off for its outstanding balance, and
     * historical rows predate the split entirely. None of that should produce
     * a negative figure that then poisons a SUM across a whole workspace.
     */
    it('never reports more recovered than the capital', () => {
        const b = obligationBreakdown({
            totalAmount: d(110_000),
            principalAmount: d(100_000),
            interestAmount: d(10_000),
            outstandingAmount: d(-5_000),   // over-settled somehow
        });

        expect(b.principalRecovered.toString()).toBe('100000');
        expect(b.interestRealized.toString()).toBe('10000');
        expect(b.interestPending.toString()).toBe('0');
    });

    it('never reports a negative recovery when outstanding exceeds the total', () => {
        const b = obligationBreakdown({
            totalAmount: d(110_000),
            principalAmount: d(100_000),
            interestAmount: d(10_000),
            outstandingAmount: d(200_000),
        });

        expect(b.amountSettled.toString()).toBe('0');
        expect(b.principalRecovered.toString()).toBe('0');
        expect(b.interestRealized.toString()).toBe('0');
        expect(b.principalAtRisk.toString()).toBe('100000');
    });
});

describe('rolling a book of loans into a position', () => {
    it('sums capital at risk and profit earned across obligations', () => {
        const loans = [
            withRepaid(0),          // 100k out, nothing earned
            withRepaid(110_000),    // fully repaid: 10k earned
            withRepaid(105_000),    // capital back, 5k earned so far
        ];

        const position = loans
            .map(obligationBreakdown)
            .reduce(accumulate, emptyPosition());

        expect(position.count).toBe(3);
        expect(position.principalOutstanding.toString()).toBe('100000');
        expect(position.principalRecovered.toString()).toBe('200000');
        expect(position.interestRealized.toString()).toBe('15000');
        expect(position.interestPending.toString()).toBe('15000');
    });

    it('starts from zero', () => {
        const position = emptyPosition();
        expect(position.count).toBe(0);
        expect(position.interestRealized.toString()).toBe('0');
    });
});

describe('payables use the same arithmetic', () => {
    /*
     * Borrowing 100,000 at 10% costs 10,000. The breakdown is identical — what
     * differs is the label, and that belongs to the reporting layer. Negating
     * here would make "realized" read as a reversal rather than a cost.
     */
    it('reports interest incurred once the borrowed capital is repaid', () => {
        const b = obligationBreakdown(withRepaid(107_000));

        expect(b.principalRecovered.toString()).toBe('100000');
        expect(b.interestRealized.toString()).toBe('7000');
        expect(b.interestRealized.isNegative()).toBe(false);
    });
});
