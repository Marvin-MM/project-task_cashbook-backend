/**
 * Lightweight self-test for finance helpers (no test runner required).
 * Run: npx tsx src/core/finance/money.selftest.ts
 */
import { Decimal } from '@prisma/client/runtime/library';
import {
    cashbookBalanceDelta,
    effectiveCashAmount,
    incomeExpenseDeltas,
    invoiceStatusFromOutstanding,
    obligationStatusFromAmounts,
    recomputeCashbookFromEntries,
    recomputeWalletBalance,
    walletBalanceDelta,
} from './money';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function eq(a: Decimal, b: string | number, msg: string) {
    assert(a.equals(new Decimal(b)), `${msg}: expected ${b}, got ${a.toString()}`);
}

// effective cash
eq(effectiveCashAmount('INCOME', '100', '5'), '95', 'income with charge');
eq(effectiveCashAmount('EXPENSE', '100', '5'), '105', 'expense with charge');
eq(effectiveCashAmount('INCOME', '100', null), '100', 'income no charge');

// activity deltas
{
    const d = incomeExpenseDeltas('INCOME', '100', '5');
    eq(d.totalIncomeDelta, '100', 'income total');
    eq(d.totalExpenseDelta, '5', 'income charge as expense');
}
{
    const d = incomeExpenseDeltas('EXPENSE', '100', '5');
    eq(d.totalIncomeDelta, '0', 'expense income delta');
    eq(d.totalExpenseDelta, '105', 'expense total');
}

// cashbook balance: unlinked vs linked
eq(cashbookBalanceDelta('INCOME', '100', '5', false), '95', 'unlinked income balance');
eq(cashbookBalanceDelta('EXPENSE', '100', '5', false), '-105', 'unlinked expense balance');
eq(cashbookBalanceDelta('INCOME', '100', '5', true), '0', 'linked income no cashbook bal');

// wallet
eq(walletBalanceDelta('INCOME', '100', '5'), '95', 'wallet income');
eq(walletBalanceDelta('EXPENSE', '100', '5'), '-105', 'wallet expense');

// reverse + reapply nets zero on cashbook recompute
{
    const afterCreate = recomputeCashbookFromEntries([
        { type: 'INCOME', amount: '200', chargeAmount: '10', hasWalletLink: false },
        { type: 'EXPENSE', amount: '50', chargeAmount: null, hasWalletLink: false },
        { type: 'INCOME', amount: '30', chargeAmount: null, hasWalletLink: true }, // wallet-only cash
    ]);
    eq(afterCreate.totalIncome, '230', 'recompute activity income (includes wallet)');
    eq(afterCreate.totalExpense, '60', 'recompute activity expense (50+10)');
    eq(afterCreate.balance, '140', 'recompute book cash (190-50, wallet excluded)'); // 200-10 - 50
    eq(afterCreate.bookIncome, '200', 'book-only income excludes wallet 30');
    eq(afterCreate.bookExpense, '60', 'book-only expense');
    assert(afterCreate.walletLinkedCount === 1, 'wallet linked count');
    assert(afterCreate.unallocatedCount === 2, 'unallocated count');
    // Critical: book cash must NOT equal full activity income − expense when wallets exist
    const activityNet = afterCreate.totalIncome.sub(afterCreate.totalExpense); // 170
    assert(!afterCreate.balance.equals(activityNet), 'book cash ≠ activity net when wallet-linked');
}

// wallet recompute with transfer
{
    const bal = recomputeWalletBalance(
        [{ type: 'INCOME', amount: '1000', chargeAmount: null }],
        [
            { direction: 'OUT', amount: '200', feeAmount: '5' },
            { direction: 'IN', amount: '50' },
        ],
    );
    eq(bal, '845', 'wallet with transfers'); // 1000 - 200 - 5 + 50
}

// obligation status
assert(obligationStatusFromAmounts('100', '100') === 'OPEN', 'open');
assert(obligationStatusFromAmounts('100', '40') === 'PARTIAL', 'partial');
assert(obligationStatusFromAmounts('100', '0') === 'PAID', 'paid');
assert(obligationStatusFromAmounts('100', '0', 'CANCELLED') === 'CANCELLED', 'cancelled sticky');

// invoice status
assert(invoiceStatusFromOutstanding('100', '0', 'SENT') === 'PAID', 'inv paid');
assert(invoiceStatusFromOutstanding('100', '40', 'SENT') === 'PARTIALLY_PAID', 'inv partial');
assert(invoiceStatusFromOutstanding('100', '100', 'OVERDUE') === 'OVERDUE', 'inv overdue keep');
assert(invoiceStatusFromOutstanding('100', '0', 'VOID') === 'VOID', 'void sticky');

console.log('finance self-test: OK');
