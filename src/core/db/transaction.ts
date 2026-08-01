/**
 * Transaction wrapper for financial writes.
 *
 * Isolation: READ COMMITTED (the Postgres default) plus explicit `FOR UPDATE`.
 * Every invariant in this codebase is per-row (cashbook balance, wallet balance,
 * obligation outstanding, entry version) and is protected by an explicit lock
 * taken through `acquireLocks`. SERIALIZABLE would produce 40001 retries on
 * essentially every write because reports scan wide ranges; REPEATABLE READ is
 * worse still, since it converts today's silent lost updates into serialization
 * errors that callers do not currently retry.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger';

export const FINANCIAL_TX_OPTS = {
    maxWait: 5_000,
    // 20s rather than Prisma's 5s default: an entry carrying many inventory
    // lines plus obligation settlement plus invoice resync genuinely exceeds 5s
    // under load, and a timeout mid-write leaves the caller unable to tell
    // whether the work committed.
    timeout: 20_000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
} as const;

/** Postgres error codes worth retrying. */
const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
const LOCK_NOT_AVAILABLE = '55P03';

const RETRYABLE = new Set([DEADLOCK_DETECTED, SERIALIZATION_FAILURE, LOCK_NOT_AVAILABLE]);

function retryableCode(error: unknown): string | null {
    // Prisma surfaces the Postgres SQLSTATE under meta.code for P2010 (raw query
    // failures) and for some known-request errors.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        const code = (error.meta as { code?: string } | undefined)?.code;
        if (code && RETRYABLE.has(code)) return code;
    }
    const message = error instanceof Error ? error.message : '';
    for (const code of RETRYABLE) {
        if (message.includes(code)) return code;
    }
    return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface FinancialTransactionOptions {
    /** Attempts after the first. Default 3. */
    retries?: number;
    /** Label used in retry logs so a hot path is identifiable. */
    label?: string;
}

/**
 * Run `fn` inside a financial transaction, retrying deadlocks and serialization
 * failures with exponential jitter.
 *
 * `fn` MUST be idempotent with respect to retries — it is re-executed from the
 * start on each attempt, against a fresh transaction. That is safe here because
 * a retry only happens when the previous attempt was rolled back in full.
 */
export async function withFinancialTransaction<T>(
    prisma: PrismaClient,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: FinancialTransactionOptions = {},
): Promise<T> {
    const { retries = 3, label = 'financial-transaction' } = options;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await prisma.$transaction(fn, FINANCIAL_TX_OPTS);
        } catch (error) {
            const code = retryableCode(error);
            if (!code || attempt === retries) {
                throw error;
            }
            lastError = error;
            // Exponential backoff with full jitter, so two contending writers
            // do not retry in lockstep and deadlock again.
            const backoff = Math.random() * 50 * 2 ** attempt;
            logger.warn('Retrying financial transaction', {
                label,
                attempt: attempt + 1,
                retries,
                code,
                backoffMs: Math.round(backoff),
            });
            await sleep(backoff);
        }
    }

    throw lastError;
}
