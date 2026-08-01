/**
 * Demo dataset that verifies itself.
 *
 * Exercises every posting rule in the system — unlinked and wallet-linked
 * entries, charges, obligations settled in instalments, cancellations, wallet
 * transfers, opening balances, manual journals, an edit and a reversal — and
 * then asserts the trial balance is zero and every cached balance matches the
 * ledger. A seed that checks its own books is the cheapest end-to-end test
 * available: if the posting rules break, `npm run seed` fails.
 *
 * Run: npx prisma db seed
 */
import 'reflect-metadata';
import { PrismaClient, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import bcrypt from 'bcryptjs';

import {
    provisionWorkspaceAccounting,
    ensureCashbookLedgerAccount,
    ensureWalletLedgerAccount,
} from '../src/core/ledger/coa.seed';
import { buildEntryJournal } from '../src/core/ledger/rules/entry.rules';
import { buildObligationJournal, buildObligationWriteOffJournal } from '../src/core/ledger/rules/obligation.rules';
import {
    buildOpeningBalanceJournal,
    buildTransferJournal,
    buildDirectWalletJournal,
} from '../src/core/ledger/rules/wallet.rules';
import { PostingService } from '../src/core/ledger/posting.service';
import { LedgerIntegrityService } from '../src/core/ledger/integrity.service';

const prisma = new PrismaClient();
const posting = new PostingService();

const D = (v: string | number) => new Decimal(v);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const SEED_EMAIL = 'demo@cashbook.local';

async function main() {
    console.log('Seeding demo workspace…\n');

    // ─── Clean slate for the demo user only ──────────────
    const existing = await prisma.user.findUnique({ where: { email: SEED_EMAIL } });
    if (existing) {
        console.log('  Removing previous demo data…');
        const workspaces = await prisma.workspace.findMany({
            where: { ownerId: existing.id },
            select: { id: true },
        });

        // journal_lines is append-only, enforced by a trigger. SET LOCAL only
        // lasts for the current transaction, so the GUC and the deletes must
        // share one — outside a transaction the setting is gone before the
        // DELETE runs and the trigger (correctly) rejects it. This is the one
        // sanctioned use of the escape hatch outside the test harness.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.allow_ledger_maintenance = 'on'`);
            for (const ws of workspaces) {
                await tx.$executeRawUnsafe(
                    `DELETE FROM journal_lines WHERE workspace_id = $1::uuid`, ws.id);
                await tx.$executeRawUnsafe(
                    `DELETE FROM journal_entries WHERE workspace_id = $1::uuid`, ws.id);
                // Transfers hold onDelete: Restrict on both accounts, so they
                // must go before the workspace cascade can reach the wallets.
                await tx.$executeRawUnsafe(
                    `DELETE FROM account_transfers WHERE workspace_id = $1::uuid`, ws.id);
            }
        });

        await prisma.workspace.deleteMany({ where: { ownerId: existing.id } });
        await prisma.user.delete({ where: { id: existing.id } });
    }

    const user = await prisma.user.create({
        data: {
            email: SEED_EMAIL,
            passwordHash: await bcrypt.hash('demo1234', 10),
            firstName: 'Demo',
            lastName: 'Accountant',
            emailVerified: true,
        },
    });

    const workspace = await prisma.workspace.create({
        data: {
            name: 'Demo Trading Co',
            type: 'BUSINESS',
            ownerId: user.id,
            defaultCurrency: 'UGX',
        },
    });
    await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' },
    });

    const ctx = { workspaceId: workspace.id, userId: user.id, currency: 'UGX' };

    // ─── Chart of accounts + wallet types ────────────────
    await prisma.$transaction((tx) =>
        provisionWorkspaceAccounting(tx, workspace.id, 'UGX'),
    );
    console.log('  ✓ Chart of accounts seeded');

    // ─── Two cashbooks ───────────────────────────────────
    const shop = await prisma.cashbook.create({
        data: { workspaceId: workspace.id, name: 'Shop Floor', currency: 'UGX', allowBackdate: true },
    });
    const online = await prisma.cashbook.create({
        data: { workspaceId: workspace.id, name: 'Online Sales', currency: 'UGX', allowBackdate: true },
    });
    await prisma.$transaction(async (tx) => {
        for (const cb of [shop, online]) {
            await ensureCashbookLedgerAccount(tx, {
                id: cb.id, workspaceId: workspace.id, name: cb.name, currency: 'UGX',
            });
        }
    });
    console.log('  ✓ Cashbooks created');

    // ─── Three wallets, one a liability (credit card) ────
    const typeOf = async (name: string) =>
        prisma.accountType.findFirstOrThrow({ where: { workspaceId: workspace.id, name } });

    const wallets = [
        { name: 'Stanbic Current', type: await typeOf('Bank'), opening: '2500000' },
        { name: 'Cash Drawer', type: await typeOf('Cash'), opening: '350000' },
        { name: 'Company Card', type: await typeOf('Credit Card'), opening: '-180000' },
    ];

    const created: Array<{ id: string; name: string }> = [];
    for (const w of wallets) {
        const account = await prisma.account.create({
            data: {
                workspaceId: workspace.id,
                accountTypeId: w.type.id,
                name: w.name,
                currency: 'UGX',
                balance: D(0),
                allowNegative: w.type.classification === 'LIABILITY',
            },
        });

        await prisma.$transaction(async (tx) => {
            const full = await tx.account.findUniqueOrThrow({
                where: { id: account.id },
                include: { accountType: true },
            });
            await ensureWalletLedgerAccount(tx, full, full.accountType.classification);

            await posting.post(tx, buildOpeningBalanceJournal({
                ...ctx,
                accountId: account.id,
                amount: w.opening,
                accountName: w.name,
                openedAt: day('2026-01-01'),
                createdById: user.id,
            }));
        });

        created.push({ id: account.id, name: w.name });
    }
    const [bank, cash, card] = created;
    console.log('  ✓ Wallets created with opening balances');

    // ─── Reference data ──────────────────────────────────
    const [salesCat, rentCat, suppliesCat] = await Promise.all([
        prisma.category.create({ data: { workspaceId: workspace.id, name: 'Product Sales' } }),
        prisma.category.create({ data: { workspaceId: workspace.id, name: 'Rent' } }),
        prisma.category.create({ data: { workspaceId: workspace.id, name: 'Supplies' } }),
    ]);

    // One category mapped to a bespoke GL account, the rest left unmapped so the
    // fallback path is exercised too.
    const rentAccount = await prisma.ledgerAccount.create({
        data: {
            workspaceId: workspace.id,
            code: '5210',
            name: 'Rent & Premises',
            class: 'EXPENSE',
            normalBalance: 'DEBIT',
            origin: 'USER',
            currency: 'UGX',
            parentId: (await prisma.ledgerAccount.findUniqueOrThrow({
                where: { workspaceId_code: { workspaceId: workspace.id, code: '5000' } },
            })).id,
        },
    });
    await prisma.category.update({
        where: { id: rentCat.id },
        data: { glAccountId: rentAccount.id },
    });

    const customer = await prisma.contact.create({
        data: { workspaceId: workspace.id, name: 'Kampala Retailers Ltd', type: 'CUSTOMER', email: 'buyer@example.com' },
    });
    const vendor = await prisma.contact.create({
        data: { workspaceId: workspace.id, name: 'Mukwano Supplies', type: 'VENDOR' },
    });
    console.log('  ✓ Categories and contacts created');

    // ─── Entries: all four shapes, with and without charges ──
    let entrySeq = 0;
    const postEntry = async (args: {
        cashbookId: string;
        type: 'INCOME' | 'EXPENSE';
        amount: string;
        charge?: string;
        description: string;
        date: string;
        accountId?: string;
        categoryId?: string;
        contactId?: string;
        obligation?: { id: string; type: 'RECEIVABLE' | 'PAYABLE' };
    }) => {
        entrySeq += 1;
        return prisma.$transaction(async (tx) => {
            const entry = await tx.entry.create({
                data: {
                    cashbookId: args.cashbookId,
                    type: args.type,
                    amount: D(args.amount),
                    chargeAmount: args.charge ? D(args.charge) : null,
                    description: args.description,
                    entryDate: day(args.date),
                    createdById: user.id,
                    categoryId: args.categoryId ?? null,
                    contactId: args.contactId ?? null,
                    obligationId: args.obligation?.id ?? null,
                },
            });

            if (args.accountId) {
                await tx.accountTransaction.create({
                    data: {
                        workspaceId: workspace.id,
                        accountId: args.accountId,
                        sourceType: 'CASHBOOK_ENTRY',
                        sourceId: entry.id,
                        type: args.type,
                        amount: D(args.amount),
                        chargeAmount: args.charge ? D(args.charge) : null,
                        description: args.description,
                        transactionDate: day(args.date),
                    },
                });
            }

            await posting.post(tx, buildEntryJournal({
                ...ctx,
                cashbookId: args.cashbookId,
                entryId: entry.id,
                version: entry.version,
                type: args.type,
                amount: args.amount,
                chargeAmount: args.charge ?? null,
                description: args.description,
                entryDate: day(args.date),
                createdById: user.id,
                accountId: args.accountId ?? null,
                categoryId: args.categoryId ?? null,
                contactId: args.contactId ?? null,
                obligation: args.obligation ?? null,
            }));

            return entry;
        });
    };

    // Unlinked income — moves book cash.
    await postEntry({
        cashbookId: shop.id, type: 'INCOME', amount: '450000',
        description: 'Counter sales, week 1', date: '2026-01-08', categoryId: salesCat.id,
    });
    // Wallet-linked income — moves the wallet, NOT book cash, but still counts
    // toward money-in. This is the product's defining rule.
    await postEntry({
        cashbookId: online.id, type: 'INCOME', amount: '1200000', charge: '18000',
        description: 'Online orders (payment gateway)', date: '2026-01-12',
        accountId: bank.id, categoryId: salesCat.id,
    });
    // Unlinked expense against a mapped category.
    await postEntry({
        cashbookId: shop.id, type: 'EXPENSE', amount: '300000',
        description: 'January rent', date: '2026-01-05', categoryId: rentCat.id,
    });
    // Wallet-linked expense with a charge.
    await postEntry({
        cashbookId: shop.id, type: 'EXPENSE', amount: '85000', charge: '2500',
        description: 'Packaging supplies', date: '2026-01-15',
        accountId: card.id, categoryId: suppliesCat.id, contactId: vendor.id,
    });
    // An entry we will edit, and one we will reverse.
    const toEdit = await postEntry({
        cashbookId: shop.id, type: 'INCOME', amount: '90000',
        description: 'Walk-in sale (to be corrected)', date: '2026-01-18', categoryId: salesCat.id,
    });
    const toReverse = await postEntry({
        cashbookId: shop.id, type: 'EXPENSE', amount: '40000',
        description: 'Duplicate entry (to be reversed)', date: '2026-01-19',
        accountId: cash.id,
    });
    console.log('  ✓ Entries posted (unlinked, wallet-linked, charged)');

    // ─── Edit: reverse v1, post v2 ───────────────────────
    await prisma.$transaction(async (tx) => {
        const updated = await tx.entry.update({
            where: { id: toEdit.id },
            data: { amount: D('135000'), description: 'Walk-in sale (corrected)', version: { increment: 1 } },
        });
        await posting.repost(tx, {
            originalPostingKey: `entry:${toEdit.id}:v1`,
            reason: 'Amount corrected',
            createdById: user.id,
            next: buildEntryJournal({
                ...ctx,
                cashbookId: shop.id,
                entryId: toEdit.id,
                version: updated.version,
                type: 'INCOME',
                amount: '135000',
                description: updated.description,
                entryDate: updated.entryDate,
                createdById: user.id,
                categoryId: salesCat.id,
            }),
        });
    });
    console.log('  ✓ Entry edited (reverse-and-repost)');

    // ─── Reversal: the "delete" path ─────────────────────
    await prisma.$transaction(async (tx) => {
        await posting.reverse(tx, {
            workspaceId: workspace.id,
            originalPostingKey: `entry:${toReverse.id}:v1`,
            reason: 'Duplicate',
            createdById: user.id,
        });
        await tx.entry.update({
            where: { id: toReverse.id },
            data: {
                status: 'REVERSED', isDeleted: true,
                reversedAt: new Date(), reversedById: user.id,
                reversalReason: 'Duplicate', deletedAt: new Date(), deletedReason: 'Duplicate',
            },
        });
        await tx.accountTransaction.updateMany({
            where: { sourceId: toReverse.id },
            data: { voidedAt: new Date() },
        });
    });
    console.log('  ✓ Entry reversed (original journal retained)');

    // ─── Receivable settled in two instalments ───────────
    const receivable = await prisma.$transaction(async (tx) => {
        const obligation = await tx.cashbookObligation.create({
            data: {
                workspaceId: workspace.id,
                cashbookId: online.id,
                type: 'RECEIVABLE',
                title: 'INV-2026-001',
                totalAmount: D('800000'),
                outstandingAmount: D('800000'),
                status: 'OPEN',
                dueDate: day('2026-02-15'),
                contactId: customer.id,
                referenceType: 'INVOICE',
            },
        });
        await posting.post(tx, buildObligationJournal({
            ...ctx,
            cashbookId: online.id,
            obligationId: obligation.id,
            version: obligation.version,
            type: 'RECEIVABLE',
            totalAmount: '800000',
            title: obligation.title,
            entryDate: day('2026-01-20'),
            createdById: user.id,
            contactId: customer.id,
        }));
        return obligation;
    });

    for (const [amount, date, wallet] of [
        ['500000', '2026-02-01', bank.id],
        ['300000', '2026-02-20', undefined],
    ] as const) {
        await postEntry({
            cashbookId: online.id, type: 'INCOME', amount,
            description: `Payment for ${receivable.title}`, date,
            accountId: wallet, contactId: customer.id, categoryId: salesCat.id,
            obligation: { id: receivable.id, type: 'RECEIVABLE' },
        });
        const remaining = await prisma.cashbookObligation.findUniqueOrThrow({
            where: { id: receivable.id },
        });
        const next = new Decimal(remaining.outstandingAmount).sub(amount);
        await prisma.cashbookObligation.update({
            where: { id: receivable.id },
            data: {
                outstandingAmount: next,
                status: next.lessThanOrEqualTo(0) ? 'PAID' : 'PARTIAL',
            },
        });
    }
    console.log('  ✓ Receivable opened and settled in two instalments');

    // ─── A receivable that is written off ────────────────
    const badDebt = await prisma.$transaction(async (tx) => {
        const obligation = await tx.cashbookObligation.create({
            data: {
                workspaceId: workspace.id, cashbookId: online.id, type: 'RECEIVABLE',
                title: 'INV-2026-002', totalAmount: D('150000'),
                outstandingAmount: D('150000'), status: 'OPEN',
                dueDate: day('2026-02-28'), contactId: customer.id,
            },
        });
        await posting.post(tx, buildObligationJournal({
            ...ctx, cashbookId: online.id, obligationId: obligation.id,
            version: obligation.version, type: 'RECEIVABLE', totalAmount: '150000',
            title: obligation.title, entryDate: day('2026-01-25'),
            createdById: user.id, contactId: customer.id,
        }));
        return obligation;
    });

    await prisma.$transaction(async (tx) => {
        await posting.post(tx, buildObligationWriteOffJournal({
            ...ctx, cashbookId: online.id, obligationId: badDebt.id,
            type: 'RECEIVABLE', outstandingAmount: '150000', title: badDebt.title,
            entryDate: day('2026-03-31'), createdById: user.id,
            contactId: customer.id, reason: 'Customer ceased trading',
        }));
        await tx.cashbookObligation.update({
            where: { id: badDebt.id },
            data: { status: 'CANCELLED', outstandingAmount: D(0) },
        });
    });
    console.log('  ✓ Receivable written off');

    // ─── Wallet transfer with a fee, and a direct wallet tx ──
    await prisma.$transaction(async (tx) => {
        const transfer = await tx.accountTransfer.create({
            data: {
                workspaceId: workspace.id,
                fromAccountId: bank.id,
                toAccountId: cash.id,
                amount: D('200000'),
                feeAmount: D('3000'),
                description: 'Cash float top-up',
                transferredAt: day('2026-02-05'),
                createdById: user.id,
            },
        });
        await posting.post(tx, buildTransferJournal({
            ...ctx,
            transferId: transfer.id,
            fromAccountId: bank.id,
            toAccountId: cash.id,
            amount: '200000',
            feeAmount: '3000',
            description: 'Cash float top-up',
            transferredAt: day('2026-02-05'),
            createdById: user.id,
        }));
    });

    await prisma.$transaction(async (tx) => {
        const walletTx = await tx.accountTransaction.create({
            data: {
                workspaceId: workspace.id, accountId: bank.id, sourceType: 'DIRECT',
                type: 'EXPENSE', amount: D('25000'), description: 'Monthly bank charges',
                transactionDate: day('2026-02-28'),
            },
        });
        await posting.post(tx, buildDirectWalletJournal({
            ...ctx, accountId: bank.id, transactionId: walletTx.id,
            version: walletTx.version, type: 'EXPENSE', amount: '25000',
            description: 'Monthly bank charges', transactionDate: day('2026-02-28'),
            createdById: user.id,
        }));
    });
    console.log('  ✓ Transfer and direct wallet transaction posted');

    // ─── Manual journal: an accrual only an accountant would post ──
    await prisma.$transaction(async (tx) => {
        const [depreciation, equity] = await Promise.all([
            // System accounts became currency-scoped in 0007, so the key is
            // (workspace, systemKey, currency) — one Sales Revenue per currency,
            // because each currency's books have to balance independently.
            tx.ledgerAccount.findUniqueOrThrow({
                where: {
                    workspaceId_systemKey_currency: {
                        workspaceId: workspace.id,
                        systemKey: 'GENERAL_EXPENSES',
                        currency: 'UGX',
                    },
                },
            }),
            tx.ledgerAccount.findUniqueOrThrow({
                where: {
                    workspaceId_systemKey_currency: {
                        workspaceId: workspace.id,
                        systemKey: 'OWNER_DRAWINGS',
                        currency: 'UGX',
                    },
                },
            }),
        ]);

        await posting.post(tx, {
            workspaceId: workspace.id,
            cashbookId: null,
            currency: 'UGX',
            entryDate: day('2026-03-31'),
            description: "Owner's drawings for Q1",
            sourceType: 'MANUAL',
            sourceId: null,
            postingKey: 'manual:seed-drawings-q1',
            createdById: user.id,
            legs: [
                { ref: { kind: 'EXPLICIT', ledgerAccountId: equity.id }, debit: D('120000') },
                { ref: { kind: 'EXPLICIT', ledgerAccountId: depreciation.id }, credit: D('120000') },
            ],
        });
    });
    console.log('  ✓ Manual journal posted');

    // ─── Verify the books ────────────────────────────────
    console.log('\nVerifying…');
    const integrity = new LedgerIntegrityService(prisma);
    const report = await integrity.verifyWorkspace(workspace.id);

    if (!report.ok) {
        console.error('\n✗ SEED PRODUCED INCONSISTENT BOOKS:\n');
        for (const f of report.findings) {
            console.error(`  ${f.check} — ${f.subject}`);
            console.error(`      expected ${f.expected}, got ${f.actual} (Δ ${f.difference})`);
        }
        throw new Error(
            'Seed verification failed. The posting rules and the cached balances disagree.',
        );
    }

    const [totals] = await prisma.$queryRaw<Array<{ debit: Decimal; credit: Decimal }>>`
        SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
        FROM journal_lines WHERE workspace_id = ${workspace.id}::uuid
    `;

    console.log(`  ✓ Trial balance: debits ${totals.debit} = credits ${totals.credit}`);
    console.log(`  ✓ ${report.stats.journalEntries} journals, ${report.stats.journalLines} lines`);
    console.log('  ✓ Every cached balance matches the ledger');

    const books = await prisma.cashbook.findMany({
        where: { workspaceId: workspace.id },
        select: { name: true, balance: true, totalIncome: true, totalExpense: true },
    });
    console.log('\n  Cashbooks:');
    for (const b of books) {
        console.log(
            `    ${b.name.padEnd(14)} book cash ${b.balance.toString().padStart(12)} | ` +
            `in ${b.totalIncome.toString().padStart(10)} | out ${b.totalExpense.toString().padStart(10)}`,
        );
    }

    const accounts = await prisma.account.findMany({
        where: { workspaceId: workspace.id },
        select: { name: true, balance: true },
    });
    console.log('\n  Wallets:');
    for (const a of accounts) {
        console.log(`    ${a.name.padEnd(18)} ${a.balance.toString().padStart(12)}`);
    }

    console.log(`\n✓ Seed complete. Sign in as ${SEED_EMAIL} / demo1234\n`);
}

main()
    .catch((error) => {
        console.error('\nSeed failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
