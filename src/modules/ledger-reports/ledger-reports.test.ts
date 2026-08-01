/**
 * Financial statements against a hand-computed dataset.
 *
 * The numbers below are worked out by hand in the comments so a failure tells
 * you which side of the equation moved, not just that something differs.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { resetDatabase, testPrisma } from '../../test/setup';
import { resolveService } from '../../test/container';
import { createUser, createWorkspace, createCashbook, isoDate } from '../../test/factories';
import { EntriesService } from '../entries/entries.service';
import { ObligationsService } from '../cashbook-obligations/obligations.service';
import { AccountsService } from '../accounts/accounts.service';
import { LedgerReportsService } from './ledger-reports.service';
import { provisionWorkspaceAccounting, ensureCashbookLedgerAccount } from '../../core/ledger/coa.seed';

const reports = () => resolveService(LedgerReportsService);
const entries = () => resolveService(EntriesService);
const obligations = () => resolveService(ObligationsService);
const accounts = () => resolveService(AccountsService);

const PERIOD = {
    from: new Date('2026-01-01T00:00:00.000Z'),
    to: new Date('2026-12-31T00:00:00.000Z'),
};
const AS_OF = new Date('2026-12-31T00:00:00.000Z');
const ENTRY_DATE = isoDate(new Date('2026-06-15T00:00:00.000Z'));

interface Scenario {
    workspaceId: string;
    userId: string;
    bookA: string;
    bookB: string;
    walletId: string;
}

/**
 * A deliberately mixed workspace:
 *   Wallet opening balance      1000  (Dr wallet / Cr opening equity)
 *   Book A: income  500 unlinked      (Dr book cash / Cr revenue)
 *   Book A: expense 200 unlinked      (Dr expense   / Cr book cash)
 *   Book B: income  300 to wallet     (Dr wallet    / Cr revenue)
 *   Receivable 400 opened             (Dr AR / Cr deferred revenue)
 *   Receivable settled 250 unlinked   (Dr book cash / Cr AR, Dr deferred / Cr revenue)
 */
async function buildScenario(): Promise<Scenario> {
    const user = await createUser();
    const workspace = await createWorkspace(user.id);

    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, workspace.id, 'UGX');
    });

    const bookA = await createCashbook(workspace.id, user.id, { name: 'Book A' });
    const bookB = await createCashbook(workspace.id, user.id, { name: 'Book B' });

    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        for (const cb of [bookA, bookB]) {
            await ensureCashbookLedgerAccount(tx, {
                id: cb.id, workspaceId: workspace.id, name: cb.name, currency: 'UGX',
            });
        }
    });

    const bankType = await testPrisma.accountType.findFirstOrThrow({
        where: { workspaceId: workspace.id, name: 'Bank' },
    });
    const wallet = await accounts().createAccount(workspace.id, user.id, {
        name: 'Bank', accountTypeId: bankType.id, initialBalance: '1000',
    } as never);

    await entries().createEntry(bookA.id, user.id, {
        type: 'INCOME', amount: '500', description: 'A income', entryDate: ENTRY_DATE,
    } as never);
    await entries().createEntry(bookA.id, user.id, {
        type: 'EXPENSE', amount: '200', description: 'A expense', entryDate: ENTRY_DATE,
    } as never);
    await entries().createEntry(bookB.id, user.id, {
        type: 'INCOME', amount: '300', description: 'B income to wallet', entryDate: ENTRY_DATE,
        accountId: wallet.id,
    } as never);

    const contact = await testPrisma.contact.create({
        data: { workspaceId: workspace.id, name: 'Customer', type: 'CUSTOMER' },
    });
    const obligation = await obligations().createObligation(bookA.id, user.id, {
        type: 'RECEIVABLE', title: 'Invoice 1', totalAmount: '400', contactId: contact.id,
        dueDate: new Date('2026-03-01T00:00:00.000Z').toISOString(),
    } as never);
    await entries().createEntry(bookA.id, user.id, {
        type: 'INCOME', amount: '250', description: 'partial payment', entryDate: ENTRY_DATE,
        obligationId: obligation.id, contactId: contact.id,
    } as never);

    return {
        workspaceId: workspace.id,
        userId: user.id,
        bookA: bookA.id,
        bookB: bookB.id,
        walletId: wallet.id,
    };
}

let scenario: Scenario;

describe('ledger reports', () => {
    beforeEach(async () => {
        await resetDatabase();
        scenario = await buildScenario();
    });

    describe('trial balance', () => {
        it('has equal debit and credit columns', async () => {
            const report = await reports().trialBalance(scenario.workspaceId, AS_OF);
            const scoped = report.byCurrency[0];

            expect(scoped.currency).toBe('UGX');
            expect(scoped.sections.totals.debit).toBe(scoped.sections.totals.credit);
            expect(scoped.outOfBalance).toBe('0.0000');
        });

        it('includes both cash and accrual-offset accounts', async () => {
            const report = await reports().trialBalance(scenario.workspaceId, AS_OF);
            const codes = report.byCurrency[0].sections.accounts.map((a) => a.code);

            expect(codes).toContain('1200'); // Accounts Receivable
            expect(codes).toContain('2400'); // Deferred Revenue
            expect(codes).toContain('3100'); // Opening Balance Equity
        });
    });

    describe('balance sheet', () => {
        it('balances: assets = liabilities + equity', async () => {
            const report = await reports().balanceSheet(scenario.workspaceId, AS_OF, PERIOD.from);
            const scoped = report.byCurrency[0];

            expect(scoped.outOfBalance).toBe('0.0000');
        });

        it('shows the receivable as an asset with a matching deferred-revenue offset', async () => {
            const report = await reports().balanceSheet(scenario.workspaceId, AS_OF, PERIOD.from);
            const { assets, liabilities } = report.byCurrency[0].sections;

            // 400 opened, 250 settled -> 150 outstanding.
            const ar = assets.find((a) => a.code === '1200');
            expect(ar?.amount).toBe('150.0000');

            // Deferred revenue mirrors it: 400 credited, 250 recognized.
            const deferred = liabilities.find((l) => l.code === '2400');
            expect(deferred?.amount).toBe('150.0000');
        });

        it('reports cash positions per account', async () => {
            const report = await reports().balanceSheet(scenario.workspaceId, AS_OF, PERIOD.from);
            const { assets } = report.byCurrency[0].sections;

            // Wallet: 1000 opening + 300 income = 1300
            const wallet = assets.find((a) => a.name === 'Bank');
            expect(wallet?.amount).toBe('1300.0000');

            // Book A cash: +500 income − 200 expense + 250 settlement = 550
            const bookACash = assets.find((a) => a.name.startsWith('Book A'));
            expect(bookACash?.amount).toBe('550.0000');
        });

        it('carries current-period earnings so the sheet balances before year-end close', async () => {
            const report = await reports().balanceSheet(scenario.workspaceId, AS_OF, PERIOD.from);
            // Income 500 + 300 + 250 = 1050; expenses 200. Net 850.
            expect(report.byCurrency[0].sections.currentPeriodEarnings).toBe('850.0000');
        });
    });

    describe('income statement', () => {
        it('produces per-book and consolidated figures in one call', async () => {
            const report = await reports().incomeStatement(scenario.workspaceId, PERIOD);
            const { books, consolidated } = report.byCurrency[0].sections;

            const bookA = books.find((b) => b.cashbookId === scenario.bookA);
            const bookB = books.find((b) => b.cashbookId === scenario.bookB);

            // Book A: income 500 + 250 settlement = 750; expenses 200.
            expect(bookA?.totals.income).toBe('750.0000');
            expect(bookA?.totals.expenses).toBe('200.0000');
            expect(bookA?.totals.net).toBe('550.0000');

            // Book B: 300 income, no expenses.
            expect(bookB?.totals.income).toBe('300.0000');

            expect(consolidated.totals.income).toBe('1050.0000');
            expect(consolidated.totals.expenses).toBe('200.0000');
            expect(consolidated.totals.net).toBe('850.0000');
        });

        it('agrees with the cashbook totals the UI already shows', async () => {
            const report = await reports().incomeStatement(scenario.workspaceId, PERIOD);
            const bookA = report.byCurrency[0].sections.books.find(
                (b) => b.cashbookId === scenario.bookA,
            );
            const cashbook = await testPrisma.cashbook.findUniqueOrThrow({
                where: { id: scenario.bookA },
            });

            // The whole point of the deferred-revenue design: these must match.
            expect(new Decimal(bookA!.totals.income).toString()).toBe(cashbook.totalIncome.toString());
            expect(new Decimal(bookA!.totals.expenses).toString()).toBe(cashbook.totalExpense.toString());
        });

        it('can be scoped to a single book', async () => {
            const report = await reports().incomeStatement(scenario.workspaceId, PERIOD, scenario.bookB);
            const { books } = report.byCurrency[0].sections;

            expect(books).toHaveLength(1);
            expect(books[0].cashbookId).toBe(scenario.bookB);
        });
    });

    describe('general ledger', () => {
        it('produces a running balance ending at the account balance', async () => {
            const wallet = await testPrisma.account.findUniqueOrThrow({
                where: { id: scenario.walletId },
            });

            const gl = await reports().generalLedger(
                scenario.workspaceId,
                wallet.ledgerAccountId!,
                PERIOD,
            );

            expect(gl.lines.length).toBeGreaterThan(0);
            expect(gl.closingBalance).toBe('1300.0000');
            expect(gl.lines[gl.lines.length - 1].runningBalance).toBe('1300.0000');
        });
    });

    describe('cash flow', () => {
        it('reconciles against the actual movement on cash accounts', async () => {
            const report = await reports().cashFlow(scenario.workspaceId, PERIOD);
            expect(report.byCurrency[0].outOfBalance).toBe('0.0000');
        });

        it('nets transfers to zero because both legs are cash', async () => {
            const bankType = await testPrisma.accountType.findFirstOrThrow({
                where: { workspaceId: scenario.workspaceId, name: 'Cash' },
            });
            const second = await accounts().createAccount(scenario.workspaceId, scenario.userId, {
                name: 'Petty Cash', accountTypeId: bankType.id, initialBalance: '0',
            } as never);

            const before = await reports().cashFlow(scenario.workspaceId, PERIOD);
            const beforeTotal = before.byCurrency[0].sections.netCashMovement;

            await accounts().transferBetweenAccounts(scenario.workspaceId, scenario.userId, {
                fromAccountId: scenario.walletId,
                toAccountId: second.id,
                amount: '100',
                description: 'shuffle',
            } as never);

            const after = await reports().cashFlow(scenario.workspaceId, PERIOD);
            // A fee-free transfer moves no cash in or out of the business.
            expect(after.byCurrency[0].sections.netCashMovement).toBe(beforeTotal);
            expect(after.byCurrency[0].outOfBalance).toBe('0.0000');
        });
    });

    describe('AR aging', () => {
        it('reports the outstanding receivable and agrees with the control account', async () => {
            const aging = await reports().aging(scenario.workspaceId, 'RECEIVABLE', AS_OF);

            expect(aging.totals.total).toBe('150.0000');
            // Zero unless a settlement path skipped a posting.
            expect(aging.controlVariance).toBe('0.0000');
        });

        it('buckets by how overdue the obligation is', async () => {
            const aging = await reports().aging(scenario.workspaceId, 'RECEIVABLE', AS_OF);
            const item = aging.items[0];

            // Due 2026-03-01, as-of 2026-12-31 → well past 90 days.
            expect(item.bucket).toBe('90+ days');
            expect(item.contact?.name).toBe('Customer');
        });
    });
});
