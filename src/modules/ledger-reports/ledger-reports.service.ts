/**
 * Financial statements, produced from the ledger.
 *
 * ─── Two rules that apply to every query here ───
 *
 * 1. Never filter on JournalEntry.status. A REVERSED original and its REVERSING
 *    counterpart both contribute lines and net to zero. Filtering by status
 *    would remove the original but keep the reversal (or vice versa), double-
 *    counting the correction. Only the journal *list* UI filters by status.
 *
 * 2. Never sum across currencies. There is no FX in this product, so a combined
 *    total would be fiction. Every report groups by currency and returns a
 *    `byCurrency` array, mirroring the shape accounts.getNetWorth already uses.
 */
import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const ZERO = new Decimal(0);
const dec = (v: unknown) => new Decimal((v as string | number) ?? 0);

export interface ReportPeriod {
    from: Date;
    to: Date;
}

export interface AccountLine {
    ledgerAccountId: string;
    code: string;
    name: string;
    class: string;
    /** Presentation amount: positive means "more of what this account is". */
    amount: string;
}

export interface CurrencyScoped<T> {
    currency: string;
    sections: T;
    /** Must be "0". Rendered prominently when it is not. */
    outOfBalance: string;
}

export interface ReportEnvelope<T> {
    mixedCurrency: boolean;
    byCurrency: Array<CurrencyScoped<T>>;
    generatedAt: Date;
}

export interface BalanceSheetSections {
    asOf: string;
    assets: AccountLine[];
    liabilities: AccountLine[];
    equity: AccountLine[];
    /** Profit not yet rolled into retained earnings. Keeps the sheet balanced. */
    currentPeriodEarnings: string;
    totals: { assets: string; liabilities: string; equity: string };
}

export interface AgingItem {
    obligationId: string | null;
    title: string;
    contact: { id: string; name: string } | null;
    cashbook: { id: string; name: string } | null;
    dueDate: Date | null;
    daysOverdue: number;
    bucket: string;
    openBalance: string;
}

export interface IncomeStatementSections {
    period: { from: string; to: string };
    /** Per-book rows plus a consolidated roll-up (cashbookId null). */
    books: Array<{
        cashbookId: string | null;
        cashbookName: string;
        income: AccountLine[];
        expenses: AccountLine[];
        totals: { income: string; expenses: string; net: string };
    }>;
    consolidated: {
        income: AccountLine[];
        expenses: AccountLine[];
        totals: { income: string; expenses: string; net: string };
    };
}

@injectable()
export class LedgerReportsService {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    // ─── Balance Sheet ────────────────────────────────────

    /**
     * Assets = Liabilities + Equity, as of a date.
     *
     * Income and expense accounts are not listed, but their net for the current
     * fiscal year appears as "current period earnings" in equity — without it
     * the sheet would not balance until year-end close.
     */
    async balanceSheet(
        workspaceId: string,
        asOf: Date,
        fiscalYearStart: Date,
    ): Promise<ReportEnvelope<BalanceSheetSections>> {
        const rows = await this.prisma.$queryRaw<
            Array<{
                id: string; code: string; name: string; class: string;
                currency: string; net_debit: Decimal;
            }>
        >`
            SELECT la.id, la.code, la.name, la.class, la.currency,
                   COALESCE(SUM(jl.debit - jl.credit), 0) AS net_debit
            FROM ledger_accounts la
            LEFT JOIN journal_lines jl
                   ON jl.ledger_account_id = la.id
                  AND jl.entry_date <= ${asOf}
            WHERE la.workspace_id = ${workspaceId}::uuid
              AND la.class IN ('ASSET', 'LIABILITY', 'EQUITY')
              AND la.is_postable
            GROUP BY la.id, la.code, la.name, la.class, la.currency
            ORDER BY la.code
        `;

        const earningsRows = await this.prisma.$queryRaw<
            Array<{ currency: string; net: Decimal }>
        >`
            -- Profit is simply credit − debit across income and expense
            -- accounts: income is credit-normal so it contributes positively,
            -- expense is debit-normal so it contributes negatively. Signing the
            -- two branches the same way (both positive) would sum them instead
            -- of netting them.
            SELECT la.currency,
                   COALESCE(SUM(jl.credit - jl.debit), 0) AS net
            FROM journal_lines jl
            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
            WHERE jl.workspace_id = ${workspaceId}::uuid
              AND la.class IN ('INCOME', 'EXPENSE')
              AND jl.entry_date >= ${fiscalYearStart}
              AND jl.entry_date <= ${asOf}
            GROUP BY la.currency
        `;

        const currencies = this.currencySet(rows, earningsRows);
        const byCurrency = currencies.map((currency) => {
            const scoped = rows.filter((r) => r.currency === currency);

            // Income minus expenses. Income is credit-normal, so `net` above is
            // already signed as profit.
            const earnings = dec(
                earningsRows.find((e) => e.currency === currency)?.net ?? 0,
            );

            const assets = scoped
                .filter((r) => r.class === 'ASSET')
                .map((r) => this.line(r, dec(r.net_debit)));
            // Liabilities and equity are credit-normal: flip the sign so a
            // balance owed presents as a positive number.
            const liabilities = scoped
                .filter((r) => r.class === 'LIABILITY')
                .map((r) => this.line(r, dec(r.net_debit).negated()));
            const equity = scoped
                .filter((r) => r.class === 'EQUITY')
                .map((r) => this.line(r, dec(r.net_debit).negated()));

            const totalAssets = this.sum(assets);
            const totalLiabilities = this.sum(liabilities);
            const totalEquity = this.sum(equity).add(earnings);

            return {
                currency,
                sections: {
                    asOf: asOf.toISOString().slice(0, 10),
                    assets: this.dropZeroes(assets),
                    liabilities: this.dropZeroes(liabilities),
                    equity: this.dropZeroes(equity),
                    currentPeriodEarnings: earnings.toFixed(4),
                    totals: {
                        assets: totalAssets.toFixed(4),
                        liabilities: totalLiabilities.toFixed(4),
                        equity: totalEquity.toFixed(4),
                    },
                },
                outOfBalance: totalAssets.sub(totalLiabilities.add(totalEquity)).toFixed(4),
            };
        });

        return this.envelope(byCurrency);
    }

    // ─── Income Statement ─────────────────────────────────

    /**
     * Per-book and consolidated P&L in one round trip via GROUPING SETS.
     *
     * Journals with a null cashbookId (direct wallet activity, transfers) appear
     * only in the consolidated roll-up, surfaced as "Unassigned to a book".
     */
    async incomeStatement(
        workspaceId: string,
        period: ReportPeriod,
        cashbookId?: string | null,
    ): Promise<ReportEnvelope<IncomeStatementSections>> {
        const rows = await this.prisma.$queryRaw<
            Array<{
                cashbook_id: string | null; id: string; code: string; name: string;
                class: string; currency: string; amount: Decimal; is_rollup: boolean;
            }>
        >`
            SELECT jl.cashbook_id,
                   la.id, la.code, la.name, la.class, la.currency,
                   SUM(CASE WHEN la.class = 'INCOME' THEN jl.credit - jl.debit
                            ELSE jl.debit - jl.credit END) AS amount,
                   GROUPING(jl.cashbook_id) = 1 AS is_rollup
            FROM journal_lines jl
            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
            WHERE jl.workspace_id = ${workspaceId}::uuid
              AND la.class IN ('INCOME', 'EXPENSE')
              AND jl.entry_date >= ${period.from}
              AND jl.entry_date <= ${period.to}
              AND (${cashbookId ?? null}::uuid IS NULL OR jl.cashbook_id = ${cashbookId ?? null}::uuid)
            GROUP BY GROUPING SETS ((jl.cashbook_id, la.id, la.code, la.name, la.class, la.currency),
                                    (la.id, la.code, la.name, la.class, la.currency))
            ORDER BY la.code
        `;

        const cashbookIds = [
            ...new Set(rows.filter((r) => !r.is_rollup && r.cashbook_id).map((r) => r.cashbook_id!)),
        ];
        const cashbooks = await this.prisma.cashbook.findMany({
            where: { id: { in: cashbookIds } },
            select: { id: true, name: true },
        });
        const nameOf = new Map(cashbooks.map((c) => [c.id, c.name]));

        const currencies = this.currencySet(rows);
        const byCurrency = currencies.map((currency) => {
            const scoped = rows.filter((r) => r.currency === currency);

            const perBook = [...new Set(scoped.filter((r) => !r.is_rollup).map((r) => r.cashbook_id))]
                .map((id) => {
                    const bookRows = scoped.filter((r) => !r.is_rollup && r.cashbook_id === id);
                    return {
                        cashbookId: id,
                        cashbookName: id ? nameOf.get(id) ?? 'Unknown book' : 'Unassigned to a book',
                        ...this.splitIncomeExpense(bookRows),
                    };
                });

            const rollupRows = scoped.filter((r) => r.is_rollup);

            return {
                currency,
                sections: {
                    period: {
                        from: period.from.toISOString().slice(0, 10),
                        to: period.to.toISOString().slice(0, 10),
                    },
                    books: perBook,
                    consolidated: this.splitIncomeExpense(rollupRows),
                },
                outOfBalance: '0.0000',
            };
        });

        return this.envelope(byCurrency);
    }

    // ─── Trial Balance ────────────────────────────────────

    /** Every account's debit/credit balance. The sum of each column must match. */
    async trialBalance(workspaceId: string, asOf: Date, includeZeroBalances = false) {
        const rows = await this.prisma.$queryRaw<
            Array<{
                id: string; code: string; name: string; class: string;
                currency: string; net_debit: Decimal;
            }>
        >`
            SELECT la.id, la.code, la.name, la.class, la.currency,
                   COALESCE(SUM(jl.debit - jl.credit), 0) AS net_debit
            FROM ledger_accounts la
            LEFT JOIN journal_lines jl
                   ON jl.ledger_account_id = la.id
                  AND jl.entry_date <= ${asOf}
            WHERE la.workspace_id = ${workspaceId}::uuid
              AND la.is_postable
            GROUP BY la.id, la.code, la.name, la.class, la.currency
            ORDER BY la.code
        `;

        const currencies = this.currencySet(rows);
        const byCurrency = currencies.map((currency) => {
            const scoped = rows
                .filter((r) => r.currency === currency)
                .filter((r) => includeZeroBalances || !dec(r.net_debit).isZero());

            const accounts = scoped.map((r) => {
                const net = dec(r.net_debit);
                return {
                    ledgerAccountId: r.id,
                    code: r.code,
                    name: r.name,
                    class: r.class,
                    debit: (net.isPositive() ? net : ZERO).toFixed(4),
                    credit: (net.isNegative() ? net.negated() : ZERO).toFixed(4),
                };
            });

            const totalDebit = accounts.reduce((s, a) => s.add(a.debit), ZERO);
            const totalCredit = accounts.reduce((s, a) => s.add(a.credit), ZERO);

            return {
                currency,
                sections: {
                    asOf: asOf.toISOString().slice(0, 10),
                    accounts,
                    totals: { debit: totalDebit.toFixed(4), credit: totalCredit.toFixed(4) },
                },
                outOfBalance: totalDebit.sub(totalCredit).toFixed(4),
            };
        });

        return this.envelope(byCurrency);
    }

    // ─── General Ledger ───────────────────────────────────

    /**
     * Every movement on one account, with a running balance.
     *
     * Ordering by (entry_date, seq, line_number) is what makes the running
     * balance deterministic — `seq` is the global autoincrement that breaks ties
     * between journals sharing a business date.
     */
    async generalLedger(
        workspaceId: string,
        ledgerAccountId: string,
        period: ReportPeriod,
    ) {
        const account = await this.prisma.ledgerAccount.findFirstOrThrow({
            where: { id: ledgerAccountId, workspaceId },
            select: { id: true, code: true, name: true, class: true, currency: true, normalBalance: true },
        });

        const [openingRow] = await this.prisma.$queryRaw<Array<{ net: Decimal }>>`
            SELECT COALESCE(SUM(debit - credit), 0) AS net
            FROM journal_lines
            WHERE ledger_account_id = ${ledgerAccountId}::uuid
              AND entry_date < ${period.from}
        `;
        const opening = dec(openingRow?.net);

        const lines = await this.prisma.$queryRaw<
            Array<{
                journal_id: string; seq: bigint; entry_date: Date; description: string;
                source_type: string; source_id: string | null; status: string;
                line_number: number; debit: Decimal; credit: Decimal; memo: string | null;
                running_balance: Decimal;
            }>
        >`
            SELECT je.id AS journal_id, je.seq, je.entry_date, je.description,
                   je.source_type, je.source_id, je.status,
                   jl.line_number, jl.debit, jl.credit, jl.memo,
                   ${opening}::numeric + SUM(jl.debit - jl.credit)
                     OVER (ORDER BY je.entry_date, je.seq, jl.line_number
                           ROWS UNBOUNDED PRECEDING) AS running_balance
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.journal_entry_id
            WHERE jl.ledger_account_id = ${ledgerAccountId}::uuid
              AND jl.entry_date >= ${period.from}
              AND jl.entry_date <= ${period.to}
            ORDER BY je.entry_date, je.seq, jl.line_number
        `;

        const closing = lines.length > 0 ? dec(lines[lines.length - 1].running_balance) : opening;

        return {
            account,
            period: {
                from: period.from.toISOString().slice(0, 10),
                to: period.to.toISOString().slice(0, 10),
            },
            openingBalance: opening.toFixed(4),
            closingBalance: closing.toFixed(4),
            lines: lines.map((l) => ({
                journalEntryId: l.journal_id,
                seq: Number(l.seq),
                entryDate: l.entry_date,
                description: l.description,
                sourceType: l.source_type,
                sourceId: l.source_id,
                status: l.status,
                lineNumber: l.line_number,
                debit: dec(l.debit).toFixed(4),
                credit: dec(l.credit).toFixed(4),
                memo: l.memo,
                runningBalance: dec(l.running_balance).toFixed(4),
            })),
        };
    }

    // ─── Cash Flow (direct method) ────────────────────────

    /**
     * Decompose every journal that touched cash into its non-cash counter-legs.
     * The credit-minus-debit of a counter-leg IS the cash that leg generated.
     *
     * Wallet transfers cancel out for free: both their legs are cash-equivalent,
     * so the outer select (which excludes cash accounts) sees nothing.
     */
    async cashFlow(workspaceId: string, period: ReportPeriod) {
        const rows = await this.prisma.$queryRaw<
            Array<{ class: string; code: string; name: string; currency: string; cash_effect: Decimal }>
        >`
            WITH cash_journals AS (
                SELECT DISTINCT jl.journal_entry_id
                FROM journal_lines jl
                JOIN ledger_accounts la ON la.id = jl.ledger_account_id
                WHERE la.workspace_id = ${workspaceId}::uuid
                  AND la.is_cash_equivalent
                  AND jl.entry_date >= ${period.from}
                  AND jl.entry_date <= ${period.to}
            )
            SELECT la.class, la.code, la.name, la.currency,
                   SUM(jl.credit - jl.debit) AS cash_effect
            FROM cash_journals cj
            JOIN journal_lines   jl ON jl.journal_entry_id = cj.journal_entry_id
            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
            WHERE NOT la.is_cash_equivalent
            GROUP BY la.class, la.code, la.name, la.currency
            ORDER BY la.code
        `;

        const netMovement = await this.prisma.$queryRaw<
            Array<{ currency: string; net: Decimal }>
        >`
            SELECT la.currency, COALESCE(SUM(jl.debit - jl.credit), 0) AS net
            FROM journal_lines jl
            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
            WHERE la.workspace_id = ${workspaceId}::uuid
              AND la.is_cash_equivalent
              AND jl.entry_date >= ${period.from}
              AND jl.entry_date <= ${period.to}
            GROUP BY la.currency
        `;

        const currencies = this.currencySet(rows, netMovement);
        const byCurrency = currencies.map((currency) => {
            const scoped = rows.filter((r) => r.currency === currency);
            const bucket = (klass: string) =>
                scoped
                    .filter((r) => this.cashFlowBucket(r.class) === klass)
                    .map((r) => ({
                        code: r.code,
                        name: r.name,
                        class: r.class,
                        amount: dec(r.cash_effect).toFixed(4),
                    }));

            const operating = bucket('OPERATING');
            const investing = bucket('INVESTING');
            const financing = bucket('FINANCING');

            const total = [...operating, ...investing, ...financing].reduce(
                (s, r) => s.add(r.amount),
                ZERO,
            );
            const actual = dec(netMovement.find((n) => n.currency === currency)?.net ?? 0);

            return {
                currency,
                sections: {
                    period: {
                        from: period.from.toISOString().slice(0, 10),
                        to: period.to.toISOString().slice(0, 10),
                    },
                    operating,
                    investing,
                    financing,
                    netCashMovement: total.toFixed(4),
                },
                // Must reconcile against the actual movement on cash accounts.
                outOfBalance: total.sub(actual).toFixed(4),
            };
        });

        return this.envelope(byCurrency);
    }

    // ─── AR / AP aging ────────────────────────────────────

    /**
     * Balances come from the ledger (grouped by the obligation dimension on the
     * AR/AP control account); due dates and counterparties come from the
     * obligation table.
     *
     * The `controlVariance` it returns is the single most valuable drift signal
     * in the system: if open obligations do not equal the control account, some
     * settlement path skipped a posting.
     */
    async aging(workspaceId: string, type: 'RECEIVABLE' | 'PAYABLE', asOf: Date) {
        const systemKey = type === 'RECEIVABLE' ? 'AR' : 'AP';
        const controls = await this.prisma.ledgerAccount.findMany({
            where: { workspaceId, systemKey },
            select: { id: true, currency: true },
        });
        const control = controls[0];

        if (!control) {
            return {
                type,
                asOf: asOf.toISOString().slice(0, 10),
                currency: null as string | null,
                buckets: [] as string[],
                items: [] as AgingItem[],
                totals: { total: '0.0000' } as Record<string, string>,
                controlVariance: '0.0000',
            };
        }

        const sign = type === 'RECEIVABLE' ? 1 : -1;
        const balances = await this.prisma.$queryRaw<
            Array<{ obligation_id: string | null; open_balance: Decimal }>
        >`
            SELECT jl.obligation_id, SUM(jl.debit - jl.credit) AS open_balance
            FROM journal_lines jl
            WHERE jl.ledger_account_id = ANY(${controls.map((c) => c.id)}::uuid[])
              AND jl.entry_date <= ${asOf}
            GROUP BY jl.obligation_id
            HAVING SUM(jl.debit - jl.credit) <> 0
        `;

        const obligationIds = balances.map((b) => b.obligation_id).filter(Boolean) as string[];
        const obligations = await this.prisma.cashbookObligation.findMany({
            where: { id: { in: obligationIds } },
            select: {
                id: true, title: true, dueDate: true, totalAmount: true,
                contact: { select: { id: true, name: true } },
                cashbook: { select: { id: true, name: true } },
            },
        });
        const metaOf = new Map(obligations.map((o) => [o.id, o]));

        const BUCKETS = [
            { label: 'Current', min: -Infinity, max: 0 },
            { label: '1-30 days', min: 1, max: 30 },
            { label: '31-60 days', min: 31, max: 60 },
            { label: '61-90 days', min: 61, max: 90 },
            { label: '90+ days', min: 91, max: Infinity },
        ];

        const items = balances.map((b) => {
            const meta = b.obligation_id ? metaOf.get(b.obligation_id) : undefined;
            const balance = dec(b.open_balance).mul(sign);
            const daysOverdue = meta?.dueDate
                ? Math.floor((asOf.getTime() - meta.dueDate.getTime()) / 86_400_000)
                : 0;
            const bucket =
                BUCKETS.find((x) => daysOverdue >= x.min && daysOverdue <= x.max)?.label ?? 'Current';

            return {
                obligationId: b.obligation_id,
                title: meta?.title ?? 'Unlinked',
                contact: meta?.contact ?? null,
                cashbook: meta?.cashbook ?? null,
                dueDate: meta?.dueDate ?? null,
                daysOverdue: Math.max(daysOverdue, 0),
                bucket,
                openBalance: balance.toFixed(4),
            };
        });

        const totals: Record<string, string> = {};
        for (const b of BUCKETS) {
            totals[b.label] = items
                .filter((i) => i.bucket === b.label)
                .reduce((s, i) => s.add(i.openBalance), ZERO)
                .toFixed(4);
        }
        const grandTotal = items.reduce((s, i) => s.add(i.openBalance), ZERO);

        const outstanding = await this.prisma.cashbookObligation.aggregate({
            where: { workspaceId, type, status: { in: ['OPEN', 'PARTIAL'] }, archivedAt: null },
            _sum: { outstandingAmount: true },
        });

        return {
            type,
            asOf: asOf.toISOString().slice(0, 10),
            currency: control.currency as string | null,
            buckets: BUCKETS.map((b) => b.label),
            items: items.sort((a, b) => b.daysOverdue - a.daysOverdue) as AgingItem[],
            totals: { ...totals, total: grandTotal.toFixed(4) } as Record<string, string>,
            /** Zero unless a settlement path skipped a posting. */
            controlVariance: grandTotal.sub(dec(outstanding._sum.outstandingAmount)).toFixed(4),
        };
    }

    // ─── helpers ──────────────────────────────────────────

    private line(
        row: { id: string; code: string; name: string; class: string },
        amount: Decimal,
    ): AccountLine {
        return {
            ledgerAccountId: row.id,
            code: row.code,
            name: row.name,
            class: row.class,
            amount: amount.toFixed(4),
        };
    }

    private sum(lines: AccountLine[]): Decimal {
        return lines.reduce((s, l) => s.add(l.amount), ZERO);
    }

    /** Accounts that never moved add noise; a zero balance is not information. */
    private dropZeroes(lines: AccountLine[]): AccountLine[] {
        return lines.filter((l) => !new Decimal(l.amount).isZero());
    }

    private splitIncomeExpense(
        rows: Array<{ id: string; code: string; name: string; class: string; amount: Decimal }>,
    ) {
        const income = rows.filter((r) => r.class === 'INCOME').map((r) => this.line(r, dec(r.amount)));
        const expenses = rows.filter((r) => r.class === 'EXPENSE').map((r) => this.line(r, dec(r.amount)));
        const totalIncome = this.sum(income);
        const totalExpenses = this.sum(expenses);

        return {
            income: this.dropZeroes(income),
            expenses: this.dropZeroes(expenses),
            totals: {
                income: totalIncome.toFixed(4),
                expenses: totalExpenses.toFixed(4),
                net: totalIncome.sub(totalExpenses).toFixed(4),
            },
        };
    }

    /**
     * No fixed assets or loans are modelled yet, so everything except equity is
     * operating. Split out properly once those exist.
     */
    private cashFlowBucket(klass: string): 'OPERATING' | 'INVESTING' | 'FINANCING' {
        return klass === 'EQUITY' ? 'FINANCING' : 'OPERATING';
    }

    private currencySet(...rowSets: Array<Array<{ currency: string }>>): string[] {
        const set = new Set<string>();
        for (const rows of rowSets) for (const r of rows) set.add(r.currency);
        return [...set].sort();
    }

    private envelope<T>(byCurrency: Array<CurrencyScoped<T>>): ReportEnvelope<T> {
        return {
            mixedCurrency: byCurrency.length > 1,
            byCurrency,
            generatedAt: new Date(),
        };
    }
}
