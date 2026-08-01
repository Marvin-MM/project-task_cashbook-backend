/**
 * Chart of accounts, manual journals and period close.
 *
 * These are the accountant's controls: the ability to record anything the app's
 * workflows don't model, and the ability to declare a period final.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { resetDatabase, testPrisma } from '../../test/setup';
import { resolveService } from '../../test/container';
import { createUser, createWorkspace, createCashbook, isoDate } from '../../test/factories';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { EntriesService } from '../entries/entries.service';
import { LedgerIntegrityService } from '../../core/ledger/integrity.service';
import { LedgerReportsService } from '../ledger-reports/ledger-reports.service';
import { provisionWorkspaceAccounting, ensureCashbookLedgerAccount } from '../../core/ledger/coa.seed';

const coa = () => resolveService(ChartOfAccountsService);
const entries = () => resolveService(EntriesService);
const integrity = () => resolveService(LedgerIntegrityService);
const reports = () => resolveService(LedgerReportsService);

async function fixture() {
    const user = await createUser();
    const workspace = await createWorkspace(user.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, workspace.id, 'UGX');
    });
    const cashbook = await createCashbook(workspace.id, user.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await ensureCashbookLedgerAccount(tx, {
            id: cashbook.id, workspaceId: workspace.id, name: cashbook.name, currency: 'UGX',
        });
    });
    return { user, workspace, cashbook };
}

async function systemAccount(workspaceId: string, systemKey: string) {
    return testPrisma.ledgerAccount.findUniqueOrThrow({
        where: { workspaceId_systemKey_currency: { workspaceId, systemKey, currency: 'UGX' } },
    });
}

describe('chart of accounts', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('is seeded with the full five-class structure', async () => {
        const { workspace } = await fixture();
        const accounts = await coa().list(workspace.id);

        const classes = new Set(accounts.map((a) => a.class));
        expect([...classes].sort()).toEqual(['ASSET', 'EQUITY', 'EXPENSE', 'INCOME', 'LIABILITY']);

        // The classification the old AccountClassification enum lacked entirely.
        expect(accounts.some((a) => a.class === 'EQUITY')).toBe(true);
    });

    it('lets an accountant add a custom expense account', async () => {
        const { workspace, user } = await fixture();

        const created = await coa().create(workspace.id, user.id, {
            code: '5250',
            name: 'Marketing',
            class: 'EXPENSE',
            isCashEquivalent: false,
            isPostable: true,
        } as never);

        expect(created.normalBalance).toBe('DEBIT');
        expect(created.isProtected).toBe(false);
    });

    it('rejects a duplicate account code', async () => {
        const { workspace, user } = await fixture();
        await expect(
            coa().create(workspace.id, user.id, {
                code: '4100', name: 'Clashing', class: 'INCOME',
                isCashEquivalent: false, isPostable: true,
            } as never),
        ).rejects.toThrow(/already exists/i);
    });

    it('refuses to nest an account under a parent of a different class', async () => {
        const { workspace, user } = await fixture();
        const assets = await testPrisma.ledgerAccount.findUniqueOrThrow({
            where: { workspaceId_code: { workspaceId: workspace.id, code: '1000' } },
        });

        await expect(
            coa().create(workspace.id, user.id, {
                code: '9999', name: 'Wrong nest', class: 'INCOME', parentId: assets.id,
                isCashEquivalent: false, isPostable: true,
            } as never),
        ).rejects.toThrow(/cannot sit under/i);
    });

    it('protects system accounts from being re-coded or re-classed', async () => {
        const { workspace, user } = await fixture();
        const ar = await systemAccount(workspace.id, 'AR');

        await expect(
            coa().update(ar.id, workspace.id, user.id, { code: '9000' } as never),
        ).rejects.toThrow(/cannot be re-coded/i);

        await expect(
            coa().update(ar.id, workspace.id, user.id, { class: 'EXPENSE' } as never),
        ).rejects.toThrow(/cannot change classification/i);

        // Renaming is allowed — some businesses call it "Debtors".
        const renamed = await coa().update(ar.id, workspace.id, user.id, {
            name: 'Debtors',
        } as never);
        expect(renamed.name).toBe('Debtors');
    });

    it('refuses to reclassify an account that already carries postings', async () => {
        const { workspace, user, cashbook } = await fixture();

        await entries().createEntry(cashbook.id, user.id, {
            type: 'INCOME', amount: '100', description: 'sale', entryDate: isoDate(),
        } as never);

        const custom = await coa().create(workspace.id, user.id, {
            code: '4150', name: 'Consulting', class: 'INCOME',
            isCashEquivalent: false, isPostable: true,
        } as never);

        await coa().postManualJournal(workspace.id, user.id, {
            description: 'seed a posting',
            entryDate: isoDate(),
            lines: [
                { ledgerAccountId: (await systemAccount(workspace.id, 'SUSPENSE')).id, debit: '50' },
                { ledgerAccountId: custom.id, credit: '50' },
            ],
        } as never);

        await expect(
            coa().update(custom.id, workspace.id, user.id, { class: 'EXPENSE' } as never),
        ).rejects.toThrow(/would restate every report/i);
    });

    it('maps a category to a GL account and posts entries there', async () => {
        const { workspace, user, cashbook } = await fixture();

        const marketing = await coa().create(workspace.id, user.id, {
            code: '5250', name: 'Marketing', class: 'EXPENSE',
            isCashEquivalent: false, isPostable: true,
        } as never);

        const category = await testPrisma.category.create({
            data: { workspaceId: workspace.id, name: 'Advertising' },
        });
        await coa().mapCategory(workspace.id, category.id, marketing.id, user.id);

        await entries().createEntry(cashbook.id, user.id, {
            type: 'EXPENSE', amount: '300', description: 'billboard', entryDate: isoDate(),
            categoryId: category.id,
        } as never);

        const [row] = await testPrisma.$queryRaw<Array<{ net: Decimal }>>`
            SELECT COALESCE(SUM(debit - credit), 0) AS net
            FROM journal_lines WHERE ledger_account_id = ${marketing.id}::uuid
        `;
        // The mapped account received it instead of General Expenses.
        expect(new Decimal(row.net).toString()).toBe('300');
    });

    it('falls back to the default account for unmapped categories', async () => {
        const { workspace, user, cashbook } = await fixture();
        const category = await testPrisma.category.create({
            data: { workspaceId: workspace.id, name: 'Unmapped' },
        });

        await entries().createEntry(cashbook.id, user.id, {
            type: 'EXPENSE', amount: '120', description: 'misc', entryDate: isoDate(),
            categoryId: category.id,
        } as never);

        const general = await systemAccount(workspace.id, 'GENERAL_EXPENSES');
        const [row] = await testPrisma.$queryRaw<Array<{ net: Decimal }>>`
            SELECT COALESCE(SUM(debit - credit), 0) AS net
            FROM journal_lines WHERE ledger_account_id = ${general.id}::uuid
        `;
        expect(new Decimal(row.net).toString()).toBe('120');
    });

    it('refuses to map a category to a balance-sheet account', async () => {
        const { workspace, user } = await fixture();
        const ar = await systemAccount(workspace.id, 'AR');
        const category = await testPrisma.category.create({
            data: { workspaceId: workspace.id, name: 'Bad map' },
        });

        await expect(
            coa().mapCategory(workspace.id, category.id, ar.id, user.id),
        ).rejects.toThrow(/only map to income or expense/i);
    });
});

describe('manual journals', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('posts a balanced journal and keeps the trial balance at zero', async () => {
        const { workspace, user } = await fixture();
        const suspense = await systemAccount(workspace.id, 'SUSPENSE');
        const equity = await systemAccount(workspace.id, 'OWNER_DRAWINGS');

        const posted = await coa().postManualJournal(workspace.id, user.id, {
            description: 'Owner drawing',
            entryDate: isoDate(),
            lines: [
                { ledgerAccountId: equity.id, debit: '500' },
                { ledgerAccountId: suspense.id, credit: '500' },
            ],
        } as never);

        expect(posted.lineCount).toBe(2);
        expect(posted.totalDebit.toString()).toBe('500');

        const report = await integrity().verifyWorkspace(workspace.id);
        expect(report.ok).toBe(true);
    });

    it('rejects an unbalanced journal', async () => {
        const { workspace, user } = await fixture();
        const suspense = await systemAccount(workspace.id, 'SUSPENSE');
        const equity = await systemAccount(workspace.id, 'OWNER_DRAWINGS');

        await expect(
            coa().postManualJournal(workspace.id, user.id, {
                description: 'Lopsided',
                entryDate: isoDate(),
                lines: [
                    { ledgerAccountId: equity.id, debit: '500' },
                    { ledgerAccountId: suspense.id, credit: '400' },
                ],
            } as never),
        ).rejects.toThrow(/does not balance/i);

        expect(await testPrisma.journalEntry.count({ where: { workspaceId: workspace.id } })).toBe(0);
    });

    it('refuses to post to a roll-up parent account', async () => {
        const { workspace, user } = await fixture();
        const parent = await testPrisma.ledgerAccount.findUniqueOrThrow({
            where: { workspaceId_code: { workspaceId: workspace.id, code: '1000' } },
        });
        const suspense = await systemAccount(workspace.id, 'SUSPENSE');

        await expect(
            coa().postManualJournal(workspace.id, user.id, {
                description: 'To a parent',
                entryDate: isoDate(),
                lines: [
                    { ledgerAccountId: parent.id, debit: '100' },
                    { ledgerAccountId: suspense.id, credit: '100' },
                ],
            } as never),
        ).rejects.toThrow(/cannot be posted to/i);
    });

    it('rejects a duplicate reference so a retry cannot double-post', async () => {
        const { workspace, user } = await fixture();
        const suspense = await systemAccount(workspace.id, 'SUSPENSE');
        const equity = await systemAccount(workspace.id, 'OWNER_DRAWINGS');
        const lines = [
            { ledgerAccountId: equity.id, debit: '100' },
            { ledgerAccountId: suspense.id, credit: '100' },
        ];

        await coa().postManualJournal(workspace.id, user.id, {
            description: 'Accrual', entryDate: isoDate(), reference: 'ACC-2026-01', lines,
        } as never);

        await expect(
            coa().postManualJournal(workspace.id, user.id, {
                description: 'Accrual', entryDate: isoDate(), reference: 'ACC-2026-01', lines,
            } as never),
        ).rejects.toThrow(/already exists/i);

        expect(await testPrisma.journalEntry.count({ where: { workspaceId: workspace.id } })).toBe(1);
    });

    it('reverses a manual journal rather than deleting it', async () => {
        const { workspace, user } = await fixture();
        const suspense = await systemAccount(workspace.id, 'SUSPENSE');
        const equity = await systemAccount(workspace.id, 'OWNER_DRAWINGS');

        const posted = await coa().postManualJournal(workspace.id, user.id, {
            description: 'To undo',
            entryDate: isoDate(),
            lines: [
                { ledgerAccountId: equity.id, debit: '250' },
                { ledgerAccountId: suspense.id, credit: '250' },
            ],
        } as never);

        await coa().reverseJournal(workspace.id, posted.id, user.id, 'entered in error');

        const journals = await testPrisma.journalEntry.findMany({
            where: { workspaceId: workspace.id },
            orderBy: { seq: 'asc' },
        });
        expect(journals).toHaveLength(2);
        expect(journals[0].status).toBe('REVERSED');
        expect(journals[1].status).toBe('REVERSING');

        // Net effect on the account is zero.
        const [row] = await testPrisma.$queryRaw<Array<{ net: Decimal }>>`
            SELECT COALESCE(SUM(debit - credit), 0) AS net
            FROM journal_lines WHERE ledger_account_id = ${equity.id}::uuid
        `;
        expect(new Decimal(row.net).toString()).toBe('0');
    });

    it('will not reverse the same journal twice', async () => {
        const { workspace, user } = await fixture();
        const suspense = await systemAccount(workspace.id, 'SUSPENSE');
        const equity = await systemAccount(workspace.id, 'OWNER_DRAWINGS');

        const posted = await coa().postManualJournal(workspace.id, user.id, {
            description: 'Once only',
            entryDate: isoDate(),
            lines: [
                { ledgerAccountId: equity.id, debit: '10' },
                { ledgerAccountId: suspense.id, credit: '10' },
            ],
        } as never);

        await coa().reverseJournal(workspace.id, posted.id, user.id, 'first');
        await expect(
            coa().reverseJournal(workspace.id, posted.id, user.id, 'second'),
        ).rejects.toThrow(/already been reversed/i);
    });

    it('shows up in the income statement when attributed to a book', async () => {
        const { workspace, user, cashbook } = await fixture();
        const salesRevenue = await systemAccount(workspace.id, 'SALES_REVENUE');
        const ar = await systemAccount(workspace.id, 'AR');

        await coa().postManualJournal(workspace.id, user.id, {
            description: 'Accrued revenue',
            entryDate: isoDate(new Date('2026-06-15')),
            cashbookId: cashbook.id,
            lines: [
                { ledgerAccountId: ar.id, debit: '900' },
                { ledgerAccountId: salesRevenue.id, credit: '900' },
            ],
        } as never);

        const statement = await reports().incomeStatement(workspace.id, {
            from: new Date('2026-01-01'),
            to: new Date('2026-12-31'),
        });
        const book = statement.byCurrency[0].sections.books.find(
            (b) => b.cashbookId === cashbook.id,
        );
        expect(book?.totals.income).toBe('900.0000');
    });
});

describe('period close', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('blocks new entries dated inside a closed period', async () => {
        const { workspace, user, cashbook } = await fixture();

        await coa().closePeriod(workspace.id, user.id, {
            startDate: new Date('2026-01-01').toISOString(),
            endDate: new Date('2026-03-31').toISOString(),
        } as never);

        await expect(
            entries().createEntry(cashbook.id, user.id, {
                type: 'INCOME', amount: '100', description: 'backdated',
                entryDate: isoDate(new Date('2026-02-15')),
            } as never),
        ).rejects.toThrow(/period .* is closed/i);

        // Outside the closed range is still fine.
        await expect(
            entries().createEntry(cashbook.id, user.id, {
                type: 'INCOME', amount: '100', description: 'after close',
                entryDate: isoDate(new Date('2026-05-15')),
            } as never),
        ).resolves.toBeTruthy();
    });

    it('blocks a manual journal dated inside a closed period', async () => {
        const { workspace, user } = await fixture();
        const suspense = await systemAccount(workspace.id, 'SUSPENSE');
        const equity = await systemAccount(workspace.id, 'OWNER_DRAWINGS');

        await coa().closePeriod(workspace.id, user.id, {
            startDate: new Date('2026-01-01').toISOString(),
            endDate: new Date('2026-03-31').toISOString(),
        } as never);

        await expect(
            coa().postManualJournal(workspace.id, user.id, {
                description: 'Sneaky',
                entryDate: isoDate(new Date('2026-02-01')),
                lines: [
                    { ledgerAccountId: equity.id, debit: '10' },
                    { ledgerAccountId: suspense.id, credit: '10' },
                ],
            } as never),
        ).rejects.toThrow(/closed/i);
    });

    it('posts a reversal at today when the original period is closed', async () => {
        const { workspace, user, cashbook } = await fixture();

        const entry = await entries().createEntry(cashbook.id, user.id, {
            type: 'INCOME', amount: '400', description: 'in an open period',
            entryDate: isoDate(new Date('2026-02-15')),
        } as never);

        await coa().closePeriod(workspace.id, user.id, {
            startDate: new Date('2026-01-01').toISOString(),
            endDate: new Date('2026-03-31').toISOString(),
        } as never);

        // The correction is accepted, but it lands outside the closed books.
        await entries().deleteEntry(entry.id, user.id, 'error found later', 'PRIMARY_ADMIN' as never);

        const reversal = await testPrisma.journalEntry.findFirstOrThrow({
            where: { sourceId: entry.id, status: 'REVERSING' },
        });
        expect(reversal.entryDate.getFullYear()).toBe(new Date().getFullYear());
        expect(reversal.entryDate.getTime()).toBeGreaterThan(new Date('2026-03-31').getTime());

        const report = await integrity().verifyWorkspace(workspace.id);
        expect(report.ok).toBe(true);
    });

    it('rejects overlapping closed periods', async () => {
        const { workspace, user } = await fixture();

        await coa().closePeriod(workspace.id, user.id, {
            startDate: new Date('2026-01-01').toISOString(),
            endDate: new Date('2026-03-31').toISOString(),
        } as never);

        await expect(
            coa().closePeriod(workspace.id, user.id, {
                startDate: new Date('2026-03-01').toISOString(),
                endDate: new Date('2026-06-30').toISOString(),
            } as never),
        ).rejects.toThrow(/overlaps a period already closed/i);
    });

    it('accepts postings again once a period is reopened', async () => {
        const { workspace, user, cashbook } = await fixture();

        const period = await coa().closePeriod(workspace.id, user.id, {
            startDate: new Date('2026-01-01').toISOString(),
            endDate: new Date('2026-03-31').toISOString(),
        } as never);

        await coa().reopenPeriod(workspace.id, period.id, user.id, 'audit adjustment needed');

        await expect(
            entries().createEntry(cashbook.id, user.id, {
                type: 'INCOME', amount: '100', description: 'now allowed',
                entryDate: isoDate(new Date('2026-02-15')),
            } as never),
        ).resolves.toBeTruthy();
    });
});
