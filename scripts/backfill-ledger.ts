/**
 * Replay pre-ledger data into the double-entry ledger.
 *
 * For workspaces created before the ledger existed, the cashbooks, wallets and
 * entries are all still there — but no journals back them, so the balance sheet
 * is empty and every cached balance is unexplained. This walks each workspace's
 * source records in chronological order and posts the journals the live code
 * would have posted at the time.
 *
 * ─── Principles ───
 *
 * • Source records are the truth. Journals are derived from Entry,
 *   AccountTransaction, AccountTransfer and CashbookObligation rows — never from
 *   the cached balances, which were produced by the arithmetic this ledger
 *   replaces and may themselves be wrong.
 *
 * • Idempotent. Posting keys match the live code exactly (`entry:<id>:v<n>`),
 *   so re-running is a no-op. Safe to run repeatedly, and safe to resume after
 *   a failure.
 *
 * • Nothing is guessed. A record that cannot be posted faithfully — a journal
 *   that would have to mix currencies, for instance — is skipped and reported
 *   with its id, never approximated.
 *
 * • Dry-run by default.
 *
 *   npm run backfill:ledger              inspect
 *   npm run backfill:ledger -- --apply   write
 *   npm run backfill:ledger -- --apply --workspace <id>
 */
import 'reflect-metadata';
import 'dotenv/config';
import { PrismaClient, Prisma, TransactionSourceType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

import { PostingService } from '../src/core/ledger/posting.service';
import { LedgerIntegrityService } from '../src/core/ledger/integrity.service';
import {
    ensureCashbookLedgerAccount,
    ensureDefaultAccountTypes,
    ensureWalletLedgerAccount,
    ensureWorkspaceChartOfAccounts,
    workspaceCurrencies,
} from '../src/core/ledger/coa.seed';
import { buildEntryJournal, entryPostingKey } from '../src/core/ledger/rules/entry.rules';
import {
    buildObligationJournal,
    buildObligationWriteOffJournal,
} from '../src/core/ledger/rules/obligation.rules';
import {
    buildDirectWalletJournal,
    buildOpeningBalanceJournal,
    buildTransferJournal,
} from '../src/core/ledger/rules/wallet.rules';

const prisma = new PrismaClient();
const posting = new PostingService();

const APPLY = process.argv.includes('--apply');
const ONLY_WORKSPACE = (() => {
    const i = process.argv.indexOf('--workspace');
    return i >= 0 ? process.argv[i + 1] : null;
})();

const D = (v: unknown) => new Decimal((v as string | number) ?? 0);

/** The description the old opening-balance path wrote. */
const OPENING_BALANCE_DESCRIPTION = 'Initial Balance';

interface Skipped {
    kind: string;
    id: string;
    reason: string;
}

interface WorkspaceResult {
    name: string;
    posted: Record<string, number>;
    skipped: Skipped[];
    cacheChanges: string[];
    integrityFindings: string[];
    trialBalance: { debit: string; credit: string } | null;
}

// ─────────────────────────────────────────────────────────
// Provisioning
// ─────────────────────────────────────────────────────────

/**
 * Give the workspace everything the posting rules need: a chart of accounts per
 * currency it holds money in, the default wallet types, and a ledger account for
 * every wallet and cashbook.
 */
async function provision(tx: Prisma.TransactionClient, workspaceId: string, result: WorkspaceResult) {
    {
        const { base, all } = await workspaceCurrencies(tx, workspaceId);

        for (const currency of all) {
            await ensureWorkspaceChartOfAccounts(tx, workspaceId, currency, base);
        }
        if (all.length > 1) {
            result.cacheChanges.push(
                `provisioned charts of accounts for ${all.join(', ')} — this workspace holds ` +
                'more than one currency, so each has its own set of system accounts',
            );
        }

        await ensureDefaultAccountTypes(tx, workspaceId);
    }

    const accounts = await tx.account.findMany({
        where: { workspaceId },
        include: { accountType: true },
    });
    for (const account of accounts) {
        await ensureWalletLedgerAccount(tx, account, account.accountType.classification);
    }

    const cashbooks = await tx.cashbook.findMany({ where: { workspaceId } });
    for (const cashbook of cashbooks) {
        await ensureCashbookLedgerAccount(tx, cashbook);
    }
}

// ─────────────────────────────────────────────────────────
// Replay
// ─────────────────────────────────────────────────────────

/**
 * Opening balances first, so every later movement lands on a wallet that
 * already holds its starting amount.
 *
 * The old code recorded these as DIRECT transactions described "Initial
 * Balance". Replaying them as ordinary wallet transactions would credit Other
 * Income and invent revenue that never existed, so they get the proper
 * `Dr Wallet / Cr Opening Balance Equity` treatment instead.
 */
async function replayOpeningBalances(tx: Prisma.TransactionClient, workspaceId: string, userId: string, result: WorkspaceResult) {
    const openings = await tx.accountTransaction.findMany({
        where: {
            workspaceId,
            sourceType: TransactionSourceType.DIRECT,
            description: OPENING_BALANCE_DESCRIPTION,
            voidedAt: null,
        },
        include: { account: true },
        orderBy: { createdAt: 'asc' },
    });

    for (const opening of openings) {
        // The old rows store the magnitude and encode direction in `type`.
        const signed = opening.type === 'INCOME' ? D(opening.amount) : D(opening.amount).negated();

        await posting.post(
                tx,
                buildOpeningBalanceJournal({
                    workspaceId,
                    accountId: opening.accountId,
                    amount: signed,
                    accountName: opening.account.name,
                    openedAt: opening.transactionDate ?? opening.createdAt,
                    currency: opening.account.currency,
                    createdById: userId,
                }),
                { onDuplicate: 'RETURN_EXISTING', applyCaches: false },
            );

        result.posted.openingBalances = (result.posted.openingBalances ?? 0) + 1;
    }
}

/** Receivables and payables, so entries settling them have an AR/AP balance to clear. */
async function replayObligations(tx: Prisma.TransactionClient, workspaceId: string, userId: string, result: WorkspaceResult) {
    const obligations = await tx.cashbookObligation.findMany({
        where: { workspaceId },
        include: { cashbook: { select: { currency: true } } },
        orderBy: { createdAt: 'asc' },
    });

    for (const obligation of obligations) {
        await posting.post(
                tx,
                buildObligationJournal({
                    workspaceId,
                    cashbookId: obligation.cashbookId,
                    obligationId: obligation.id,
                    version: obligation.version,
                    type: obligation.type as 'RECEIVABLE' | 'PAYABLE',
                    totalAmount: obligation.totalAmount,
                    title: obligation.title,
                    entryDate: obligation.createdAt,
                    currency: obligation.cashbook.currency,
                    createdById: userId,
                    contactId: obligation.contactId,
                }),
                { onDuplicate: 'RETURN_EXISTING', applyCaches: false },
            );
        result.posted.obligations = (result.posted.obligations ?? 0) + 1;
    }
}

/**
 * Entries, in business-date order.
 *
 * A wallet link is expressed by a non-voided CASHBOOK_ENTRY AccountTransaction,
 * exactly as the live read paths determine it.
 */
async function replayEntries(tx: Prisma.TransactionClient, workspaceId: string, userId: string, result: WorkspaceResult) {
    const entries = await tx.entry.findMany({
        where: { cashbook: { workspaceId } },
        include: {
            cashbook: { select: { id: true, currency: true } },
            obligation: { select: { id: true, type: true } },
            accountTransactions: {
                where: { voidedAt: null, sourceType: TransactionSourceType.CASHBOOK_ENTRY },
                include: { account: { select: { id: true, currency: true, name: true } } },
                take: 1,
            },
        },
        orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
    });

    for (const entry of entries) {
        const wallet = entry.accountTransactions[0]?.account ?? null;

        // A journal may never mix currencies and there is no FX rate to invent.
        // Legacy data allowed this pairing; current code does not.
        if (wallet && wallet.currency !== entry.cashbook.currency) {
            result.skipped.push({
                kind: 'entry',
                id: entry.id,
                reason:
                    `wallet "${wallet.name}" is ${wallet.currency} but the book is ` +
                    `${entry.cashbook.currency} — unlink the wallet or correct one of the ` +
                    'currencies, then re-run',
            });
            continue;
        }

        // A deleted entry's journal and its reversal would net to zero, so
        // posting the pair adds nothing but noise. Record the state instead.
        if (entry.isDeleted) {
            if (APPLY && entry.status !== 'REVERSED') {
                await tx.entry.update({
                    where: { id: entry.id },
                    data: {
                        status: 'REVERSED',
                        reversedAt: entry.deletedAt ?? entry.updatedAt,
                        reversalReason: entry.deletedReason ?? 'Deleted before the ledger existed',
                    },
                });
            }
            result.posted.reversedEntriesMarked = (result.posted.reversedEntriesMarked ?? 0) + 1;
            continue;
        }

        await posting.post(
                tx,
                buildEntryJournal({
                    workspaceId,
                    cashbookId: entry.cashbookId,
                    entryId: entry.id,
                    version: entry.version,
                    type: entry.type as 'INCOME' | 'EXPENSE',
                    amount: entry.amount,
                    chargeAmount: entry.chargeAmount,
                    description: entry.description,
                    entryDate: entry.entryDate,
                    currency: entry.cashbook.currency,
                    createdById: entry.createdById,
                    accountId: wallet?.id ?? null,
                    categoryId: entry.categoryId,
                    contactId: entry.contactId,
                    obligation: entry.obligation
                        ? {
                            id: entry.obligation.id,
                            type: entry.obligation.type as 'RECEIVABLE' | 'PAYABLE',
                        }
                        : null,
                }),
                { onDuplicate: 'RETURN_EXISTING', applyCaches: false },
            );

        result.posted.entries = (result.posted.entries ?? 0) + 1;
    }
}

/** Direct wallet transactions, excluding the opening balances already handled. */
async function replayWalletTransactions(tx: Prisma.TransactionClient, workspaceId: string, userId: string, result: WorkspaceResult) {
    const transactions = await tx.accountTransaction.findMany({
        where: {
            workspaceId,
            sourceType: TransactionSourceType.DIRECT,
            voidedAt: null,
            description: { not: OPENING_BALANCE_DESCRIPTION },
        },
        include: { account: { select: { id: true, currency: true } } },
        orderBy: { createdAt: 'asc' },
    });

    for (const transaction of transactions) {
        await posting.post(
                tx,
                buildDirectWalletJournal({
                    workspaceId,
                    accountId: transaction.accountId,
                    transactionId: transaction.id,
                    version: transaction.version,
                    type: transaction.type as 'INCOME' | 'EXPENSE',
                    amount: transaction.amount,
                    chargeAmount: transaction.chargeAmount,
                    description: transaction.description,
                    transactionDate: transaction.transactionDate ?? transaction.createdAt,
                    currency: transaction.account.currency,
                    createdById: userId,
                }),
                { onDuplicate: 'RETURN_EXISTING', applyCaches: false },
            );
        result.posted.walletTransactions = (result.posted.walletTransactions ?? 0) + 1;
    }
}

async function replayTransfers(tx: Prisma.TransactionClient, workspaceId: string, result: WorkspaceResult) {
    const transfers = await tx.accountTransfer.findMany({
        where: { workspaceId, voidedAt: null },
        include: {
            fromAccount: { select: { id: true, currency: true, name: true } },
            toAccount: { select: { id: true, currency: true, name: true } },
        },
        orderBy: { transferredAt: 'asc' },
    });

    for (const transfer of transfers) {
        if (transfer.fromAccount.currency !== transfer.toAccount.currency) {
            result.skipped.push({
                kind: 'transfer',
                id: transfer.id,
                reason:
                    `${transfer.fromAccount.name} is ${transfer.fromAccount.currency} but ` +
                    `${transfer.toAccount.name} is ${transfer.toAccount.currency} — a transfer ` +
                    'across currencies needs an FX rate, which this product does not model',
            });
            continue;
        }

        await posting.post(
                tx,
                buildTransferJournal({
                    workspaceId,
                    transferId: transfer.id,
                    fromAccountId: transfer.fromAccountId,
                    toAccountId: transfer.toAccountId,
                    amount: transfer.amount,
                    feeAmount: transfer.feeAmount,
                    description: transfer.description ?? 'Transfer',
                    transferredAt: transfer.transferredAt,
                    currency: transfer.fromAccount.currency,
                    createdById: transfer.createdById,
                }),
                { onDuplicate: 'RETURN_EXISTING', applyCaches: false },
            );
        result.posted.transfers = (result.posted.transfers ?? 0) + 1;
    }
}

/**
 * Bring each obligation's outstanding balance back in line with the entries
 * that actually settled it.
 *
 * `outstandingAmount` has always been a denormalized cache — settlement only
 * ever happens through an Entry — so the entries are authoritative. Legacy data
 * contains obligations marked PAID with no settling entry at all, which is how
 * an AR balance ends up on the books with nothing to explain it.
 */
async function reconcileObligations(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    result: WorkspaceResult,
) {
    const obligations = await tx.cashbookObligation.findMany({
        where: { workspaceId },
        select: {
            id: true, title: true, type: true, status: true,
            totalAmount: true, outstandingAmount: true, archivedAt: true,
        },
    });

    for (const obligation of obligations) {
        // CANCELLED is sticky; its remaining balance is written off below
        // rather than recomputed.
        if (obligation.status === 'CANCELLED') continue;

        const settled = await tx.entry.aggregate({
            where: { obligationId: obligation.id, isDeleted: false },
            _sum: { amount: true },
        });

        const total = D(obligation.totalAmount);
        const paid = D(settled._sum.amount);
        const implied = total.sub(paid);
        const capped = implied.lessThan(0) ? new Decimal(0) : implied;
        const stored = D(obligation.outstandingAmount);

        if (capped.equals(stored)) continue;

        const status = capped.lessThanOrEqualTo(0)
            ? 'PAID'
            : capped.greaterThanOrEqualTo(total)
                ? 'OPEN'
                : 'PARTIAL';

        result.cacheChanges.push(
            `obligation "${obligation.title}" outstanding: ${stored} → ${capped} ` +
            `(entries settling it total ${paid} of ${total}); status ${obligation.status} → ${status}`,
        );

        if (APPLY) {
            await tx.cashbookObligation.update({
                where: { id: obligation.id },
                data: { outstandingAmount: capped, status },
            });
        }
    }
}

/**
 * Close out obligations that are no longer collectable, last — after the
 * payments that reduced them, or the write-off would be for too much.
 *
 * Two cases, both matching what the live code now does:
 *   • CANCELLED — explicitly written off.
 *   • archived while still OPEN — archiving an open obligation means we are not
 *     collecting it, so its balance must come off the books too. The old code
 *     archived without posting anything, leaving the receivable stranded.
 */
async function replayClosures(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    userId: string,
    result: WorkspaceResult,
) {
    const closed = await tx.cashbookObligation.findMany({
        where: {
            workspaceId,
            OR: [{ status: 'CANCELLED' }, { archivedAt: { not: null } }],
        },
        include: { cashbook: { select: { currency: true } } },
    });

    for (const obligation of closed) {
        // How much was still owed when it closed: the total less whatever the
        // entries actually settled. Reading outstandingAmount instead would
        // trust a cache the previous step may just have corrected.
        const settled = await tx.entry.aggregate({
            where: { obligationId: obligation.id, isDeleted: false },
            _sum: { amount: true },
        });
        const outstanding = D(obligation.totalAmount).sub(D(settled._sum.amount));

        if (outstanding.lessThanOrEqualTo(0)) continue;

        await posting.post(
            tx,
            buildObligationWriteOffJournal({
                workspaceId,
                cashbookId: obligation.cashbookId,
                obligationId: obligation.id,
                type: obligation.type as 'RECEIVABLE' | 'PAYABLE',
                outstandingAmount: outstanding,
                title: obligation.title,
                entryDate: obligation.updatedAt,
                currency: obligation.cashbook.currency,
                createdById: userId,
                contactId: obligation.contactId,
                reason:
                    obligation.status === 'CANCELLED'
                        ? 'Cancelled before the ledger existed'
                        : 'Archived while still open, before the ledger existed',
            }),
            { onDuplicate: 'RETURN_EXISTING', applyCaches: false },
        );

        if (APPLY) {
            await tx.cashbookObligation.update({
                where: { id: obligation.id },
                data: { status: 'CANCELLED', outstandingAmount: new Decimal(0) },
            });
        }

        result.posted.writeOffs = (result.posted.writeOffs ?? 0) + 1;
    }
}

// ─────────────────────────────────────────────────────────
// Reconcile
// ─────────────────────────────────────────────────────────

/**
 * Rewrite the cached balances from the ledger we just built.
 *
 * Every posting above ran with `applyCaches: false`, because incrementing the
 * caches during replay would double-count what the old arithmetic already put
 * there. Instead the caches are recomputed once at the end, and any difference
 * from the stored value is reported — that difference is drift the old code
 * left behind, and worth seeing.
 */
async function reconcileCaches(tx: Prisma.TransactionClient, workspaceId: string, result: WorkspaceResult) {
    // A skipped record is money the ledger does not know about. Rewriting the
    // caches from an incomplete ledger would quietly erase it from the balances
    // while the source row still sits in the database — worse than leaving the
    // old figures alone and saying so.
    if (result.skipped.length > 0) {
        result.cacheChanges.push(
            `cached balances left untouched: ${result.skipped.length} record(s) could not be ` +
            'posted, so the ledger is incomplete for this workspace. Resolve them and re-run.',
        );
        return;
    }

    const cashbooks = await tx.cashbook.findMany({
        where: { workspaceId },
        select: {
            id: true, name: true, balance: true, totalIncome: true, totalExpense: true,
            cashLedgerAccountId: true,
        },
    });

    for (const cashbook of cashbooks) {
        if (!cashbook.cashLedgerAccountId) continue;

        const [bookCash] = await tx.$queryRaw<Array<{ net: Decimal }>>`
            SELECT COALESCE(SUM(debit - credit), 0) AS net
            FROM journal_lines WHERE ledger_account_id = ${cashbook.cashLedgerAccountId}::uuid
        `;
        const [totals] = await tx.$queryRaw<Array<{ income: Decimal; expense: Decimal }>>`
            SELECT
              COALESCE(SUM(CASE WHEN la.class = 'INCOME'  THEN jl.credit - jl.debit ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN la.class = 'EXPENSE' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expense
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.journal_entry_id
            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
            WHERE jl.cashbook_id = ${cashbook.id}::uuid AND je.source_type = 'CASHBOOK_ENTRY'
        `;

        const next = {
            balance: D(bookCash?.net),
            totalIncome: D(totals?.income),
            totalExpense: D(totals?.expense),
        };

        for (const [field, value] of Object.entries(next) as Array<[keyof typeof next, Decimal]>) {
            const stored = D(cashbook[field]);
            if (!stored.equals(value)) {
                result.cacheChanges.push(
                    `book "${cashbook.name}" ${field}: ${stored} → ${value} (Δ ${value.sub(stored)})`,
                );
            }
        }

        if (APPLY) {
            await tx.cashbook.update({ where: { id: cashbook.id }, data: next });
        }
    }

    const accounts = await tx.account.findMany({
        where: { workspaceId, ledgerAccountId: { not: null } },
        select: { id: true, name: true, balance: true, ledgerAccountId: true },
    });

    for (const account of accounts) {
        const [row] = await tx.$queryRaw<Array<{ net: Decimal }>>`
            SELECT COALESCE(SUM(debit - credit), 0) AS net
            FROM journal_lines WHERE ledger_account_id = ${account.ledgerAccountId!}::uuid
        `;
        const ledger = D(row?.net);

        if (!ledger.equals(account.balance)) {
            result.cacheChanges.push(
                `wallet "${account.name}" balance: ${account.balance} → ${ledger} ` +
                `(Δ ${ledger.sub(D(account.balance))})`,
            );
        }

        if (APPLY) {
            await tx.account.update({ where: { id: account.id }, data: { balance: ledger } });
        }
    }
}

// ─────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────

/** Sentinel used to roll back a dry run once the report has been gathered. */
class DryRun extends Error {
    constructor(public readonly result: WorkspaceResult) {
        super('dry run');
    }
}

/**
 * Backfill one workspace inside a single transaction.
 *
 * A dry run does all the same work and then throws, so Postgres rolls
 * everything back — the report is accurate but the database is untouched.
 * Anything less would leave a half-migrated workspace: journals written but
 * caches stale, which is worse than not starting.
 */
async function backfillWorkspace(workspace: { id: string; name: string; ownerId: string }) {
    const result: WorkspaceResult = {
        name: workspace.name,
        posted: {},
        skipped: [],
        cacheChanges: [],
        integrityFindings: [],
        trialBalance: null,
    };

    try {
        await prisma.$transaction(
            async (tx) => {
                await provision(tx, workspace.id, result);

                // Order matters: opening balances before movements; obligations
                // before the entries that settle them; cancellations after those
                // settlements, or the write-off would be for too much.
                await replayOpeningBalances(tx, workspace.id, workspace.ownerId, result);
                await replayObligations(tx, workspace.id, workspace.ownerId, result);
                await replayEntries(tx, workspace.id, workspace.ownerId, result);
                await replayWalletTransactions(tx, workspace.id, workspace.ownerId, result);
                await replayTransfers(tx, workspace.id, result);

                // Obligation caches are rebuilt from the settling entries before
                // anything is written off, so the write-off is for the amount
                // genuinely still owed.
                await reconcileObligations(tx, workspace.id, result);
                await replayClosures(tx, workspace.id, workspace.ownerId, result);

                await reconcileCaches(tx, workspace.id, result);

                const [tb] = await tx.$queryRaw<Array<{ debit: Decimal; credit: Decimal }>>`
                    SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
                    FROM journal_lines WHERE workspace_id = ${workspace.id}::uuid
                `;
                result.trialBalance = {
                    debit: D(tb?.debit).toString(),
                    credit: D(tb?.credit).toString(),
                };

                if (!APPLY) throw new DryRun(result);
            },
            // Generous: a large tenant replays thousands of records, and the
            // whole workspace has to be one atomic unit.
            { timeout: 600_000, maxWait: 30_000 },
        );
    } catch (error) {
        if (!(error instanceof DryRun)) throw error;
        // Expected: the rollback we asked for.
    }

    // Verifying inside the transaction would read uncommitted state, and on a
    // dry run there is nothing committed to verify.
    if (APPLY) {
        const integrity = new LedgerIntegrityService(prisma);
        const report = await integrity.verifyWorkspace(workspace.id);
        result.integrityFindings = report.findings.map(
            (f) => `${f.check} ${f.subject}: expected ${f.expected}, got ${f.actual}`,
        );
    }

    return result;
}

async function main() {
    console.log(
        APPLY
            ? 'Backfilling the ledger from existing records…\n'
            : 'Previewing the ledger backfill (dry run; pass --apply to write)…\n',
    );

    if (!APPLY) {
        console.log(
            '  A dry run performs the entire backfill inside a transaction and then rolls\n' +
            '  it back, so the figures below are exactly what --apply would produce and\n' +
            '  the database is left untouched.\n',
        );
    }

    const workspaces = await prisma.workspace.findMany({
        where: ONLY_WORKSPACE ? { id: ONLY_WORKSPACE } : {},
        select: { id: true, name: true, ownerId: true },
        orderBy: { createdAt: 'asc' },
    });

    const results: WorkspaceResult[] = [];

    for (const workspace of workspaces) {
        process.stdout.write(`${workspace.name}… `);
        try {
            const result = await backfillWorkspace(workspace);
            results.push(result);
            const total = Object.values(result.posted).reduce((a, b) => a + b, 0);
            console.log(`${total} record(s), ${result.skipped.length} skipped`);
        } catch (error) {
            console.log('FAILED');
            console.error(`  ${(error as Error).message}\n`);
            results.push({
                ...({} as WorkspaceResult),
                name: workspace.name,
                posted: {},
                skipped: [{ kind: 'workspace', id: workspace.id, reason: (error as Error).message }],
                cacheChanges: [],
                integrityFindings: [],
                trialBalance: null,
            });
        }
    }

    // ─── Report ──────────────────────────────────────────
    console.log(`\n${'═'.repeat(70)}\n`);

    for (const r of results) {
        const total = Object.values(r.posted).reduce((a, b) => a + b, 0);
        if (total === 0 && r.skipped.length === 0 && r.cacheChanges.length === 0) continue;

        console.log(r.name);

        if (total > 0) {
            const parts = Object.entries(r.posted).map(([k, v]) => `${v} ${k}`);
            console.log(`  posted: ${parts.join(', ')}`);
        }

        if (r.trialBalance) {
            const balanced = r.trialBalance.debit === r.trialBalance.credit;
            console.log(
                `  trial balance: ${r.trialBalance.debit} / ${r.trialBalance.credit} ` +
                `${balanced ? '✓' : '✗ OUT OF BALANCE'}`,
            );
        }

        for (const change of r.cacheChanges) {
            console.log(`  ${APPLY ? 'corrected' : 'would correct'}: ${change}`);
        }

        for (const s of r.skipped) {
            console.log(`  ⚠ skipped ${s.kind} ${s.id}`);
            console.log(`      ${s.reason}`);
        }

        for (const f of r.integrityFindings) {
            console.log(`  ✗ ${f}`);
        }

        console.log('');
    }

    const totalSkipped = results.reduce((n, r) => n + r.skipped.length, 0);
    const totalFindings = results.reduce((n, r) => n + r.integrityFindings.length, 0);
    const totalPosted = results.reduce(
        (n, r) => n + Object.values(r.posted).reduce((a, b) => a + b, 0), 0,
    );

    console.log('─'.repeat(70));
    console.log(`Workspaces:     ${results.length}`);
    console.log(`Records posted: ${totalPosted}`);
    console.log(`Skipped:        ${totalSkipped}`);
    if (APPLY) console.log(`Integrity:      ${totalFindings === 0 ? 'clean' : `${totalFindings} finding(s)`}`);

    if (totalSkipped > 0) {
        console.log(
            '\nSkipped records are reported above with the reason. They are data the\n' +
            'ledger cannot represent faithfully — fix the underlying record and re-run;\n' +
            'the backfill is idempotent, so nothing already posted is duplicated.',
        );
    }

    if (!APPLY) {
        console.log('\nRe-run with --apply to rewrite the cached balances from the ledger.');
    }

    if (totalFindings > 0) process.exitCode = 1;
}

main()
    .catch((error) => {
        console.error('\nBackfill failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
