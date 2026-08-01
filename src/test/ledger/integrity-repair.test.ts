/**
 * "My books don't balance" — and what the system does about it.
 *
 * Almost every report of this is cached-column drift, not a broken ledger. The
 * journal is the accounting record and it is append-only; `Cashbook.balance`
 * and `Account.balance` are denormalisations so the UI does not sum the ledger
 * on every page load. When they disagree, the ledger is right.
 *
 * So the repair recomputes the caches and touches no journal — which is why it
 * cannot violate double-entry, and why it must REFUSE the cases where the
 * journal itself is wrong. "Fixing" a cache to agree with a bad ledger would
 * hide a real accounting error behind a green tick.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { LedgerIntegrityService } from '../../core/ledger/integrity.service';
import { EntriesService } from '../../modules/entries/entries.service';
import {
    createAccount,
    createCashbook,
    createUser,
    createWorkspace,
    getAccount,
    getCashbook,
} from '../factories';
import {
    provisionWorkspaceAccounting,
    ensureCashbookLedgerAccount,
    ensureWalletLedgerAccount,
} from '../../core/ledger/coa.seed';

const integrity = () => resolveService(LedgerIntegrityService);

/** A workspace with real posted activity behind it. */
async function fixture() {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, workspace.id, 'UGX');
    });

    const cashbook = await createCashbook(workspace.id, owner.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await ensureCashbookLedgerAccount(tx, {
            id: cashbook.id, workspaceId: workspace.id, name: cashbook.name, currency: 'UGX',
        });
    });
    const wallet = await createAccount(workspace.id, { name: 'Cash drawer', balance: '0' });
    // The integrity check only covers wallets that have a ledger account —
    // without one there is nothing to compare the cached balance against.
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const full = await tx.account.findUniqueOrThrow({
            where: { id: wallet.id },
            include: { accountType: true },
        });
        await ensureWalletLedgerAccount(tx, full, full.accountType.classification);
    });

    // Two real entries so the ledger has something to be authoritative about.
    await resolveService(EntriesService).createEntry(cashbook.id, owner.id, {
        type: 'INCOME', amount: '50000', description: 'Sale',
        entryDate: new Date('2026-03-10').toISOString(),
    } as any);
    await resolveService(EntriesService).createEntry(cashbook.id, owner.id, {
        type: 'EXPENSE', amount: '20000', description: 'Supplies',
        entryDate: new Date('2026-03-11').toISOString(),
    } as any);

    return { owner, workspace, cashbook, wallet };
}

beforeEach(async () => {
    await resetDatabase();
});

describe('a healthy workspace', () => {
    it('reports nothing to fix', async () => {
        const f = await fixture();

        const report = await integrity().verifyWorkspace(f.workspace.id);

        expect(report.ok).toBe(true);
        expect(report.findings).toHaveLength(0);
    });

    it('leaves everything alone when repair is run anyway', async () => {
        const f = await fixture();
        const before = await getCashbook(f.cashbook.id);

        const result = await integrity().repairCachedBalances(f.workspace.id);

        expect(result.repaired).toHaveLength(0);
        expect((await getCashbook(f.cashbook.id)).balance.toString())
            .toBe(before.balance.toString());
    });
});

describe('cached balances that have drifted', () => {
    /** Corrupt the cache the way legacy data or a stray write would. */
    async function driftCashbook(cashbookId: string) {
        await testPrisma.cashbook.update({
            where: { id: cashbookId },
            data: { balance: '999999', totalIncome: '111111', totalExpense: '222222' },
        });
    }

    it('is detected, with the ledger given as the expected value', async () => {
        const f = await fixture();
        await driftCashbook(f.cashbook.id);

        const report = await integrity().verifyWorkspace(f.workspace.id);

        const balance = report.findings.find((x) => x.check === 'CASHBOOK_BALANCE');
        expect(balance).toBeDefined();
        // 50,000 in less 20,000 out.
        expect(balance!.expected).toBe('30000');
        expect(balance!.actual).toBe('999999');
    });

    it('names the book rather than showing a bare id', async () => {
        // A user cannot act on "a3a4ba93-be49-…". The id is still carried, for
        // support, but it is not what they are asked to read.
        const f = await fixture();
        await driftCashbook(f.cashbook.id);

        const report = await integrity().verifyWorkspace(f.workspace.id);
        const finding = report.findings.find((x) => x.check === 'CASHBOOK_BALANCE')!;

        expect(finding.subject).toBe(f.cashbook.name);
        expect(finding.subject).not.toContain(f.cashbook.id);
        expect(finding.subjectId).toBe(f.cashbook.id);
    });

    it('says in words what is wrong and that it can be fixed', async () => {
        const f = await fixture();
        await driftCashbook(f.cashbook.id);

        const report = await integrity().verifyWorkspace(f.workspace.id);
        const finding = report.findings.find((x) => x.check === 'CASHBOOK_BALANCE')!;

        expect(finding.repairable).toBe(true);
        expect(finding.explanation).toMatch(/no transaction is wrong/i);
    });

    it('recalculates the book back to what the ledger says', async () => {
        const f = await fixture();
        await driftCashbook(f.cashbook.id);

        const result = await integrity().repairCachedBalances(f.workspace.id);

        const after = await getCashbook(f.cashbook.id);
        expect(after.balance.toString()).toBe('30000');
        expect(after.totalIncome.toString()).toBe('50000');
        expect(after.totalExpense.toString()).toBe('20000');
        expect(result.remaining).toHaveLength(0);
    });

    it('recalculates a drifted wallet too', async () => {
        const f = await fixture();
        await testPrisma.account.update({
            where: { id: f.wallet.id },
            data: { balance: '424242' },
        });

        await integrity().repairCachedBalances(f.workspace.id);

        // No movements were posted against it, so the ledger says zero.
        expect((await getAccount(f.wallet.id)).balance.toString()).toBe('0');
    });

    it('changes no journal line — the accounting record is untouched', async () => {
        // The property that makes this safe to offer as a button.
        const f = await fixture();
        const linesBefore = await testPrisma.journalLine.findMany({
            orderBy: { id: 'asc' },
            select: { id: true, debit: true, credit: true, ledgerAccountId: true },
        });
        await driftCashbook(f.cashbook.id);

        await integrity().repairCachedBalances(f.workspace.id);

        const linesAfter = await testPrisma.journalLine.findMany({
            orderBy: { id: 'asc' },
            select: { id: true, debit: true, credit: true, ledgerAccountId: true },
        });
        expect(linesAfter).toEqual(linesBefore);
    });

    it('leaves the trial balance at zero', async () => {
        const f = await fixture();
        await driftCashbook(f.cashbook.id);

        await integrity().repairCachedBalances(f.workspace.id);

        const report = await integrity().verifyWorkspace(f.workspace.id);
        expect(report.findings.filter((x) => x.check === 'TRIAL_BALANCE')).toHaveLength(0);
        expect(report.ok).toBe(true);
    });
});

describe('the ledger itself cannot drift out of balance', () => {
    it('refuses an unbalanced journal even with the maintenance escape hatch on', async () => {
        // Worth stating plainly, because it is why "my books do not balance"
        // is almost always a stale cached total rather than a broken ledger.
        //
        // app.allow_ledger_maintenance lifts the APPEND-ONLY trigger, which is
        // what the test harness and the seed use to truncate. It does NOT lift
        // journal_lines_balanced, a DEFERRABLE CONSTRAINT TRIGGER that fires at
        // COMMIT — so a transaction that leaves debits ≠ credits is rejected
        // outright, no matter which path wrote it.
        await fixture();
        const line = await testPrisma.journalLine.findFirstOrThrow();

        await expect(
            testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
                await tx.$executeRawUnsafe(`SET LOCAL app.allow_ledger_maintenance = 'on'`);
                await tx.$executeRawUnsafe(
                    `UPDATE journal_lines SET debit = debit + 500 WHERE id = $1::uuid`,
                    line.id,
                );
            }),
        ).rejects.toThrow(/unbalanced/i);
    });

    it('leaves the ledger untouched after such an attempt', async () => {
        const f = await fixture();
        const line = await testPrisma.journalLine.findFirstOrThrow();
        await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.allow_ledger_maintenance = 'on'`);
            await tx.$executeRawUnsafe(
                `UPDATE journal_lines SET debit = debit + 500 WHERE id = $1::uuid`,
                line.id,
            );
        }).catch(() => { /* expected */ });

        const report = await integrity().verifyWorkspace(f.workspace.id);
        expect(report.ok).toBe(true);
    });

    it('flags the non-repairable checks as such, so no button claims to fix them', async () => {
        // The distinction the repair path depends on: a stale cache can be
        // recalculated, a wrong journal cannot.
        const f = await fixture();
        await testPrisma.cashbook.update({
            where: { id: f.cashbook.id },
            data: { balance: '999999' },
        });

        const report = await integrity().verifyWorkspace(f.workspace.id);

        for (const finding of report.findings) {
            const isCache = finding.check.startsWith('CASHBOOK_')
                || finding.check === 'WALLET_BALANCE';
            expect(finding.repairable).toBe(isCache);
        }
    });
});
