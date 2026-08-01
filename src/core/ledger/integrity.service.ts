/**
 * Proves the books balance.
 *
 * Under the cash-basis model every check below is an EXACT equality with no
 * exception list — that is the payoff of the deferred-revenue design, and it is
 * what makes this safe to assert in tests and in shadow mode rather than
 * eyeball.
 *
 * Used by: the shadow-mode comparison, the integration test suite, the seed
 * script's self-verification, and the repair tooling.
 */
import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

export interface IntegrityFinding {
    check: string;
    /** Human-readable subject — a book or wallet name, never a bare id. */
    subject: string;
    /** The id, carried separately so support can use it without showing it. */
    subjectId: string | null;
    /** What the ledger says, which is the authority. */
    expected: string;
    /** What the cached column says. */
    actual: string;
    difference: string;
    /**
     * Whether recomputing the cache from the ledger fixes this.
     *
     * True for every cached-balance drift: the journal is the source of truth
     * and the column is a denormalisation, so rebuilding it changes no
     * accounting record. False for TRIAL_BALANCE and JOURNAL_HEADER_TOTALS —
     * those mean the journal ITSELF is wrong, which no cache rebuild can fix
     * and which needs a correcting entry rather than a repair button.
     */
    repairable: boolean;
    /** Plain-language explanation for whoever has to act on it. */
    explanation: string;
}

export interface IntegrityReport {
    workspaceId: string;
    ok: boolean;
    checkedAt: Date;
    findings: IntegrityFinding[];
    stats: {
        journalEntries: number;
        journalLines: number;
        cashbooks: number;
        wallets: number;
    };
}

const ZERO = new Decimal(0);

@injectable()
export class LedgerIntegrityService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    async verifyWorkspace(workspaceId: string): Promise<IntegrityReport> {
        const findings: IntegrityFinding[] = [];

        await this.checkTrialBalance(workspaceId, findings);
        await this.checkJournalTotals(workspaceId, findings);
        await this.checkCashbookCaches(workspaceId, findings);
        await this.checkWalletCaches(workspaceId, findings);
        await this.checkObligationControls(workspaceId, findings);

        const [journalEntries, journalLines, cashbooks, wallets] = await Promise.all([
            this.prisma.journalEntry.count({ where: { workspaceId } }),
            this.prisma.journalLine.count({ where: { workspaceId } }),
            this.prisma.cashbook.count({ where: { workspaceId } }),
            this.prisma.account.count({ where: { workspaceId } }),
        ]);

        return {
            workspaceId,
            ok: findings.length === 0,
            checkedAt: new Date(),
            findings,
            stats: { journalEntries, journalLines, cashbooks, wallets },
        };
    }

    /** The fundamental one: total debits must equal total credits. */
    private async checkTrialBalance(workspaceId: string, findings: IntegrityFinding[]) {
        const [row] = await this.prisma.$queryRaw<Array<{ debit: Decimal; credit: Decimal }>>`
            SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
            FROM journal_lines
            WHERE workspace_id = ${workspaceId}::uuid
        `;

        const debit = new Decimal(row?.debit ?? 0);
        const credit = new Decimal(row?.credit ?? 0);

        if (!debit.equals(credit)) {
            findings.push({
                check: 'TRIAL_BALANCE',
                subject: 'The general ledger',
                subjectId: workspaceId,
                expected: debit.toString(),
                actual: credit.toString(),
                difference: debit.sub(credit).toString(),
                repairable: false,
                explanation:
                    'Total debits do not equal total credits. This is the ledger itself '
                    + 'being wrong, not a stale figure, and it cannot be repaired '
                    + 'automatically — it needs a correcting entry. Contact support.',
            });
        }
    }

    /** Each journal's header totals must match the sum of its lines. */
    private async checkJournalTotals(workspaceId: string, findings: IntegrityFinding[]) {
        const rows = await this.prisma.$queryRaw<
            Array<{ id: string; header_debit: Decimal; line_debit: Decimal }>
        >`
            SELECT je.id,
                   je.total_debit AS header_debit,
                   COALESCE(SUM(jl.debit), 0) AS line_debit
            FROM journal_entries je
            LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
            WHERE je.workspace_id = ${workspaceId}::uuid
            GROUP BY je.id, je.total_debit
            HAVING je.total_debit <> COALESCE(SUM(jl.debit), 0)
        `;

        for (const row of rows) {
            findings.push({
                check: 'JOURNAL_HEADER_TOTALS',
                subject: 'A journal entry',
                subjectId: row.id,
                expected: new Decimal(row.line_debit).toString(),
                actual: new Decimal(row.header_debit).toString(),
                difference: new Decimal(row.header_debit).sub(row.line_debit).toString(),
                repairable: false,
                explanation:
                    'A journal\'s stated total does not match the lines inside it. '
                    + 'This needs investigating rather than recalculating.',
            });
        }
    }

    /**
     * Cashbook.balance must equal the signed balance of its book-cash account,
     * and its activity totals must equal the income/expense lines of its own
     * entries. Restricting to CASHBOOK_ENTRY is what keeps these columns
     * meaning what they have always meant.
     */
    private async checkCashbookCaches(workspaceId: string, findings: IntegrityFinding[]) {
        const cashbooks = await this.prisma.cashbook.findMany({
            where: { workspaceId },
            select: {
                id: true,
                name: true,
                balance: true,
                totalIncome: true,
                totalExpense: true,
                cashLedgerAccountId: true,
            },
        });

        for (const cashbook of cashbooks) {
            if (cashbook.cashLedgerAccountId) {
                const [row] = await this.prisma.$queryRaw<Array<{ net: Decimal }>>`
                    SELECT COALESCE(SUM(debit - credit), 0) AS net
                    FROM journal_lines
                    WHERE ledger_account_id = ${cashbook.cashLedgerAccountId}::uuid
                `;
                const ledgerBalance = new Decimal(row?.net ?? 0);
                if (!ledgerBalance.equals(cashbook.balance)) {
                    findings.push({
                        check: 'CASHBOOK_BALANCE',
                        subject: cashbook.name,
                        subjectId: cashbook.id,
                        expected: ledgerBalance.toString(),
                        actual: cashbook.balance.toString(),
                        difference: cashbook.balance.sub(ledgerBalance).toString(),
                        repairable: true,
                        explanation:
                            'The balance shown on this book has drifted from what its '
                            + 'transactions add up to. No transaction is wrong — only the '
                            + 'stored total. Recalculating fixes it.',
                    });
                }
            }

            const [totals] = await this.prisma.$queryRaw<
                Array<{ income: Decimal; expense: Decimal }>
            >`
                SELECT
                  COALESCE(SUM(CASE WHEN la.class = 'INCOME'  THEN jl.credit - jl.debit ELSE 0 END), 0) AS income,
                  COALESCE(SUM(CASE WHEN la.class = 'EXPENSE' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expense
                FROM journal_lines jl
                JOIN journal_entries  je ON je.id = jl.journal_entry_id
                JOIN ledger_accounts  la ON la.id = jl.ledger_account_id
                WHERE jl.cashbook_id = ${cashbook.id}::uuid
                  AND je.source_type = 'CASHBOOK_ENTRY'
            `;

            const ledgerIncome = new Decimal(totals?.income ?? 0);
            const ledgerExpense = new Decimal(totals?.expense ?? 0);

            if (!ledgerIncome.equals(cashbook.totalIncome)) {
                findings.push({
                    check: 'CASHBOOK_TOTAL_INCOME',
                    subject: cashbook.name,
                    subjectId: cashbook.id,
                    expected: ledgerIncome.toString(),
                    actual: cashbook.totalIncome.toString(),
                    difference: cashbook.totalIncome.sub(ledgerIncome).toString(),
                    repairable: true,
                    explanation:
                        'The money-in total on this book has drifted from its entries. '
                        + 'Recalculating fixes it; no entry changes.',
                });
            }
            if (!ledgerExpense.equals(cashbook.totalExpense)) {
                findings.push({
                    check: 'CASHBOOK_TOTAL_EXPENSE',
                    subject: cashbook.name,
                    subjectId: cashbook.id,
                    expected: ledgerExpense.toString(),
                    actual: cashbook.totalExpense.toString(),
                    difference: cashbook.totalExpense.sub(ledgerExpense).toString(),
                    repairable: true,
                    explanation:
                        'The money-out total on this book has drifted from its entries. '
                        + 'Recalculating fixes it; no entry changes.',
                });
            }
        }
    }

    private async checkWalletCaches(workspaceId: string, findings: IntegrityFinding[]) {
        const accounts = await this.prisma.account.findMany({
            where: { workspaceId, ledgerAccountId: { not: null } },
            select: { id: true, name: true, balance: true, ledgerAccountId: true },
        });

        for (const account of accounts) {
            const [row] = await this.prisma.$queryRaw<Array<{ net: Decimal }>>`
                SELECT COALESCE(SUM(debit - credit), 0) AS net
                FROM journal_lines
                WHERE ledger_account_id = ${account.ledgerAccountId!}::uuid
            `;
            const ledgerBalance = new Decimal(row?.net ?? 0);

            if (!ledgerBalance.equals(account.balance)) {
                findings.push({
                    check: 'WALLET_BALANCE',
                    subject: account.name,
                    subjectId: account.id,
                    expected: ledgerBalance.toString(),
                    actual: account.balance.toString(),
                    difference: account.balance.sub(ledgerBalance).toString(),
                    repairable: true,
                    explanation:
                        'The balance shown on this wallet has drifted from the movements '
                        + 'recorded against it. Recalculating fixes it; no movement changes.',
                });
            }
        }
    }

    /**
     * Open receivables must equal the AR control account, and payables the AP
     * account. A divergence here means a settlement path skipped a posting —
     * the single most valuable drift signal in the system.
     */
    private async checkObligationControls(workspaceId: string, findings: IntegrityFinding[]) {
        for (const [type, systemKey, sign] of [
            ['RECEIVABLE', 'AR', 1],
            ['PAYABLE', 'AP', -1],
        ] as const) {
            // One control account per currency; sum them all, since obligation
            // outstanding is not currency-partitioned on its own table.
            const controls = await this.prisma.ledgerAccount.findMany({
                where: { workspaceId, systemKey },
                select: { id: true },
            });
            if (controls.length === 0) continue;

            const [ledgerRow] = await this.prisma.$queryRaw<Array<{ net: Decimal }>>`
                SELECT COALESCE(SUM(debit - credit), 0) AS net
                FROM journal_lines
                WHERE ledger_account_id = ANY(${controls.map((c) => c.id)}::uuid[])
            `;
            const ledgerBalance = new Decimal(ledgerRow?.net ?? 0).mul(sign);

            const outstanding = await this.prisma.cashbookObligation.aggregate({
                where: {
                    workspaceId,
                    type,
                    status: { in: ['OPEN', 'PARTIAL'] },
                    archivedAt: null,
                },
                _sum: { outstandingAmount: true },
            });
            const expected = new Decimal(outstanding._sum.outstandingAmount ?? ZERO);

            if (!ledgerBalance.equals(expected)) {
                findings.push({
                    check: `${systemKey}_CONTROL`,
                    subject: type === 'RECEIVABLE' ? 'Money owed to you' : 'Money you owe',
                    subjectId: workspaceId,
                    repairable: false,
                    explanation:
                        'What the invoices and bills say is outstanding does not match the '
                        + 'ledger. That usually means a payment was recorded in a way that '
                        + 'updated one side only, so it needs looking at rather than '
                        + 'recalculating.',
                    expected: expected.toString(),
                    actual: ledgerBalance.toString(),
                    difference: ledgerBalance.sub(expected).toString(),
                });
            }
        }
    }
    /**
     * Rebuild the cached balance columns from the ledger.
     *
     * This is the answer to "my book does not balance" in almost every case,
     * and it is safe in a way worth being explicit about:
     *
     *   It writes NOTHING to journal_entries or journal_lines. Those are the
     *   accounting record and they are append-only. All it touches are the
     *   denormalised columns — Cashbook.balance/totalIncome/totalExpense and
     *   Account.balance — which exist so the UI does not have to sum the ledger
     *   on every page load.
     *
     * So it cannot violate double-entry, cannot change a reported figure that
     * was correct, and needs no adjusting entry. It is a cache rebuild, and the
     * ledger is the authority it rebuilds from.
     *
     * Deliberately does NOT attempt the non-repairable checks. A non-zero trial
     * balance or a mismatched AR control means the journal itself is wrong;
     * silently "fixing" a cache to agree with a wrong ledger would hide it.
     */
    async repairCachedBalances(workspaceId: string): Promise<{
        repaired: IntegrityFinding[];
        remaining: IntegrityFinding[];
    }> {
        const before = await this.verifyWorkspace(workspaceId);
        const repairable = before.findings.filter((finding: IntegrityFinding) => finding.repairable);

        for (const finding of repairable) {
            if (!finding.subjectId) continue;

            if (finding.check.startsWith('CASHBOOK_')) {
                const cashbook = await this.prisma.cashbook.findUnique({
                    where: { id: finding.subjectId },
                    select: { id: true, cashLedgerAccountId: true },
                });
                if (!cashbook?.cashLedgerAccountId) continue;

                const [balanceRow] = await this.prisma.$queryRaw<Array<{ net: Decimal }>>`
                    SELECT COALESCE(SUM(debit - credit), 0) AS net
                    FROM journal_lines
                    WHERE ledger_account_id = ${cashbook.cashLedgerAccountId}::uuid
                `;
                const [totals] = await this.prisma.$queryRaw<
                    Array<{ income: Decimal; expense: Decimal }>
                >`
                    SELECT
                      COALESCE(SUM(CASE WHEN la.class = 'INCOME'  THEN jl.credit - jl.debit ELSE 0 END), 0) AS income,
                      COALESCE(SUM(CASE WHEN la.class = 'EXPENSE' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expense
                    FROM journal_lines jl
                    JOIN journal_entries je ON je.id = jl.journal_entry_id
                    JOIN ledger_accounts la ON la.id = jl.ledger_account_id
                    WHERE jl.cashbook_id = ${cashbook.id}::uuid
                      AND je.source_type = 'CASHBOOK_ENTRY'
                `;

                await this.prisma.cashbook.update({
                    where: { id: cashbook.id },
                    data: {
                        balance: new Decimal(balanceRow?.net ?? 0),
                        totalIncome: new Decimal(totals?.income ?? 0),
                        totalExpense: new Decimal(totals?.expense ?? 0),
                    },
                });
            }

            if (finding.check === 'WALLET_BALANCE') {
                const account = await this.prisma.account.findUnique({
                    where: { id: finding.subjectId },
                    select: { id: true, ledgerAccountId: true },
                });
                if (!account?.ledgerAccountId) continue;

                const [row] = await this.prisma.$queryRaw<Array<{ net: Decimal }>>`
                    SELECT COALESCE(SUM(debit - credit), 0) AS net
                    FROM journal_lines
                    WHERE ledger_account_id = ${account.ledgerAccountId}::uuid
                `;
                await this.prisma.account.update({
                    where: { id: account.id },
                    data: { balance: new Decimal(row?.net ?? 0) },
                });
            }
        }

        // Re-verify rather than assume. If a repair did not take, the caller
        // should hear it from the same check that reported the problem.
        const after = await this.verifyWorkspace(workspaceId);
        return { repaired: repairable, remaining: after.findings };
    }

}
