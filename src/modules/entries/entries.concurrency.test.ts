/**
 * Integration tests for the entry write paths under concurrency.
 *
 * These run against a real Postgres database because the behaviour being tested
 * — FOR UPDATE lock ordering, transaction rollback, compare-and-swap on version —
 * does not exist outside one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import { resetDatabase, testPrisma } from '../../test/setup';
import { resolveService } from '../../test/container';
import {
    createFinancialFixture,
    getAccount,
    getCashbook,
    isoDate,
} from '../../test/factories';
import { EntriesService } from './entries.service';

const service = () => resolveService(EntriesService);

/** Runs promises in parallel and reports which settled how. */
async function settleAll<T>(promises: Promise<T>[]) {
    const results = await Promise.allSettled(promises);
    return {
        fulfilled: results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<T>[],
        rejected: results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[],
    };
}

describe('EntriesService concurrency', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('keeps cashbook totals exact under parallel entry creation', async () => {
        const { user, cashbook } = await createFinancialFixture();
        const entries = service();

        const CONCURRENT = 12;
        const { fulfilled, rejected } = await settleAll(
            Array.from({ length: CONCURRENT }, (_, i) =>
                entries.createEntry(cashbook.id, user.id, {
                    type: 'INCOME',
                    amount: '100',
                    description: `parallel ${i}`,
                    entryDate: isoDate(),
                } as never),
            ),
        );

        expect(rejected.map((r) => String(r.reason))).toEqual([]);
        expect(fulfilled).toHaveLength(CONCURRENT);

        const after = await getCashbook(cashbook.id);
        // Every increment must have landed exactly once — no lost updates.
        expect(after.totalIncome.toString()).toBe(new Decimal(100).mul(CONCURRENT).toString());
        expect(after.balance.toString()).toBe(new Decimal(100).mul(CONCURRENT).toString());
    });

    it('does not deadlock when two entries swap wallets in opposite directions', async () => {
        const { user, cashbook, walletA, walletB } = await createFinancialFixture();
        const entries = service();

        const first = await entries.createEntry(cashbook.id, user.id, {
            type: 'EXPENSE',
            amount: '100',
            description: 'on wallet A',
            entryDate: isoDate(),
            accountId: walletA.id,
        } as never);

        const second = await entries.createEntry(cashbook.id, user.id, {
            type: 'EXPENSE',
            amount: '100',
            description: 'on wallet B',
            entryDate: isoDate(),
            accountId: walletB.id,
        } as never);

        // A -> B and B -> A at the same time. Before the shared lock-ordering
        // primitive these locked in argument order and deadlocked.
        const { rejected } = await settleAll([
            entries.updateEntry(first.id, user.id, {
                accountId: walletB.id,
                expectedVersion: first.version,
            } as never),
            entries.updateEntry(second.id, user.id, {
                accountId: walletA.id,
                expectedVersion: second.version,
            } as never),
        ]);

        for (const r of rejected) {
            expect(String(r.reason)).not.toMatch(/deadlock/i);
        }

        // Wallet balances must still reconcile against their transactions.
        for (const walletId of [walletA.id, walletB.id]) {
            const wallet = await getAccount(walletId);
            const txs = await testPrisma.accountTransaction.findMany({
                where: { accountId: walletId, voidedAt: null },
            });
            const expected = txs.reduce(
                (sum: Decimal, t: (typeof txs)[number]) =>
                    t.type === 'INCOME'
                        ? sum.add(t.amount).sub(t.chargeAmount ?? 0)
                        : sum.sub(t.amount).sub(t.chargeAmount ?? 0),
                new Decimal(10000),
            );
            expect(wallet.balance.toString()).toBe(expected.toString());
        }
    });

    it('lets exactly one of two racing edits win on the same expectedVersion', async () => {
        const { user, cashbook } = await createFinancialFixture();
        const entries = service();

        const entry = await entries.createEntry(cashbook.id, user.id, {
            type: 'INCOME',
            amount: '100',
            description: 'contended',
            entryDate: isoDate(),
        } as never);

        const { fulfilled, rejected } = await settleAll([
            entries.updateEntry(entry.id, user.id, {
                amount: '200',
                expectedVersion: entry.version,
            } as never),
            entries.updateEntry(entry.id, user.id, {
                amount: '300',
                expectedVersion: entry.version,
            } as never),
        ]);

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(String(rejected[0].reason)).toMatch(/modified by another request/i);

        const after = await getCashbook(cashbook.id);
        const stored = await testPrisma.entry.findUniqueOrThrow({ where: { id: entry.id } });

        // The book must agree with the single winning amount, not a blend of both.
        expect(after.totalIncome.toString()).toBe(stored.amount.toString());
        expect(after.balance.toString()).toBe(stored.amount.toString());
        expect(stored.version).toBe(entry.version + 1);
    });

    it('requires expectedVersion for money-affecting edits', async () => {
        const { user, cashbook } = await createFinancialFixture();
        const entries = service();

        const entry = await entries.createEntry(cashbook.id, user.id, {
            type: 'INCOME',
            amount: '100',
            description: 'guarded',
            entryDate: isoDate(),
        } as never);

        await expect(
            entries.updateEntry(entry.id, user.id, { amount: '500' } as never),
        ).rejects.toThrow(/expectedVersion is required/i);

        // Description-only edits stay unguarded, so the common case is unchanged.
        await expect(
            entries.updateEntry(entry.id, user.id, { description: 'renamed' } as never),
        ).resolves.toBeTruthy();
    });
});

describe('EntriesService deletion guards', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('refuses to overdraw a wallet when reversing an income entry', async () => {
        const { user, workspace, cashbook } = await createFinancialFixture();
        const entries = service();

        // Wallet starts empty and disallows negatives.
        const wallet = await testPrisma.account.create({
            data: {
                workspaceId: workspace.id,
                accountTypeId: (
                    await testPrisma.accountType.findFirstOrThrow({
                        where: { workspaceId: workspace.id },
                    })
                ).id,
                name: 'Strict wallet',
                currency: 'UGX',
                balance: new Decimal(0),
                allowNegative: false,
            },
        });

        const income = await entries.createEntry(cashbook.id, user.id, {
            type: 'INCOME',
            amount: '500',
            description: 'money in',
            entryDate: isoDate(),
            accountId: wallet.id,
        } as never);

        // Spend it all, so reversing the income would push the wallet negative.
        await entries.createEntry(cashbook.id, user.id, {
            type: 'EXPENSE',
            amount: '500',
            description: 'money out',
            entryDate: isoDate(),
            accountId: wallet.id,
        } as never);

        expect((await getAccount(wallet.id)).balance.toString()).toBe('0');

        await expect(
            entries.deleteEntry(income.id, user.id, 'testing overdraw', 'PRIMARY_ADMIN' as never),
        ).rejects.toThrow(/overdraw|INSUFFICIENT_FUNDS/i);

        // The whole transaction must have rolled back — entry still live.
        const stored = await testPrisma.entry.findUniqueOrThrow({ where: { id: income.id } });
        expect(stored.isDeleted).toBe(false);
        expect((await getAccount(wallet.id)).balance.toString()).toBe('0');
    });
});
