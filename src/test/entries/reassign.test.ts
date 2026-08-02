/**
 * Moving an entry from one book to another.
 *
 * This is the replacement for a "cashbook to cashbook transfer". Now that every
 * entry names a wallet, books hold no cash, so there is nothing to transfer
 * between them. What people mean when they ask for that feature is this: the
 * amount was filed against the wrong book.
 *
 * So the property under test is that this moves ATTRIBUTION and not money. The
 * wallet must not move, the org-wide totals must not move, and the trial
 * balance must stay at zero — only which book counts the income or expense
 * changes. And it happens by reversing the old journal and posting a new one,
 * so the history says where the entry used to live.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { resetDatabase, testPrisma } from '../setup';
import { resolveService } from '../container';
import { EntriesService } from '../../modules/entries/entries.service';
import {
    createAccount, createCashbook, createUser, createWorkspace, getAccount, getCashbook,
} from '../factories';
import {
    provisionWorkspaceAccounting, ensureCashbookLedgerAccount, ensureWalletLedgerAccount,
} from '../../core/ledger/coa.seed';

const service = () => resolveService(EntriesService);

async function fixture() {
    const owner = await createUser();
    const workspace = await createWorkspace(owner.id);
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, workspace.id, 'UGX');
    });

    const shop = await createCashbook(workspace.id, owner.id, { name: 'Shop' });
    const warehouse = await createCashbook(workspace.id, owner.id, { name: 'Warehouse' });
    for (const book of [shop, warehouse]) {
        await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await ensureCashbookLedgerAccount(tx, {
                id: book.id, workspaceId: workspace.id, name: book.name, currency: 'UGX',
            });
        });
    }

    const wallet = await createAccount(workspace.id, { name: 'Till', balance: '0' });
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const full = await tx.account.findUniqueOrThrow({
            where: { id: wallet.id }, include: { accountType: true },
        });
        await ensureWalletLedgerAccount(tx, full, full.accountType.classification);
    });

    return { owner, workspace, shop, warehouse, wallet };
}

async function income(cashbookId: string, userId: string, accountId: string, amount = '50000') {
    return service().createEntry(cashbookId, userId, {
        type: 'INCOME', amount, description: 'Sale', accountId,
        entryDate: new Date('2026-03-10').toISOString(),
    } as never);
}

/** Debits less credits across the whole ledger. Must always be zero. */
async function trialBalance() {
    const rows = await testPrisma.journalLine.aggregate({
        _sum: { debit: true, credit: true },
    });
    return new Prisma.Decimal(rows._sum.debit ?? 0).sub(rows._sum.credit ?? 0).toString();
}

beforeEach(async () => {
    await resetDatabase();
});

describe('moving an entry between books', () => {
    it('moves the entry itself', async () => {
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);

        await service().reassignEntry(entry.id, f.owner.id, {
            targetCashbookId: f.warehouse.id,
            reason: 'Filed against the wrong branch',
            expectedVersion: entry.version,
        });

        const after = await testPrisma.entry.findUniqueOrThrow({ where: { id: entry.id } });
        expect(after.cashbookId).toBe(f.warehouse.id);
    });

    it('moves the income off the source book and onto the destination', async () => {
        // The whole point: both books' totals move, by the same amount, in
        // opposite directions.
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id, '50000');

        expect((await getCashbook(f.shop.id)).totalIncome.toString()).toBe('50000');
        expect((await getCashbook(f.warehouse.id)).totalIncome.toString()).toBe('0');

        await service().reassignEntry(entry.id, f.owner.id, {
            targetCashbookId: f.warehouse.id, reason: 'Wrong branch', expectedVersion: entry.version,
        });

        expect((await getCashbook(f.shop.id)).totalIncome.toString()).toBe('0');
        expect((await getCashbook(f.warehouse.id)).totalIncome.toString()).toBe('50000');
    });

    it('does not touch the wallet — no money moved', async () => {
        // The property that separates this from a transfer.
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id, '50000');
        const before = (await getAccount(f.wallet.id)).balance.toString();

        await service().reassignEntry(entry.id, f.owner.id, {
            targetCashbookId: f.warehouse.id, reason: 'Wrong branch', expectedVersion: entry.version,
        });

        expect((await getAccount(f.wallet.id)).balance.toString()).toBe(before);
    });

    it('leaves the trial balance at zero', async () => {
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);

        await service().reassignEntry(entry.id, f.owner.id, {
            targetCashbookId: f.warehouse.id, reason: 'Wrong branch', expectedVersion: entry.version,
        });

        expect(await trialBalance()).toBe('0');
    });

    it('reverses rather than rewrites, so the old book still shows what happened', async () => {
        // A reassignment that quietly edited the journal in place would leave no
        // trace that the entry was ever in the first book.
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);
        const before = await testPrisma.journalEntry.count();

        await service().reassignEntry(entry.id, f.owner.id, {
            targetCashbookId: f.warehouse.id, reason: 'Wrong branch', expectedVersion: entry.version,
        });

        // Original + reversal + repost.
        expect(await testPrisma.journalEntry.count()).toBeGreaterThan(before);
        const reversals = await testPrisma.journalEntry.count({ where: { status: 'REVERSING' } });
        expect(reversals).toBeGreaterThan(0);
    });

    it('records why, in the audit trail', async () => {
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);

        await service().reassignEntry(entry.id, f.owner.id, {
            targetCashbookId: f.warehouse.id,
            reason: 'Belongs to the warehouse, not the shop',
            expectedVersion: entry.version,
        });

        const audit = await testPrisma.entryAudit.findFirst({
            where: { entryId: entry.id, action: 'UPDATED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(JSON.stringify(audit?.newValues)).toContain('Belongs to the warehouse');
        expect(JSON.stringify(audit?.oldValues)).toContain('Shop');
    });
});

describe('what it refuses', () => {
    it('refuses to move an entry into the book it is already in', async () => {
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);

        await expect(
            service().reassignEntry(entry.id, f.owner.id, {
                targetCashbookId: f.shop.id, reason: 'no-op', expectedVersion: entry.version,
            }),
        ).rejects.toThrow(/already in this book/i);
    });

    it('refuses a book in another currency rather than inventing a rate', async () => {
        const f = await fixture();
        const usdBook = await createCashbook(f.workspace.id, f.owner.id, {
            name: 'USD book', currency: 'USD',
        });
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);

        await expect(
            service().reassignEntry(entry.id, f.owner.id, {
                targetCashbookId: usdBook.id, reason: 'wrong', expectedVersion: entry.version,
            }),
        ).rejects.toThrow(/UGX entry into a USD book/i);
    });

    it('refuses a reconciled entry', async () => {
        // Reconciliation says "this matches a line on THAT book's statement".
        // Moving it elsewhere would silently invalidate that claim.
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);
        await testPrisma.entry.update({
            where: { id: entry.id }, data: { isReconciled: true },
        });

        await expect(
            service().reassignEntry(entry.id, f.owner.id, {
                targetCashbookId: f.warehouse.id, reason: 'x', expectedVersion: entry.version,
            }),
        ).rejects.toThrow(/reconciled/i);
    });

    it('refuses a stale version, so two people cannot both move it', async () => {
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);

        await service().reassignEntry(entry.id, f.owner.id, {
            targetCashbookId: f.warehouse.id, reason: 'first', expectedVersion: entry.version,
        });

        await expect(
            service().reassignEntry(entry.id, f.owner.id, {
                targetCashbookId: f.shop.id, reason: 'second', expectedVersion: entry.version,
            }),
        ).rejects.toThrow(/changed while you were looking/i);
    });

    it('refuses an entry that has been reversed', async () => {
        const f = await fixture();
        const entry = await income(f.shop.id, f.owner.id, f.wallet.id);
        await testPrisma.entry.update({
            where: { id: entry.id }, data: { status: 'REVERSED' },
        });

        await expect(
            service().reassignEntry(entry.id, f.owner.id, {
                targetCashbookId: f.warehouse.id, reason: 'x', expectedVersion: entry.version,
            }),
        ).rejects.toThrow(/reversed/i);
    });
});
