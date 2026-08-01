/**
 * Read-only check before baselining a `db push`-managed database.
 *
 * A database built with `prisma db push` has no `_prisma_migrations` table, so
 * `migrate deploy` refuses it with P3005. The fix is to baseline: record the
 * migrations whose schema is already present as applied, then let deploy run
 * only the new ones.
 *
 * That is safe only if two things hold, and this script checks both:
 *
 *  1. The live schema really does match the migrations being marked applied.
 *     If it does not, deploy will fail later on a statement whose precondition
 *     is missing — halfway through, in production.
 *
 *  2. The existing DATA satisfies the constraints those migrations would have
 *     imposed. A pushed database never got the ledger triggers or CHECKs (they
 *     are not expressible in schema.prisma), so it may hold rows that could
 *     not have been written had they been present.
 *
 * Writes nothing. Run it, read it, then decide.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

let problems = 0;
let warnings = 0;

const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg: string) => { problems++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); };
const warn = (msg: string) => { warnings++; console.log(`  \x1b[33m!\x1b[0m ${msg}`); };

async function scalar<T = bigint>(sql: string): Promise<T> {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, T>>>(sql);
    return Object.values(rows[0] ?? {})[0] as T;
}

async function exists(sql: string): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<Array<unknown>>(sql);
    return rows.length > 0;
}

async function main() {
    console.log('\nPreflight for baselining a pushed database\n');

    // ─── 1. Is it actually unmanaged? ────────────────────────────────
    console.log('Migration history');
    const hasHistory = await exists(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = '_prisma_migrations'`,
    );
    if (hasHistory) {
        const applied = await scalar<bigint>(
            `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
        );
        const failed = await scalar<bigint>(
            `SELECT count(*) FROM "_prisma_migrations"
              WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
        );
        ok(`already migrate-managed: ${applied} applied`);
        if (Number(failed) > 0) {
            bad(`${failed} migration(s) started and never finished — resolve those first`);
        }
        warn('this database does not need baselining; go straight to migrate deploy');
    } else {
        ok('no _prisma_migrations table — this is the P3005 case, baselining applies');
    }

    // ─── 2. Does the schema match what we would mark applied? ────────
    console.log('\nSchema as of migration 0007');
    const expectTables = [
        'workspaces', 'cashbooks', 'entries', 'accounts', 'contacts', 'categories',
        'ledger_accounts', 'journal_entries', 'journal_lines', 'fiscal_periods',
        'idempotency_records', 'work_sessions', 'time_entries',
    ];
    for (const table of expectTables) {
        const present = await exists(
            `SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = '${table}'`,
        );
        present ? ok(`${table}`) : bad(`${table} is MISSING — do not baseline at 0007`);
    }

    // Columns 0008 will add. If they already exist, the push partly succeeded
    // and the baseline point is wrong.
    console.log('\nColumns migration 0008 will add (these should NOT exist yet)');
    for (const [table, column] of [
        ['work_sessions', 'business_date'],
        ['time_entries', 'business_date'],
        ['time_entries', 'created_by_id'],
        ['workspaces', 'timezone'],
    ] as const) {
        const present = await exists(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = '${table}'
                AND column_name = '${column}'`,
        );
        present
            ? bad(`${table}.${column} already exists — a partial push happened; stop and investigate`)
            : ok(`${table}.${column} absent, as expected`);
    }

    // ─── 3. The integrity objects a push never creates ───────────────
    console.log('\nLedger integrity objects (0015 installs any that are missing)');
    for (const trigger of [
        'journal_lines_balanced',
        'journal_lines_append_only',
        'journal_lines_currency_matches',
        'journal_lines_account_postable',
    ]) {
        const present = await exists(
            `SELECT 1 FROM pg_trigger WHERE tgname = '${trigger}' AND NOT tgisinternal`,
        );
        present ? ok(`${trigger} present`) : warn(`${trigger} MISSING — 0015 will add it`);
    }
    for (const constraint of [
        'jl_nonneg', 'jl_one_side', 'jl_nonzero', 'je_balanced', 'je_reversal_consistent',
    ]) {
        const present = await exists(
            `SELECT 1 FROM pg_constraint WHERE conname = '${constraint}'`,
        );
        present ? ok(`${constraint} present`) : warn(`${constraint} MISSING — 0015 will add it`);
    }

    // ─── 4. Would the data survive those constraints? ────────────────
    // This is the part that decides whether the deploy succeeds. Adding a CHECK
    // validates every existing row.
    console.log('\nDoes existing data satisfy them?');
    const violations: Array<[string, string]> = [
        ['jl_nonneg', `SELECT count(*) FROM journal_lines WHERE debit < 0 OR credit < 0`],
        ['jl_one_side', `SELECT count(*) FROM journal_lines WHERE debit > 0 AND credit > 0`],
        ['jl_nonzero', `SELECT count(*) FROM journal_lines WHERE debit + credit <= 0`],
        ['je_balanced', `SELECT count(*) FROM journal_entries WHERE total_debit <> total_credit`],
        ['je_reversal_consistent',
         `SELECT count(*) FROM journal_entries
           WHERE (status = 'REVERSING') <> (reverses_journal_entry_id IS NOT NULL)`],
        ['journal_lines_balanced (per journal)',
         `SELECT count(*) FROM (
            SELECT je.id FROM journal_entries je
              JOIN journal_lines jl ON jl.journal_entry_id = je.id
             GROUP BY je.id, je.total_debit, je.total_credit
            HAVING COALESCE(SUM(jl.debit),0) <> COALESCE(SUM(jl.credit),0)
                OR COALESCE(SUM(jl.debit),0) <> je.total_debit
          ) x`],
        ['currency matches account',
         `SELECT count(*) FROM journal_lines jl
            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
           WHERE jl.currency IS DISTINCT FROM la.currency`],
        ['posted only to postable accounts',
         `SELECT count(*) FROM journal_lines jl
            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
           WHERE la.is_postable = false`],
    ];
    for (const [label, sql] of violations) {
        try {
            const n = Number(await scalar<bigint>(sql));
            n === 0
                ? ok(`${label}: no violations`)
                : bad(`${label}: ${n} row(s) violate this — 0015 WILL FAIL until fixed`);
        } catch (error) {
            warn(`${label}: could not check (${(error as Error).message.split('\n')[0]})`);
        }
    }

    // ─── 5. Data 0008's new unique indexes would reject ──────────────
    // 0008 dedupes these itself before creating the indexes, so this is
    // informational: it tells you how many rows the migration will rewrite.
    console.log('\nRows migration 0008 will rewrite');
    const dupSessions = Number(await scalar<bigint>(
        `SELECT COALESCE(SUM(n - 1), 0) FROM (
           SELECT count(*) AS n FROM work_sessions WHERE clock_out IS NULL
            GROUP BY user_id HAVING count(*) > 1) x`,
    ));
    dupSessions === 0
        ? ok('no duplicate open sessions')
        : warn(`${dupSessions} duplicate open session(s) will be closed as MIGRATION_DUPLICATE_OPEN`);

    const stale = Number(await scalar<bigint>(
        `SELECT count(*) FROM work_sessions
          WHERE clock_out IS NULL AND clock_in < NOW() - INTERVAL '36 hours'`,
    ));
    stale === 0
        ? ok('no stale open sessions')
        : warn(`${stale} session(s) open >36h will be closed at +8h as MIGRATION_STALE_OPEN`);

    const noTz = Number(await scalar<bigint>(`SELECT count(*) FROM workspaces`));
    ok(`${noTz} workspace(s) will get timezone = 'Africa/Kampala' (change later in settings)`);

    // ─── Verdict ─────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    if (problems > 0) {
        console.log(`\x1b[31m${problems} problem(s)\x1b[0m, ${warnings} warning(s).`);
        console.log('Do NOT baseline yet. Each ✗ above will fail the deploy.\n');
        process.exit(1);
    }
    console.log(`\x1b[32mReady to baseline.\x1b[0m ${warnings} warning(s) — expected, see above.\n`);
}

main()
    .catch((error) => { console.error('\nPreflight failed:', error); process.exit(2); })
    .finally(() => prisma.$disconnect());
