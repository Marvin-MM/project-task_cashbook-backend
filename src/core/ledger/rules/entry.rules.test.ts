/**
 * The regression harness protecting the product's non-negotiable money rules.
 *
 * money.ts is the oracle. For every combination of type, wallet link, charge and
 * obligation, the journal produced by buildEntryJournal must imply exactly the
 * same cashbook and wallet movements that cashbookIncrementPayload and
 * walletBalanceDelta specify. If a posting rule ever drifts from the documented
 * cash semantics, this fails.
 *
 * Pure — no database.
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import {
    cashbookIncrementPayload,
    walletBalanceDelta,
} from '../../finance/money';
import { buildEntryJournal, entryPostingKey, type EntryPostingInput } from './entry.rules';
import type { LedgerRef, LegDraft } from '../ledger.types';

const WORKSPACE = 'w-1';
const CASHBOOK = 'cb-1';
const ENTRY = 'e-1';
const WALLET = 'acc-1';
const ZERO = new Decimal(0);

function baseInput(overrides: Partial<EntryPostingInput> = {}): EntryPostingInput {
    return {
        workspaceId: WORKSPACE,
        cashbookId: CASHBOOK,
        entryId: ENTRY,
        version: 1,
        type: 'INCOME',
        amount: '100',
        description: 'test entry',
        entryDate: new Date('2026-01-15T00:00:00.000Z'),
        currency: 'UGX',
        createdById: 'u-1',
        ...overrides,
    };
}

const amountOf = (leg: LegDraft) => (leg.debit ?? ZERO).sub(leg.credit ?? ZERO);

/** Sum of signed debits on legs whose ref matches the predicate. */
function signedDebitWhere(legs: LegDraft[], match: (ref: LedgerRef) => boolean): Decimal {
    return legs.filter((l) => match(l.ref)).reduce((sum, l) => sum.add(amountOf(l)), ZERO);
}

const isBookCash = (ref: LedgerRef) => ref.kind === 'BOOK_CASH';
const isWallet = (ref: LedgerRef) => ref.kind === 'WALLET';
/** Revenue is always a CATEGORY ref falling back to SALES_REVENUE. */
const isIncomeAccount = (ref: LedgerRef) =>
    ref.kind === 'CATEGORY' && ref.fallback === 'SALES_REVENUE';
const isExpenseAccount = (ref: LedgerRef) =>
    (ref.kind === 'CATEGORY' && ref.fallback === 'GENERAL_EXPENSES') ||
    (ref.kind === 'SYSTEM' && ref.key === 'TRANSACTION_FEES');

/** Drop zero legs, as PostingService does during resolution. */
const liveLegs = (legs: LegDraft[]) => legs.filter((l) => !amountOf(l).isZero());

describe('buildEntryJournal — balance', () => {
    const matrix: Array<{
        type: 'INCOME' | 'EXPENSE';
        amount: string;
        charge: string | null;
        linked: boolean;
        obligation: 'RECEIVABLE' | 'PAYABLE' | null;
    }> = [];

    for (const type of ['INCOME', 'EXPENSE'] as const) {
        for (const amount of ['100', '75.2525']) {
            for (const charge of [null, '5', '0.0075']) {
                for (const linked of [false, true]) {
                    const obligation = type === 'INCOME' ? 'RECEIVABLE' : 'PAYABLE';
                    matrix.push({ type, amount, charge, linked, obligation: null });
                    matrix.push({ type, amount, charge, linked, obligation });
                }
            }
        }
    }

    it.each(matrix)(
        '$type $amount charge=$charge linked=$linked obligation=$obligation balances',
        ({ type, amount, charge, linked, obligation }) => {
            const draft = buildEntryJournal(
                baseInput({
                    type,
                    amount,
                    chargeAmount: charge,
                    accountId: linked ? WALLET : null,
                    obligation: obligation ? { id: 'ob-1', type: obligation } : null,
                }),
            );

            const legs = liveLegs(draft.legs);
            const debits = legs.reduce((s, l) => s.add(l.debit ?? ZERO), ZERO);
            const credits = legs.reduce((s, l) => s.add(l.credit ?? ZERO), ZERO);

            expect(debits.toString()).toBe(credits.toString());
            expect(legs.length).toBeGreaterThan(0);
            for (const leg of legs) {
                expect(Boolean(leg.debit && !leg.debit.isZero()) && Boolean(leg.credit && !leg.credit.isZero())).toBe(false);
                expect((leg.debit ?? ZERO).isNegative()).toBe(false);
                expect((leg.credit ?? ZERO).isNegative()).toBe(false);
            }
        },
    );

    it.each(matrix)(
        '$type $amount charge=$charge linked=$linked obligation=$obligation reproduces money.ts',
        ({ type, amount, charge, linked, obligation }) => {
            const draft = buildEntryJournal(
                baseInput({
                    type,
                    amount,
                    chargeAmount: charge,
                    accountId: linked ? WALLET : null,
                    obligation: obligation ? { id: 'ob-1', type: obligation } : null,
                }),
            );
            const legs = liveLegs(draft.legs);

            const expected = cashbookIncrementPayload(type, amount, charge, linked, 'apply');

            // Cashbook.balance = signed debits on the book-cash account.
            const bookCashDelta = signedDebitWhere(legs, isBookCash);
            expect(bookCashDelta.toString()).toBe(
                (expected.balance?.increment ?? ZERO).toString(),
            );

            // Account.balance = signed debits on the wallet account.
            const walletDelta = signedDebitWhere(legs, isWallet);
            const expectedWallet = linked ? walletBalanceDelta(type, amount, charge) : ZERO;
            expect(walletDelta.toString()).toBe(expectedWallet.toString());

            // totalIncome = signed credits on income-class accounts.
            const incomeDelta = signedDebitWhere(legs, isIncomeAccount).negated();
            expect(incomeDelta.toString()).toBe(
                (expected.totalIncome?.increment ?? ZERO).toString(),
            );

            // totalExpense = signed debits on expense-class accounts.
            const expenseDelta = signedDebitWhere(legs, isExpenseAccount);
            expect(expenseDelta.toString()).toBe(
                (expected.totalExpense?.increment ?? ZERO).toString(),
            );
        },
    );
});

describe('buildEntryJournal — the wallet-link rule', () => {
    it('routes cash to book cash when unlinked and to the wallet when linked', () => {
        const unlinked = liveLegs(buildEntryJournal(baseInput({ accountId: null })).legs);
        const linked = liveLegs(buildEntryJournal(baseInput({ accountId: WALLET })).legs);

        expect(signedDebitWhere(unlinked, isBookCash).toString()).toBe('100');
        expect(signedDebitWhere(unlinked, isWallet).toString()).toBe('0');

        expect(signedDebitWhere(linked, isBookCash).toString()).toBe('0');
        expect(signedDebitWhere(linked, isWallet).toString()).toBe('100');
    });

    it('produces identical income legs whether or not a wallet is linked', () => {
        const unlinked = liveLegs(buildEntryJournal(baseInput({ accountId: null })).legs);
        const linked = liveLegs(buildEntryJournal(baseInput({ accountId: WALLET })).legs);

        // This is why totalIncome/totalExpense are unaffected by linking.
        expect(signedDebitWhere(unlinked, isIncomeAccount).toString()).toBe(
            signedDebitWhere(linked, isIncomeAccount).toString(),
        );
        expect(signedDebitWhere(unlinked, isExpenseAccount).toString()).toBe(
            signedDebitWhere(linked, isExpenseAccount).toString(),
        );
    });
});

describe('buildEntryJournal — obligations', () => {
    it('credits AR and recognizes revenue when settling a receivable', () => {
        const legs = liveLegs(
            buildEntryJournal(
                baseInput({ type: 'INCOME', amount: '400', obligation: { id: 'ob-1', type: 'RECEIVABLE' } }),
            ).legs,
        );

        const ar = signedDebitWhere(legs, (r) => r.kind === 'SYSTEM' && r.key === 'AR');
        const deferred = signedDebitWhere(legs, (r) => r.kind === 'SYSTEM' && r.key === 'DEFERRED_REVENUE');

        expect(ar.toString()).toBe('-400'); // credited
        expect(deferred.toString()).toBe('400'); // debited

        // Income is still recognized in full, so Cashbook.totalIncome is unchanged
        // by whether the entry settles a receivable.
        expect(signedDebitWhere(legs, isIncomeAccount).negated().toString()).toBe('400');
    });

    it('debits AP and recognizes expense when settling a payable', () => {
        const legs = liveLegs(
            buildEntryJournal(
                baseInput({ type: 'EXPENSE', amount: '250', obligation: { id: 'ob-1', type: 'PAYABLE' } }),
            ).legs,
        );

        const ap = signedDebitWhere(legs, (r) => r.kind === 'SYSTEM' && r.key === 'AP');
        const deferred = signedDebitWhere(legs, (r) => r.kind === 'SYSTEM' && r.key === 'DEFERRED_EXPENSE');

        expect(ap.toString()).toBe('250'); // debited
        expect(deferred.toString()).toBe('-250'); // credited
        expect(signedDebitWhere(legs, isExpenseAccount).toString()).toBe('250');
    });

    it('tags the AR/AP legs with the obligation, so aging is a pure ledger query', () => {
        const draft = buildEntryJournal(
            baseInput({ obligation: { id: 'ob-42', type: 'RECEIVABLE' } }),
        );
        const arLeg = draft.legs.find((l) => l.ref.kind === 'SYSTEM' && l.ref.key === 'AR');
        expect(arLeg?.dims?.obligationId).toBe('ob-42');
    });
});

describe('buildEntryJournal — charges', () => {
    it('emits no fee leg when there is no charge', () => {
        const legs = liveLegs(buildEntryJournal(baseInput({ chargeAmount: null })).legs);
        expect(legs.some((l) => l.ref.kind === 'SYSTEM' && l.ref.key === 'TRANSACTION_FEES')).toBe(false);
    });

    it('reduces cash received but not revenue on an income charge', () => {
        const legs = liveLegs(buildEntryJournal(baseInput({ amount: '100', chargeAmount: '5' })).legs);
        expect(signedDebitWhere(legs, isBookCash).toString()).toBe('95');
        expect(signedDebitWhere(legs, isIncomeAccount).negated().toString()).toBe('100');
    });

    it('increases cash paid on an expense charge', () => {
        const legs = liveLegs(
            buildEntryJournal(baseInput({ type: 'EXPENSE', amount: '100', chargeAmount: '5' })).legs,
        );
        expect(signedDebitWhere(legs, isBookCash).toString()).toBe('-105');
    });
});

describe('entryPostingKey', () => {
    it('is deterministic and version-scoped', () => {
        expect(entryPostingKey('abc', 1)).toBe('entry:abc:v1');
        expect(entryPostingKey('abc', 2)).toBe('entry:abc:v2');
    });

    it('is what the draft carries', () => {
        const draft = buildEntryJournal(baseInput({ version: 7 }));
        expect(draft.postingKey).toBe('entry:e-1:v7');
    });
});
