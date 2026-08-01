/**
 * Vitest global setup.
 *
 * Integration tests run against a REAL Postgres database, because the things
 * most likely to break in this codebase — $transaction boundaries, FOR UPDATE
 * lock ordering, deferred constraint triggers, concurrent writes — cannot be
 * observed against a mock.
 *
 * Required env: DATABASE_URL_TEST (see .env.test.example).
 * The database is migrated once per run and truncated between tests.
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { afterAll, beforeAll } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

// .env.test wins over .env so a stray DATABASE_URL can never point tests at dev data.
for (const file of ['.env.test', '.env']) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) loadEnv({ path: full, override: file === '.env.test' });
}

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST;

if (!TEST_DATABASE_URL) {
    throw new Error(
        'DATABASE_URL_TEST is not set. Copy .env.test.example to .env.test and point it at a ' +
            'throwaway Postgres database. Tests refuse to run against DATABASE_URL to avoid ' +
            'truncating development data.',
    );
}

// setupFiles runs once per test FILE, and the redirect below mutates
// process.env for the whole worker. The sentinel keeps the safety check
// meaningful on the first file without false-positiving on later ones.
if (!process.env.__CASHBOOK_TEST_DB_REDIRECTED) {
    if (TEST_DATABASE_URL === process.env.DATABASE_URL) {
        throw new Error(
            'DATABASE_URL_TEST must differ from DATABASE_URL. The test harness truncates every ' +
                'table between tests.',
        );
    }
    process.env.__CASHBOOK_TEST_DB_REDIRECTED = '1';
}

// Everything downstream (config/index.ts, PrismaClient, services) reads DATABASE_URL.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';

// Imported only AFTER DATABASE_URL is redirected above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');

export const testPrisma = new PrismaClient({
    datasources: { db: { url: TEST_DATABASE_URL } },
    log: ['warn', 'error'],
});

/** Tables never cleared between tests (none yet — kept for future reference data). */
const PRESERVED_TABLES = new Set<string>([]);

let cachedTables: string[] | null = null;

async function tableNames(): Promise<string[]> {
    if (cachedTables) return cachedTables;
    const rows = await testPrisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
    `;
    const names = rows
        .map((r: { tablename: string }) => r.tablename)
        .filter((t: string) => !PRESERVED_TABLES.has(t));
    cachedTables = names;
    return names;
}

/**
 * Wipe all data. Runs inside `app.allow_ledger_maintenance` so the append-only
 * ledger trigger (added in the ledger migration) permits the truncate.
 */
export async function resetDatabase(): Promise<void> {
    const tables = await tableNames();
    if (tables.length === 0) return;
    const list = tables.map((t) => `"public"."${t}"`).join(', ');
    await testPrisma.$executeRawUnsafe(`SET LOCAL app.allow_ledger_maintenance = 'on'`);
    await testPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: ROOT,
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    });
    await resetDatabase();
});

afterAll(async () => {
    await testPrisma.$disconnect();
});
