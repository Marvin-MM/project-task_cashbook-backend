/**
 * Recompute cached balances from the ledger.
 *
 * Before the double-entry ledger existed, this script rebuilt caches by
 * replaying entries with the same formulas the write path used — so a bug in
 * those formulas produced identically wrong results in both places, and the
 * script could not detect it. Now the journal is the source of truth and this
 * simply re-derives each cache from the lines.
 *
 * Dry-run by default. Nothing is written without --apply.
 *
 *   npm run repair:balances          inspect
 *   npm run repair:balances:apply    fix
 */
import 'reflect-metadata';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { LedgerIntegrityService } from '../src/core/ledger/integrity.service';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

interface Fix {
    entity: string;
    id: string;
    label: string;
    field: string;
    stored: string;
    ledger: string;
    difference: string;
}

const D = (v: unknown) => new Decimal((v as string | number) ?? 0);

async function ledgerBalance(ledgerAccountId: string): Promise<Decimal> {
    const [row] = await prisma.$queryRaw<Array<{ net: Decimal }>>`
        SELECT COALESCE(SUM(debit - credit), 0) AS net
        FROM journal_lines WHERE ledger_account_id = ${ledgerAccountId}::uuid
    `;
    return D(row?.net);
}

async function repairCashbooks(workspaceId: string, fixes: Fix[]) {
    const cashbooks = await prisma.cashbook.findMany({
        where: { workspaceId },
        select: {
            id: true, name: true, balance: true, totalIncome: true, totalExpense: true,
            cashLedgerAccountId: true,
        },
    });

    for (const cashbook of cashbooks) {
        const updates: Record<string, Decimal> = {};

        if (cashbook.cashLedgerAccountId) {
            const ledger = await ledgerBalance(cashbook.cashLedgerAccountId);
            if (!ledger.equals(cashbook.balance)) {
                fixes.push({
                    entity: 'cashbook', id: cashbook.id, label: cashbook.name, field: 'balance',
                    stored: cashbook.balance.toString(), ledger: ledger.toString(),
                    difference: cashbook.balance.sub(ledger).toString(),
                });
                updates.balance = ledger;
            }
        } else {
            console.warn(
                `  ! ${cashbook.name} has no book-cash ledger account; ` +
                'open it once in the app so it is provisioned, then re-run.',
            );
        }

        // Restricted to CASHBOOK_ENTRY, which is what keeps these columns
        // meaning what they have always meant: direct wallet activity and
        // transfers have never counted as cashbook activity.
        const [totals] = await prisma.$queryRaw<Array<{ income: Decimal; expense: Decimal }>>`
            SELECT
              COALESCE(SUM(CASE WHEN la.class = 'INCOME'  THEN jl.credit - jl.debit ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN la.class = 'EXPENSE' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expense
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.journal_entry_id
            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
            WHERE jl.cashbook_id = ${cashbook.id}::uuid
              AND je.source_type = 'CASHBOOK_ENTRY'
        `;

        const income = D(totals?.income);
        const expense = D(totals?.expense);

        if (!income.equals(cashbook.totalIncome)) {
            fixes.push({
                entity: 'cashbook', id: cashbook.id, label: cashbook.name, field: 'totalIncome',
                stored: cashbook.totalIncome.toString(), ledger: income.toString(),
                difference: cashbook.totalIncome.sub(income).toString(),
            });
            updates.totalIncome = income;
        }
        if (!expense.equals(cashbook.totalExpense)) {
            fixes.push({
                entity: 'cashbook', id: cashbook.id, label: cashbook.name, field: 'totalExpense',
                stored: cashbook.totalExpense.toString(), ledger: expense.toString(),
                difference: cashbook.totalExpense.sub(expense).toString(),
            });
            updates.totalExpense = expense;
        }

        if (APPLY && Object.keys(updates).length > 0) {
            await prisma.cashbook.update({ where: { id: cashbook.id }, data: updates });
        }
    }
}

async function repairWallets(workspaceId: string, fixes: Fix[]) {
    const accounts = await prisma.account.findMany({
        where: { workspaceId },
        select: { id: true, name: true, balance: true, ledgerAccountId: true },
    });

    for (const account of accounts) {
        if (!account.ledgerAccountId) {
            console.warn(
                `  ! ${account.name} has no ledger account; ` +
                'open it once in the app so it is provisioned, then re-run.',
            );
            continue;
        }

        const ledger = await ledgerBalance(account.ledgerAccountId);
        if (!ledger.equals(account.balance)) {
            fixes.push({
                entity: 'account', id: account.id, label: account.name, field: 'balance',
                stored: account.balance.toString(), ledger: ledger.toString(),
                difference: account.balance.sub(ledger).toString(),
            });
            if (APPLY) {
                await prisma.account.update({
                    where: { id: account.id },
                    data: { balance: ledger },
                });
            }
        }
    }
}

/**
 * Obligation outstanding is its own source of truth; the AR/AP control accounts
 * are checked AGAINST it, not derived from it. A divergence means a settlement
 * path skipped a posting — a code bug this script must surface rather than
 * quietly paper over by adjusting one side to match the other.
 */
async function checkControls(workspaceId: string) {
    const integrity = new LedgerIntegrityService(prisma);
    const report = await integrity.verifyWorkspace(workspaceId);
    return report.findings.filter((f) => f.check.endsWith('_CONTROL') || f.check === 'TRIAL_BALANCE');
}

async function main() {
    console.log(
        APPLY
            ? 'Repairing cached balances from the ledger…\n'
            : 'Inspecting cached balances against the ledger (dry run; pass --apply to fix)…\n',
    );

    const workspaces = await prisma.workspace.findMany({
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
    });

    const allFixes: Fix[] = [];
    const controlIssues: Array<{ workspace: string; detail: string }> = [];

    const unbackfilled: string[] = [];

    for (const workspace of workspaces) {
        // A workspace with cached balances but no journals predates the ledger
        // and has not been backfilled. "Repairing" it would derive zero from an
        // empty ledger and wipe real balances — the opposite of a repair.
        const [journalCount, cachedActivity] = await Promise.all([
            prisma.journalEntry.count({ where: { workspaceId: workspace.id } }),
            prisma.cashbook.count({
                where: {
                    workspaceId: workspace.id,
                    OR: [
                        { balance: { not: 0 } },
                        { totalIncome: { not: 0 } },
                        { totalExpense: { not: 0 } },
                    ],
                },
            }),
        ]);

        if (journalCount === 0 && cachedActivity > 0) {
            unbackfilled.push(workspace.name);
            continue;
        }

        const fixes: Fix[] = [];
        await repairCashbooks(workspace.id, fixes);
        await repairWallets(workspace.id, fixes);

        const controls = await checkControls(workspace.id);
        for (const c of controls) {
            controlIssues.push({
                workspace: workspace.name,
                detail: `${c.check}: expected ${c.expected}, got ${c.actual} (Δ ${c.difference})`,
            });
        }

        if (fixes.length > 0 || controls.length > 0) {
            console.log(workspace.name);
            for (const f of fixes) {
                console.log(
                    `  ${f.entity} ${f.label} · ${f.field}: ` +
                    `stored ${f.stored} → ledger ${f.ledger} (Δ ${f.difference})`,
                );
            }
            for (const c of controls) {
                console.log(`  ⚠ ${c.check}: expected ${c.expected}, got ${c.actual}`);
            }
            console.log('');
        }

        allFixes.push(...fixes);
    }

    console.log('─'.repeat(64));
    console.log(`Workspaces scanned:  ${workspaces.length - unbackfilled.length}`);
    console.log(`Cache discrepancies: ${allFixes.length}${APPLY ? ' (repaired)' : ''}`);
    console.log(`Control mismatches:  ${controlIssues.length}`);

    if (controlIssues.length > 0) {
        console.log(
            '\n⚠ Control-account and trial-balance mismatches are NOT repaired here.\n' +
            '  They mean a posting was missed or a journal is unbalanced, which is a\n' +
            '  code bug rather than cache drift. Investigate before adjusting anything:\n',
        );
        for (const issue of controlIssues) {
            console.log(`    ${issue.workspace} — ${issue.detail}`);
        }
    }

    if (!APPLY && allFixes.length > 0) {
        console.log('\nRe-run with --apply to write these corrections.');
    }

    if (unbackfilled.length > 0) {
        console.log(
            `\nSkipped ${unbackfilled.length} workspace(s) with balances but no journals:\n` +
            `    ${unbackfilled.join(', ')}\n\n` +
            '  These predate the ledger. Repairing them would derive zero from an empty\n' +
            '  ledger and wipe their balances. Backfill them first, or reset the data.',
        );
    }

    if (allFixes.length === 0 && controlIssues.length === 0 && unbackfilled.length === 0) {
        console.log('\n✓ Every cached balance agrees with the ledger.');
    }

    // Non-zero exit so a cron wrapper or CI job can alert on a real problem.
    if (controlIssues.length > 0) process.exitCode = 1;
}

main()
    .catch((error) => {
        console.error('Repair failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
