/**
 * Lending, end to end.
 *
 * The unit tests in core/finance/obligation-interest.test.ts pin down the
 * arithmetic. These prove the arithmetic survives the real machinery: a
 * receivable created with interest, settled by actual cashbook entries through
 * the actual posting service, still reports the right capital-at-risk and the
 * right profit — and the books still balance while it does.
 *
 * The scenario throughout is the one from the brief: lend 100,000 at 10%,
 * expect 110,000 back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { ObligationsService } from '../../modules/cashbook-obligations/obligations.service';
import { EntriesService } from '../../modules/entries/entries.service';
import {
    createAccount, createCashbook, createUser, createWorkspace,
} from '../factories';
import {
    provisionWorkspaceAccounting, ensureCashbookLedgerAccount, ensureWalletLedgerAccount,
} from '../../core/ledger/coa.seed';

const obligations = () => resolveService(ObligationsService);
const entries = () => resolveService(EntriesService);

async function fixture() {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, workspace.id, 'UGX');
    });

    const book = await createCashbook(workspace.id, owner.id, { name: 'Lending' });
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await ensureCashbookLedgerAccount(tx, {
            id: book.id, workspaceId: workspace.id, name: book.name, currency: 'UGX',
        });
    });

    const wallet = await createAccount(workspace.id, { name: 'Cash', balance: '500000' });
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const full = await tx.account.findUniqueOrThrow({
            where: { id: wallet.id }, include: { accountType: true },
        });
        await ensureWalletLedgerAccount(tx, full, full.accountType.classification);
    });

    return { owner, workspace, book, wallet };
}

/** Lend money out at a rate, as the desk would. */
async function lend(f: Awaited<ReturnType<typeof fixture>>, over: Record<string, unknown> = {}) {
    return obligations().createObligation(f.book.id, f.owner.id, {
        type: 'RECEIVABLE',
        title: 'Loan to Jane',
        principalAmount: '100000',
        interestRate: '10',
        ...over,
    } as any);
}

/** Record a repayment against the loan, through the ordinary entry path. */
async function repay(
    f: Awaited<ReturnType<typeof fixture>>, obligationId: string, amount: string,
) {
    return entries().createEntry(f.book.id, f.owner.id, {
        type: 'INCOME',
        amount,
        description: 'Loan repayment',
        accountId: f.wallet.id,
        obligationId,
        entryDate: new Date().toISOString(),
    } as any);
}

async function readBack(bookId: string, obligationId: string) {
    const result: any = await obligations().getObligation(obligationId, bookId);
    return result.interest;
}

async function trialBalance(): Promise<string> {
    const rows = await testPrisma.journalLine.aggregate({ _sum: { debit: true, credit: true } });
    return new Prisma.Decimal(rows._sum.debit ?? 0).sub(rows._sum.credit ?? 0).toString();
}

describe('creating a loan with interest', () => {
    beforeEach(resetDatabase);

    it('owes principal plus interest, and stores the split', async () => {
        const f = await fixture();
        const loan: any = await lend(f);

        expect(loan.totalAmount.toString()).toBe('110000');
        expect(loan.principalAmount.toString()).toBe('100000');
        expect(loan.interestAmount.toString()).toBe('10000');
        expect(loan.interestRate.toString()).toBe('10');
        // The whole 110,000 is what is chased, not the 100,000.
        expect(loan.outstandingAmount.toString()).toBe('110000');
    });

    it('accepts a flat interest figure instead of a rate', async () => {
        const f = await fixture();
        const loan: any = await lend(f, { interestRate: undefined, interestAmount: '12500' });

        expect(loan.totalAmount.toString()).toBe('112500');
        expect(loan.interestAmount.toString()).toBe('12500');
        expect(loan.interestRate.toString()).toBe('12.5');
    });

    it('leaves an ordinary interest-free obligation exactly as before', async () => {
        const f = await fixture();
        const ob: any = await obligations().createObligation(f.book.id, f.owner.id, {
            type: 'RECEIVABLE', title: 'Unpaid invoice', totalAmount: '50000',
        } as any);

        expect(ob.totalAmount.toString()).toBe('50000');
        expect(ob.principalAmount.toString()).toBe('50000');
        expect(ob.interestAmount.toString()).toBe('0');
        expect(ob.interestRate).toBeNull();
    });

    it('puts the full amount owed on the balance sheet, and stays balanced', async () => {
        const f = await fixture();
        const loan: any = await lend(f);

        // AR carries what is actually owed, interest included.
        const arLines = await testPrisma.journalLine.aggregate({
            where: { obligationId: loan.id, debit: { gt: 0 } },
            _sum: { debit: true },
        });
        expect(arLines._sum.debit!.toString()).toBe('110000');
        expect(await trialBalance()).toBe('0');
    });
});

describe('capital comes back before anything is profit', () => {
    beforeEach(resetDatabase);

    it('reports the whole principal at risk before any repayment', async () => {
        const f = await fixture();
        const loan: any = await lend(f);

        const interest = await readBack(f.book.id, loan.id);
        expect(interest.principalAtRisk).toBe('100000.0000');
        expect(interest.interestRealized).toBe('0.0000');
        expect(interest.isCapitalRecovered).toBe(false);
    });

    it('reports no profit at the half-way point', async () => {
        const f = await fixture();
        const loan: any = await lend(f);
        await repay(f, loan.id, '55000');

        const interest = await readBack(f.book.id, loan.id);
        expect(interest.amountSettled).toBe('55000.0000');
        expect(interest.principalRecovered).toBe('55000.0000');
        expect(interest.principalAtRisk).toBe('45000.0000');
        expect(interest.interestRealized).toBe('0.0000');
        expect(await trialBalance()).toBe('0');
    });

    it('starts booking profit only past the principal', async () => {
        const f = await fixture();
        const loan: any = await lend(f);
        await repay(f, loan.id, '55000');
        await repay(f, loan.id, '49000');   // 104,000 in total

        const interest = await readBack(f.book.id, loan.id);
        expect(interest.principalRecovered).toBe('100000.0000');
        expect(interest.interestRealized).toBe('4000.0000');
        expect(interest.interestPending).toBe('6000.0000');
        expect(interest.isCapitalRecovered).toBe(true);
    });

    it('books the full interest once the loan is repaid in full', async () => {
        const f = await fixture();
        const loan: any = await lend(f);
        await repay(f, loan.id, '110000');

        const interest = await readBack(f.book.id, loan.id);
        expect(interest.principalRecovered).toBe('100000.0000');
        expect(interest.principalAtRisk).toBe('0.0000');
        expect(interest.interestRealized).toBe('10000.0000');
        expect(interest.interestPending).toBe('0.0000');

        const settled = await testPrisma.cashbookObligation.findUniqueOrThrow({
            where: { id: loan.id },
        });
        expect(settled.status).toBe('PAID');
        expect(settled.outstandingAmount.toString()).toBe('0');
        expect(await trialBalance()).toBe('0');
    });

    it('refuses a repayment beyond what is owed, interest included', async () => {
        const f = await fixture();
        const loan: any = await lend(f);

        await expect(repay(f, loan.id, '110001'))
            .rejects.toMatchObject({ code: 'OVERPAYMENT' });
        // And 110,000 exactly is fine — the ceiling is the total, not the principal.
        await expect(repay(f, loan.id, '110000')).resolves.toBeTruthy();
    });
});

describe('the lending position across a book', () => {
    beforeEach(resetDatabase);

    it('separates what was earned from what is still out', async () => {
        const f = await fixture();

        const repaid: any = await lend(f, { title: 'Repaid loan' });
        await repay(f, repaid.id, '110000');

        const running: any = await lend(f, { title: 'Running loan' });
        await repay(f, running.id, '30000');

        await lend(f, { title: 'Untouched loan' });

        const summary: any = await obligations().getInterestSummary(f.book.id);

        expect(summary.receivable.count).toBe(3);
        // 10,000 earned on the one that came back in full; nothing on the others.
        expect(summary.receivable.interestRealized).toBe('10000.0000');
        expect(summary.receivable.interestPending).toBe('20000.0000');
        // 70,000 still out on the running loan + 100,000 untouched.
        expect(summary.receivable.principalOutstanding).toBe('170000.0000');
        expect(summary.receivable.principalRecovered).toBe('130000.0000');
        expect(summary.netInterestRealized).toBe('10000.0000');
    });

    it('keeps interest owed on borrowings apart from interest earned', async () => {
        const f = await fixture();

        const lent: any = await lend(f);
        await repay(f, lent.id, '110000');

        // Borrow 50,000 at 10% and repay it: that 5,000 is a cost, not income.
        const borrowed: any = await obligations().createObligation(f.book.id, f.owner.id, {
            type: 'PAYABLE', title: 'Borrowed from Sam',
            principalAmount: '50000', interestRate: '10',
        } as any);
        await entries().createEntry(f.book.id, f.owner.id, {
            type: 'EXPENSE', amount: '55000', description: 'Repaid Sam',
            accountId: f.wallet.id, obligationId: borrowed.id,
            entryDate: new Date().toISOString(),
        } as any);

        const summary: any = await obligations().getInterestSummary(f.book.id);

        expect(summary.receivable.interestRealized).toBe('10000.0000');
        // Reported as a positive cost incurred, not a negative income.
        expect(summary.payable.interestRealized).toBe('5000.0000');
        expect(summary.netInterestRealized).toBe('5000.0000');
        expect(await trialBalance()).toBe('0');
    });

    it('leaves a cancelled loan out of the position entirely', async () => {
        const f = await fixture();
        const loan: any = await lend(f);

        await obligations().cancelObligation(loan.id, f.book.id, f.owner.id, 'Written off');

        const summary: any = await obligations().getInterestSummary(f.book.id);
        // Counting its interest as "pending" would report income from a debt
        // already given up on.
        expect(summary.receivable.count).toBe(0);
        expect(summary.receivable.interestPending).toBe('0.0000');
        expect(await trialBalance()).toBe('0');
    });
});

describe('the profit a lender actually makes', () => {
    beforeEach(resetDatabase);

    /*
     * The end-to-end claim. Handing over the cash is an EXPENSE entry; the
     * repayment is INCOME for the full 110,000. Gross figures on both sides are
     * inflated by the capital moving in and out — but the NET is exactly the
     * interest, which is the number that matters.
     */
    it('nets out to exactly the interest once the money has gone out and come back', async () => {
        const f = await fixture();

        // Hand over the 100,000.
        await entries().createEntry(f.book.id, f.owner.id, {
            type: 'EXPENSE', amount: '100000', description: 'Lent to Jane',
            accountId: f.wallet.id, entryDate: new Date().toISOString(),
        } as any);

        const loan: any = await lend(f);
        await repay(f, loan.id, '110000');

        const book = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: f.book.id } });
        const netProfit = book.totalIncome.sub(book.totalExpense);

        expect(book.totalExpense.toString()).toBe('100000');
        expect(book.totalIncome.toString()).toBe('110000');
        expect(netProfit.toString()).toBe('10000');

        // And the reported interest agrees with what the books say was made.
        const summary: any = await obligations().getInterestSummary(f.book.id);
        expect(summary.receivable.interestRealized).toBe('10000.0000');
        expect(await trialBalance()).toBe('0');
    });
});
