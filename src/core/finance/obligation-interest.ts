/**
 * Splitting what has been repaid into capital recovered and profit earned.
 *
 * Pure — no I/O, no clock. Every figure is derived from four numbers already on
 * the obligation, so this can be called on a list of 500 rows without touching
 * the database, and can be reasoned about without one.
 *
 * ─── Cost recovery, and why ───
 *
 * Repayments pay down PRINCIPAL FIRST. Nothing counts as profit until the
 * capital is fully back.
 *
 * Lend 100,000 at 10% and you are owed 110,000. When 55,000 has come back you
 * have not made 5,000 — you are 45,000 down and hoping. Booking a slice of
 * profit against every instalment reports earnings on money still at risk, and
 * reports them largest exactly when the loan is youngest and least likely to be
 * repaid in full. Recognising nothing until the capital is whole is the
 * conservative reading, and it is the one that matches how a lender actually
 * thinks about the position.
 *
 * The trade-off, stated plainly: a long loan shows zero profit for most of its
 * life and then all of it at the end. That is lumpy, and it is intended — the
 * alternative is smooth profit that is not yet real.
 *
 * ─── The same arithmetic, both directions ───
 *
 * A PAYABLE with interest is money you borrowed: the interest is a cost, not
 * income. The maths is identical, so this module computes one breakdown and
 * leaves the sign convention to the caller. `interestRealized` on a payable is
 * interest you have INCURRED; the reporting layer labels it accordingly rather
 * than negating it here, because a negative "realized" figure reads as a
 * reversal, not an expense.
 */
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from './money';

const ZERO = new Decimal(0);

export interface ObligationAmounts {
    /** principal + interest. What is owed in total. */
    totalAmount: Decimal | string | number;
    principalAmount: Decimal | string | number;
    interestAmount: Decimal | string | number;
    /** What is still owed. total − outstanding is what has been settled. */
    outstandingAmount: Decimal | string | number;
}

export interface ObligationBreakdown {
    /** How much has actually come in (or gone out) so far. */
    amountSettled: Decimal;
    /** Of that, how much was the capital coming back. */
    principalRecovered: Decimal;
    /** Capital still out there. The number that matters while a loan runs. */
    principalAtRisk: Decimal;
    /**
     * Profit earned so far (receivable) or cost incurred so far (payable).
     * Zero until the principal is whole — see the module docstring.
     */
    interestRealized: Decimal;
    /** Interest still to come, if it is repaid in full. */
    interestPending: Decimal;
    /** Whether the capital has been fully recovered. */
    isCapitalRecovered: boolean;
    /** Whether this obligation carries interest at all. */
    hasInterest: boolean;
}

/**
 * Split what has been settled into capital and profit.
 *
 * Safe on obligations that carry no interest — principal equals total, interest
 * is zero, and the breakdown degenerates to "everything settled was capital",
 * which is exactly right.
 *
 * Every figure is clamped into [0, its own ceiling]. A cancelled obligation
 * that was written off, or a row whose outstanding drifted, still produces
 * coherent numbers rather than a negative "recovered" that would poison a SUM
 * across a whole workspace.
 */
export function obligationBreakdown(amounts: ObligationAmounts): ObligationBreakdown {
    const total = toDecimal(amounts.totalAmount);
    const principal = toDecimal(amounts.principalAmount);
    const interest = toDecimal(amounts.interestAmount);
    const outstanding = toDecimal(amounts.outstandingAmount);

    const amountSettled = clamp(total.sub(outstanding), ZERO, total);

    // Principal first. Anything beyond it is profit.
    const principalRecovered = clamp(amountSettled, ZERO, principal);
    const principalAtRisk = principal.sub(principalRecovered);

    const interestRealized = clamp(amountSettled.sub(principal), ZERO, interest);
    const interestPending = interest.sub(interestRealized);

    return {
        amountSettled,
        principalRecovered,
        principalAtRisk,
        interestRealized,
        interestPending,
        isCapitalRecovered: principalAtRisk.isZero(),
        hasInterest: interest.greaterThan(0),
    };
}

/**
 * Resolve what somebody typed into the two figures that get stored.
 *
 * Accepts a rate or a flat amount, never both — offering both and silently
 * preferring one is how a UI ends up charging a number nobody entered. The
 * amount is authoritative once resolved; the rate is kept only so the figure
 * can be shown back the way it was typed.
 *
 * Rounded to 4dp to match the column, and the total is then DERIVED by adding
 * the two rather than rounded separately, so `total = principal + interest`
 * holds exactly — which is what the database CHECK asserts.
 */
export function resolveInterest(input: {
    principalAmount: Decimal | string | number;
    interestRate?: Decimal | string | number | null;
    interestAmount?: Decimal | string | number | null;
}): { principalAmount: Decimal; interestAmount: Decimal; interestRate: Decimal | null; totalAmount: Decimal } {
    const principal = toDecimal(input.principalAmount);

    const hasRate = input.interestRate !== undefined && input.interestRate !== null
        && input.interestRate !== '';
    const hasAmount = input.interestAmount !== undefined && input.interestAmount !== null
        && input.interestAmount !== '';

    let interestAmount = ZERO;
    let interestRate: Decimal | null = null;

    if (hasRate) {
        interestRate = toDecimal(input.interestRate!);
        interestAmount = round(principal.mul(interestRate).div(100));
    } else if (hasAmount) {
        interestAmount = round(toDecimal(input.interestAmount!));
        // Derived for display only, and only when it is meaningful. A flat
        // charge against a zero principal has no percentage to speak of.
        interestRate = principal.greaterThan(0)
            ? round(interestAmount.div(principal).mul(100))
            : null;
    }

    return {
        principalAmount: round(principal),
        interestAmount,
        interestRate,
        totalAmount: round(principal).add(interestAmount),
    };
}

/** Matches the Decimal(20, 4) columns these values land in. */
function round(value: Decimal): Decimal {
    return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

function clamp(value: Decimal, min: Decimal, max: Decimal): Decimal {
    if (value.lessThan(min)) return min;
    if (value.greaterThan(max)) return max;
    return value;
}

/**
 * Roll a set of obligations up into a position.
 *
 * Receivables and payables are kept apart because they are not opposites that
 * should net off: interest earned on money lent and interest owed on money
 * borrowed are two separate facts about a business, and averaging them into one
 * number hides both.
 */
export interface InterestPosition {
    /** Obligations carrying interest. Interest-free ones are counted but not summed. */
    count: number;
    principalOutstanding: Decimal;
    principalRecovered: Decimal;
    interestRealized: Decimal;
    interestPending: Decimal;
}

export function emptyPosition(): InterestPosition {
    return {
        count: 0,
        principalOutstanding: ZERO,
        principalRecovered: ZERO,
        interestRealized: ZERO,
        interestPending: ZERO,
    };
}

export function accumulate(
    position: InterestPosition,
    breakdown: ObligationBreakdown,
): InterestPosition {
    return {
        count: position.count + 1,
        principalOutstanding: position.principalOutstanding.add(breakdown.principalAtRisk),
        principalRecovered: position.principalRecovered.add(breakdown.principalRecovered),
        interestRealized: position.interestRealized.add(breakdown.interestRealized),
        interestPending: position.interestPending.add(breakdown.interestPending),
    };
}
