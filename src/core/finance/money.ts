/**
 * Shared single-entry money math for cashbooks + wallet accounts.
 * Stored balances are caches; these helpers define the source-of-truth formulas.
 */
import { Decimal } from '@prisma/client/runtime/library';

export type MoneyType = 'INCOME' | 'EXPENSE';

export type ObligationStatusValue = 'OPEN' | 'PARTIAL' | 'PAID' | 'CANCELLED';

export type InvoiceStatusValue =
    | 'DRAFT'
    | 'SENT'
    | 'PARTIALLY_PAID'
    | 'PAID'
    | 'OVERDUE'
    | 'VOID';

export function toDecimal(value: Decimal | string | number | null | undefined): Decimal {
    if (value instanceof Decimal) return value;
    if (value === null || value === undefined || value === '') return new Decimal(0);
    return new Decimal(value);
}

/**
 * Net cash movement of a money event.
 * INCOME: amount − charge (fee reduces cash received)
 * EXPENSE: amount + charge (fee increases cash paid)
 */
export function effectiveCashAmount(
    type: MoneyType | string,
    amount: Decimal | string | number,
    chargeAmount?: Decimal | string | number | null,
): Decimal {
    const amt = toDecimal(amount);
    const charge = toDecimal(chargeAmount);
    return type === 'INCOME' ? amt.sub(charge) : amt.add(charge);
}

/**
 * Activity totals deltas for cashbook totalIncome / totalExpense.
 * Charges on income count as expense activity.
 */
export function incomeExpenseDeltas(
    type: MoneyType | string,
    amount: Decimal | string | number,
    chargeAmount?: Decimal | string | number | null,
): { totalIncomeDelta: Decimal; totalExpenseDelta: Decimal } {
    const amt = toDecimal(amount);
    const charge = toDecimal(chargeAmount);

    if (type === 'INCOME') {
        return {
            totalIncomeDelta: amt,
            totalExpenseDelta: charge.greaterThan(0) ? charge : new Decimal(0),
        };
    }

    return {
        totalIncomeDelta: new Decimal(0),
        totalExpenseDelta: amt.add(charge),
    };
}

/** Wallet-linked entries do not move cashbook.balance (unallocated book cash only). */
export function shouldAffectCashbookBalance(hasWalletLink: boolean): boolean {
    return !hasWalletLink;
}

/**
 * Signed delta for cashbook.balance (positive = cash in).
 * Zero when the entry is linked to a wallet account.
 */
export function cashbookBalanceDelta(
    type: MoneyType | string,
    amount: Decimal | string | number,
    chargeAmount: Decimal | string | number | null | undefined,
    hasWalletLink: boolean,
): Decimal {
    if (!shouldAffectCashbookBalance(hasWalletLink)) {
        return new Decimal(0);
    }
    const effective = effectiveCashAmount(type, amount, chargeAmount);
    return type === 'INCOME' ? effective : effective.negated();
}

/** Signed delta for wallet Account.balance (positive = cash in). */
export function walletBalanceDelta(
    type: MoneyType | string,
    amount: Decimal | string | number,
    chargeAmount?: Decimal | string | number | null,
): Decimal {
    const effective = effectiveCashAmount(type, amount, chargeAmount);
    return type === 'INCOME' ? effective : effective.negated();
}

export function obligationStatusFromAmounts(
    totalAmount: Decimal | string | number,
    outstandingAmount: Decimal | string | number,
    currentStatus?: ObligationStatusValue | string | null,
): ObligationStatusValue {
    if (currentStatus === 'CANCELLED') return 'CANCELLED';

    const total = toDecimal(totalAmount);
    const outstanding = toDecimal(outstandingAmount);

    if (outstanding.lessThanOrEqualTo(0)) return 'PAID';
    if (outstanding.equals(total) || outstanding.greaterThan(total)) return 'OPEN';
    return 'PARTIAL';
}

export function invoiceStatusFromOutstanding(
    totalAmount: Decimal | string | number,
    outstandingAmount: Decimal | string | number,
    previousStatus: InvoiceStatusValue | string,
): InvoiceStatusValue {
    if (previousStatus === 'VOID' || previousStatus === 'DRAFT') {
        return previousStatus as InvoiceStatusValue;
    }

    const total = toDecimal(totalAmount);
    const outstanding = toDecimal(outstandingAmount);
    const amountPaid = total.sub(outstanding);

    if (outstanding.lessThanOrEqualTo(0)) return 'PAID';
    if (amountPaid.greaterThan(0)) return 'PARTIALLY_PAID';
    if (previousStatus === 'OVERDUE') return 'OVERDUE';
    return 'SENT';
}

export interface EntryLikeForRecompute {
    type: string;
    amount: Decimal | string | number;
    chargeAmount?: Decimal | string | number | null;
    /** true when a non-voided AccountTransaction links this entry to a wallet */
    hasWalletLink: boolean;
}

/**
 * Recompute cashbook caches from non-deleted entries (source of truth).
 *
 * - totalIncome / totalExpense = full cashbook **activity** (includes wallet-linked rows)
 * - balance = **book cash only** (unallocated entries; wallet-linked rows contribute 0)
 * - bookIncome / bookExpense = activity that actually moved book cash (unallocated only)
 *
 * Never compute book cash as totalIncome − totalExpense when any entry is wallet-linked.
 */
export function recomputeCashbookFromEntries(entries: EntryLikeForRecompute[]): {
    balance: Decimal;
    totalIncome: Decimal;
    totalExpense: Decimal;
    bookIncome: Decimal;
    bookExpense: Decimal;
    walletLinkedCount: number;
    unallocatedCount: number;
} {
    let balance = new Decimal(0);
    let totalIncome = new Decimal(0);
    let totalExpense = new Decimal(0);
    let bookIncome = new Decimal(0);
    let bookExpense = new Decimal(0);
    let walletLinkedCount = 0;
    let unallocatedCount = 0;

    for (const entry of entries) {
        const deltas = incomeExpenseDeltas(entry.type, entry.amount, entry.chargeAmount);
        totalIncome = totalIncome.add(deltas.totalIncomeDelta);
        totalExpense = totalExpense.add(deltas.totalExpenseDelta);

        if (entry.hasWalletLink) {
            walletLinkedCount += 1;
            // Wallet-linked: activity only — no book-cash movement
            continue;
        }

        unallocatedCount += 1;
        bookIncome = bookIncome.add(deltas.totalIncomeDelta);
        bookExpense = bookExpense.add(deltas.totalExpenseDelta);
        balance = balance.add(
            cashbookBalanceDelta(entry.type, entry.amount, entry.chargeAmount, false),
        );
    }

    return {
        balance,
        totalIncome,
        totalExpense,
        bookIncome,
        bookExpense,
        walletLinkedCount,
        unallocatedCount,
    };
}

export interface WalletTxLike {
    type: string;
    amount: Decimal | string | number;
    chargeAmount?: Decimal | string | number | null;
}

export interface WalletTransferLike {
    direction: 'IN' | 'OUT';
    amount: Decimal | string | number;
    /** Fee only reduces source wallet (OUT). */
    feeAmount?: Decimal | string | number | null;
}

/** Recompute wallet balance from non-voided txs + transfers. */
export function recomputeWalletBalance(
    transactions: WalletTxLike[],
    transfers: WalletTransferLike[] = [],
): Decimal {
    let balance = new Decimal(0);

    for (const tx of transactions) {
        balance = balance.add(walletBalanceDelta(tx.type, tx.amount, tx.chargeAmount));
    }

    for (const t of transfers) {
        const amount = toDecimal(t.amount);
        const fee = toDecimal(t.feeAmount);
        if (t.direction === 'IN') {
            balance = balance.add(amount);
        } else {
            balance = balance.sub(amount).sub(fee);
        }
    }

    return balance;
}

/** Prisma-friendly cashbook increment payload for apply or reverse. */
export function cashbookIncrementPayload(
    type: MoneyType | string,
    amount: Decimal | string | number,
    chargeAmount: Decimal | string | number | null | undefined,
    hasWalletLink: boolean,
    mode: 'apply' | 'reverse',
): {
    balance?: { increment: Decimal };
    totalIncome?: { increment: Decimal };
    totalExpense?: { increment: Decimal };
} {
    const sign = mode === 'apply' ? 1 : -1;
    const deltas = incomeExpenseDeltas(type, amount, chargeAmount);
    const bal = cashbookBalanceDelta(type, amount, chargeAmount, hasWalletLink);

    const payload: {
        balance?: { increment: Decimal };
        totalIncome?: { increment: Decimal };
        totalExpense?: { increment: Decimal };
    } = {};

    if (!bal.equals(0)) {
        payload.balance = { increment: bal.mul(sign) };
    }
    if (!deltas.totalIncomeDelta.equals(0)) {
        payload.totalIncome = { increment: deltas.totalIncomeDelta.mul(sign) };
    }
    if (!deltas.totalExpenseDelta.equals(0)) {
        payload.totalExpense = { increment: deltas.totalExpenseDelta.mul(sign) };
    }

    return payload;
}
