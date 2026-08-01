/**
 * End-to-end ledger correctness.
 *
 * Every cached balance in this file is produced solely by PostingService from
 * journal legs — the legacy increment arithmetic is gone. The assertions are the
 * same ones that passed while both ran side by side in shadow mode, which is how
 * we know the cutover changed no numbers.
 *
 * Each step calls the integrity verifier, so a regression shows up as a specific
 * account and difference rather than a failed total somewhere downstream.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { resetDatabase, testPrisma } from '../../test/setup';
import { resolveService } from '../../test/container';
import { createFinancialFixture, createInventoryItem, isoDate } from '../../test/factories';
import { EntriesService } from '../../modules/entries/entries.service';
import { ObligationsService } from '../../modules/cashbook-obligations/obligations.service';
import { LedgerIntegrityService } from './integrity.service';
import { provisionWorkspaceAccounting, ensureCashbookLedgerAccount, ensureWalletLedgerAccount } from './coa.seed';

const entries = () => resolveService(EntriesService);
const obligations = () => resolveService(ObligationsService);
const integrity = () => resolveService(LedgerIntegrityService);

/**
 * The factories write rows directly, bypassing the services that normally
 * provision accounting. Do it explicitly so these tests exercise posting rather
 * than the resolver's self-healing path.
 */
async function provision(fixture: Awaited<ReturnType<typeof createFinancialFixture>>) {
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await provisionWorkspaceAccounting(tx, fixture.workspace.id, 'UGX');
        await ensureCashbookLedgerAccount(tx, {
            id: fixture.cashbook.id,
            workspaceId: fixture.workspace.id,
            name: fixture.cashbook.name,
            currency: 'UGX',
        });
        for (const wallet of [fixture.walletA, fixture.walletB]) {
            const full = await tx.account.findUniqueOrThrow({
                where: { id: wallet.id },
                include: { accountType: true },
            });
            await ensureWalletLedgerAccount(tx, full, full.accountType.classification);
        }
    });

    // Opening balances predate the ledger in this fixture, so seed the equity
    // side directly rather than leaving the wallet cache unexplained.
    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        for (const wallet of [fixture.walletA, fixture.walletB]) {
            const account = await tx.account.findUniqueOrThrow({ where: { id: wallet.id } });
            if (account.balance.isZero()) continue;
            const equity = await tx.ledgerAccount.findUniqueOrThrow({
                where: {
                    workspaceId_systemKey_currency: { workspaceId: fixture.workspace.id, systemKey: 'OPENING_BALANCE_EQUITY', currency: 'UGX' },
                },
            });
            const journal = await tx.journalEntry.create({
                data: {
                    workspaceId: fixture.workspace.id,
                    entryDate: new Date(),
                    currency: 'UGX',
                    description: `Opening balance: ${account.name}`,
                    sourceType: 'ACCOUNT_OPENING',
                    sourceId: account.id,
                    postingKey: `account-open:${account.id}`,
                    totalDebit: account.balance,
                    totalCredit: account.balance,
                    createdById: fixture.user.id,
                },
            });
            await tx.journalLine.createMany({
                data: [
                    {
                        journalEntryId: journal.id,
                        lineNumber: 1,
                        workspaceId: fixture.workspace.id,
                        entryDate: new Date(),
                        currency: 'UGX',
                        ledgerAccountId: account.ledgerAccountId!,
                        debit: account.balance,
                        credit: new Decimal(0),
                    },
                    {
                        journalEntryId: journal.id,
                        lineNumber: 2,
                        workspaceId: fixture.workspace.id,
                        entryDate: new Date(),
                        currency: 'UGX',
                        ledgerAccountId: equity.id,
                        debit: new Decimal(0),
                        credit: account.balance,
                    },
                ],
            });
        }
    });
}

async function expectClean(workspaceId: string, label: string) {
    const report = await integrity().verifyWorkspace(workspaceId);
    if (!report.ok) {
        // Surface the actual mismatch rather than a bare boolean failure.
        throw new Error(
            `${label}: ledger disagrees with caches\n` +
            report.findings
                .map((f) => `  ${f.check} ${f.subject}: expected ${f.expected}, got ${f.actual} (Δ ${f.difference})`)
                .join('\n'),
        );
    }
    expect(report.ok).toBe(true);
}

describe('ledger as source of truth', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('agrees for unlinked income and expense entries', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '1000', description: 'sale', entryDate: isoDate(),
        } as never);
        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'EXPENSE', amount: '300', description: 'rent', entryDate: isoDate(),
        } as never);

        await expectClean(fx.workspace.id, 'unlinked entries');

        const cashbook = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: fx.cashbook.id } });
        expect(cashbook.balance.toString()).toBe('700');
        expect(cashbook.totalIncome.toString()).toBe('1000');
        expect(cashbook.totalExpense.toString()).toBe('300');
    });

    it('agrees for wallet-linked entries, and preserves the book-balance rule', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '500', description: 'to wallet', entryDate: isoDate(),
            accountId: fx.walletA.id,
        } as never);

        await expectClean(fx.workspace.id, 'wallet-linked entry');

        const cashbook = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: fx.cashbook.id } });
        const wallet = await testPrisma.account.findUniqueOrThrow({ where: { id: fx.walletA.id } });

        // The product's defining rule, verified end to end.
        expect(cashbook.balance.toString()).toBe('0');
        expect(cashbook.totalIncome.toString()).toBe('500');
        expect(wallet.balance.toString()).toBe('10500');
    });

    it('agrees when charges are involved', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '1000', chargeAmount: '25', description: 'net of fee',
            entryDate: isoDate(),
        } as never);
        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'EXPENSE', amount: '200', chargeAmount: '5', description: 'with fee',
            entryDate: isoDate(), accountId: fx.walletB.id,
        } as never);

        await expectClean(fx.workspace.id, 'charged entries');

        const cashbook = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: fx.cashbook.id } });
        expect(cashbook.balance.toString()).toBe('975');
        expect(cashbook.totalIncome.toString()).toBe('1000');
        // 25 income charge + 200 expense + 5 expense charge
        expect(cashbook.totalExpense.toString()).toBe('230');
    });

    it('agrees across an edit', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        const entry = await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '400', description: 'original', entryDate: isoDate(),
        } as never);

        await entries().updateEntry(entry.id, fx.user.id, {
            amount: '650', expectedVersion: entry.version,
        } as never);

        await expectClean(fx.workspace.id, 'after edit');

        const cashbook = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: fx.cashbook.id } });
        expect(cashbook.balance.toString()).toBe('650');
        expect(cashbook.totalIncome.toString()).toBe('650');
    });

    it('agrees across two consecutive edits (posting-key versioning)', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        const entry = await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '100', description: 'v1', entryDate: isoDate(),
        } as never);

        const v2 = await entries().updateEntry(entry.id, fx.user.id, {
            amount: '200', expectedVersion: entry.version,
        } as never);

        // The off-by-one risk: v2's journal must not collide with v1's reversal.
        await entries().updateEntry(entry.id, fx.user.id, {
            amount: '300', expectedVersion: v2.version,
        } as never);

        await expectClean(fx.workspace.id, 'after two edits');

        const cashbook = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: fx.cashbook.id } });
        expect(cashbook.totalIncome.toString()).toBe('300');
    });

    it('agrees across a delete', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        const entry = await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'EXPENSE', amount: '250', description: 'to be reversed', entryDate: isoDate(),
            accountId: fx.walletA.id,
        } as never);

        await entries().deleteEntry(entry.id, fx.user.id, 'mistake', 'PRIMARY_ADMIN' as never);

        await expectClean(fx.workspace.id, 'after delete');

        const cashbook = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: fx.cashbook.id } });
        const wallet = await testPrisma.account.findUniqueOrThrow({ where: { id: fx.walletA.id } });
        expect(cashbook.totalExpense.toString()).toBe('0');
        expect(wallet.balance.toString()).toBe('10000');
    });

    it('agrees for an obligation settled by two partial payments', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        const contact = await testPrisma.contact.create({
            data: { workspaceId: fx.workspace.id, name: 'Customer', type: 'CUSTOMER' },
        });

        const obligation = await obligations().createObligation(fx.cashbook.id, fx.user.id, {
            type: 'RECEIVABLE',
            title: 'Invoice 001',
            totalAmount: '1000',
            contactId: contact.id,
        } as never);

        await expectClean(fx.workspace.id, 'obligation opened');

        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '400', description: 'part 1', entryDate: isoDate(),
            obligationId: obligation.id, contactId: contact.id,
        } as never);

        await expectClean(fx.workspace.id, 'first payment');

        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '600', description: 'part 2', entryDate: isoDate(),
            obligationId: obligation.id, contactId: contact.id,
            accountId: fx.walletA.id,
        } as never);

        await expectClean(fx.workspace.id, 'fully settled');

        const settled = await testPrisma.cashbookObligation.findUniqueOrThrow({
            where: { id: obligation.id },
        });
        expect(settled.status).toBe('PAID');
        expect(settled.outstandingAmount.toString()).toBe('0');

        // Revenue was recognized on cash, in full, exactly as before the ledger.
        const cashbook = await testPrisma.cashbook.findUniqueOrThrow({ where: { id: fx.cashbook.id } });
        expect(cashbook.totalIncome.toString()).toBe('1000');
    });

    it('agrees when inventory is attached', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);
        const item = await createInventoryItem(fx.workspace.id);

        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'EXPENSE', amount: '500', description: 'buy stock', entryDate: isoDate(),
            inventoryItems: [{ itemId: item.id, quantity: 10, unitCost: '50' }],
        } as never);

        await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '800', description: 'sell stock', entryDate: isoDate(),
            inventoryItems: [{ itemId: item.id, quantity: 5, sellingPrice: '160' }],
        } as never);

        // inventoryValuation is OFF, so inventory stays an operational subledger
        // and totalExpense keeps its cash-basis meaning.
        await expectClean(fx.workspace.id, 'with inventory');
    });

    it('keeps the trial balance at zero after a long mixed sequence', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        const created: string[] = [];
        for (let i = 0; i < 8; i += 1) {
            const entry = await entries().createEntry(fx.cashbook.id, fx.user.id, {
                type: i % 2 === 0 ? 'INCOME' : 'EXPENSE',
                amount: `${100 + i * 13}`,
                chargeAmount: i % 3 === 0 ? '2.5' : undefined,
                description: `mixed ${i}`,
                entryDate: isoDate(),
                accountId: i % 4 === 0 ? fx.walletA.id : undefined,
            } as never);
            created.push(entry.id);
        }

        // Edit some, delete others.
        for (const [index, id] of created.entries()) {
            const current = await testPrisma.entry.findUniqueOrThrow({ where: { id } });
            if (index % 3 === 0) {
                await entries().updateEntry(id, fx.user.id, {
                    amount: '77', expectedVersion: current.version,
                } as never);
            } else if (index % 3 === 1) {
                await entries().deleteEntry(id, fx.user.id, 'cleanup', 'PRIMARY_ADMIN' as never);
            }
        }

        await expectClean(fx.workspace.id, 'mixed sequence');

        const [row] = await testPrisma.$queryRaw<Array<{ debit: Decimal; credit: Decimal }>>`
            SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
            FROM journal_lines WHERE workspace_id = ${fx.workspace.id}::uuid
        `;
        expect(new Decimal(row.debit).toString()).toBe(new Decimal(row.credit).toString());
    });
});

describe('reversal semantics', () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    it('hides a reversed entry from the list but keeps it queryable', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        const kept = await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '100', description: 'kept', entryDate: isoDate(),
        } as never);
        const reversed = await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'INCOME', amount: '200', description: 'reversed', entryDate: isoDate(),
        } as never);

        await entries().deleteEntry(reversed.id, fx.user.id, 'mistake', 'PRIMARY_ADMIN' as never);

        const defaultList = await entries().getEntries(fx.cashbook.id, {
            page: 1, limit: 20, sortBy: 'entryDate', sortOrder: 'desc', includeReversed: false,
        } as never);
        expect(defaultList.data.map((e: { id: string }) => e.id)).toEqual([kept.id]);

        const withReversed = await entries().getEntries(fx.cashbook.id, {
            page: 1, limit: 20, sortBy: 'entryDate', sortOrder: 'desc', includeReversed: true,
        } as never);
        expect(withReversed.data.map((e: { id: string }) => e.id).sort()).toEqual(
            [kept.id, reversed.id].sort(),
        );
    });

    it('never destroys the journal: original and reversal both survive and net to zero', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        const entry = await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'EXPENSE', amount: '300', description: 'to reverse', entryDate: isoDate(),
        } as never);

        await entries().deleteEntry(entry.id, fx.user.id, 'cancelled', 'PRIMARY_ADMIN' as never);

        const journals = await testPrisma.journalEntry.findMany({
            where: { sourceId: entry.id },
            orderBy: { seq: 'asc' },
        });

        expect(journals).toHaveLength(2);
        expect(journals[0].status).toBe('REVERSED');
        expect(journals[1].status).toBe('REVERSING');
        expect(journals[1].reversesJournalEntryId).toBe(journals[0].id);

        // Debits and credits are mirrored, so the pair contributes nothing.
        expect(journals[0].totalDebit.toString()).toBe(journals[1].totalCredit.toString());

        await expectClean(fx.workspace.id, 'after reversal');
    });

    it('keeps attachments on a reversed entry instead of destroying them', async () => {
        const fx = await createFinancialFixture();
        await provision(fx);

        const entry = await entries().createEntry(fx.cashbook.id, fx.user.id, {
            type: 'EXPENSE', amount: '50', description: 'with receipt', entryDate: isoDate(),
        } as never);

        await testPrisma.attachment.create({
            data: {
                entryId: entry.id,
                cashbookId: fx.cashbook.id,
                fileName: 'receipt.pdf',
                s3Key: 'attachments/receipt.pdf',
                fileSize: 1024,
                mimeType: 'application/pdf',
                uploadedById: fx.user.id,
            },
        });

        await entries().deleteEntry(entry.id, fx.user.id, 'voided', 'PRIMARY_ADMIN' as never);

        const attachment = await testPrisma.attachment.findFirstOrThrow({
            where: { entryId: entry.id },
        });
        // Soft-deleted, not gone: a reversed entry keeps its evidence.
        expect(attachment.isDeleted).toBe(true);
    });
});
