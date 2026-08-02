/**
 * Net worth, and the sign convention that makes it easy to get backwards.
 *
 * `Account.balance` is `Σ(debit − credit)` on that wallet's ledger account —
 * the identity documented at the top of posting.service.ts. Assets are
 * debit-normal, so they carry a POSITIVE balance. Liabilities are credit-normal,
 * so they carry a NEGATIVE one: owing 20,000 is a balance of −20,000.
 *
 * That makes `assets − liabilities` wrong, because the minus is applied to a
 * number that is already negative. With 15,000 held and 20,000 owed it computes
 * 15,000 − (−20,000) = 35,000, reporting a business as solvent by 35k when it is
 * actually 5k in the hole — the sign of the answer is inverted at exactly the
 * moment it matters most.
 *
 * The API therefore reports `liabilities` as a POSITIVE magnitude ("you owe
 * 20,000", which is also what anyone reading a balance sheet expects) and
 * computes net worth by ADDING the signed balance.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountClassification } from '@prisma/client';
import { resetDatabase } from '../setup';
import { resolveService } from '../container';
import { AccountsService } from '../../modules/accounts/accounts.service';
import { createAccount, createUser, createWorkspace } from '../factories';

const service = () => resolveService(AccountsService);

async function fixture() {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    return { owner, workspace };
}

/** The single currency bucket, which is all these fixtures produce. */
async function netWorthOf(workspaceId: string) {
    const result = await service().calculateNetWorth(workspaceId);
    return result.currencies[0];
}

beforeEach(async () => {
    await resetDatabase();
});

describe('a business that owes more than it holds', () => {
    it('reports a NEGATIVE net worth, not an inflated positive one', async () => {
        // The exact case: 15,000 in the bank, 20,000 owed.
        const f = await fixture();
        await createAccount(f.workspace.id, {
            name: 'Bank', balance: '15000', classification: AccountClassification.ASSET,
        });
        await createAccount(f.workspace.id, {
            name: 'Loan', balance: '-20000', classification: AccountClassification.LIABILITY,
            allowNegative: true,
        });

        const totals = await netWorthOf(f.workspace.id);

        expect(totals.netWorth).toBe('-5000');
        // The bug this pins: assets − (−20000) = 35000.
        expect(totals.netWorth).not.toBe('35000');
    });

    it('reports what is owed as a positive magnitude', async () => {
        // "Liabilities: −20,000" reads as a credit, not a debt. Every balance
        // sheet in the world prints the amount owed as a positive number.
        const f = await fixture();
        await createAccount(f.workspace.id, {
            name: 'Loan', balance: '-20000', classification: AccountClassification.LIABILITY,
            allowNegative: true,
        });

        const totals = await netWorthOf(f.workspace.id);

        expect(totals.liabilities).toBe('20000');
        expect(totals.assets).toBe('0');
    });
});

describe('a solvent business', () => {
    it('nets the two correctly', async () => {
        const f = await fixture();
        await createAccount(f.workspace.id, {
            name: 'Bank', balance: '100000', classification: AccountClassification.ASSET,
        });
        await createAccount(f.workspace.id, {
            name: 'Card', balance: '-30000', classification: AccountClassification.LIABILITY,
            allowNegative: true,
        });

        const totals = await netWorthOf(f.workspace.id);

        expect(totals.assets).toBe('100000');
        expect(totals.liabilities).toBe('30000');
        expect(totals.netWorth).toBe('70000');
    });

    it('equals total assets when nothing is owed', async () => {
        const f = await fixture();
        await createAccount(f.workspace.id, {
            name: 'Till', balance: '4200', classification: AccountClassification.ASSET,
        });

        const totals = await netWorthOf(f.workspace.id);

        expect(totals.netWorth).toBe('4200');
        expect(totals.liabilities).toBe('0');
    });
});

describe('the identity holds whatever the signs are', () => {
    it('keeps netWorth = assets − liabilities as reported', async () => {
        // Whatever the internal convention, the three numbers the client is
        // handed must be arithmetically consistent with each other — otherwise
        // a reader who checks the subtraction finds it does not add up.
        const f = await fixture();
        await createAccount(f.workspace.id, {
            name: 'Bank', balance: '15000', classification: AccountClassification.ASSET,
        });
        await createAccount(f.workspace.id, {
            name: 'Loan', balance: '-20000', classification: AccountClassification.LIABILITY,
            allowNegative: true,
        });

        const totals = await netWorthOf(f.workspace.id);

        expect(Number(totals.netWorth)).toBe(Number(totals.assets) - Number(totals.liabilities));
    });

    it('handles an overpaid liability, which really is a debit balance', async () => {
        // Overpay a card and it becomes an asset in substance. The magnitude
        // flips sign, and net worth must follow rather than double-count.
        const f = await fixture();
        await createAccount(f.workspace.id, {
            name: 'Card', balance: '500', classification: AccountClassification.LIABILITY,
        });

        const totals = await netWorthOf(f.workspace.id);

        expect(totals.liabilities).toBe('-500');
        expect(totals.netWorth).toBe('500');
        expect(Number(totals.netWorth)).toBe(Number(totals.assets) - Number(totals.liabilities));
    });
});
