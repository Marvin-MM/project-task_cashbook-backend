/**
 * Tests for the database-level ledger invariants.
 *
 * These bypass the application entirely and write raw SQL, because the whole
 * point of the triggers and CHECK constraints is that they hold even when the
 * application is wrong, bypassed, or replaced by a psql session.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { resetDatabase, testPrisma } from '../../test/setup';
import { createUser, createWorkspace } from '../../test/factories';

interface Ctx {
    workspaceId: string;
    userId: string;
    cashAccountId: string;
    revenueAccountId: string;
    parentAccountId: string;
}

async function makeContext(): Promise<Ctx> {
    const user = await createUser();
    const workspace = await createWorkspace(user.id);

    const mk = async (
        code: string,
        name: string,
        klass: string,
        normal: string,
        opts: { postable?: boolean; currency?: string } = {},
    ) => {
        const row = await testPrisma.ledgerAccount.create({
            data: {
                workspaceId: workspace.id,
                code,
                name,
                class: klass as never,
                normalBalance: normal as never,
                currency: opts.currency ?? 'UGX',
                isPostable: opts.postable ?? true,
            },
        });
        return row.id;
    };

    return {
        workspaceId: workspace.id,
        userId: user.id,
        cashAccountId: await mk('1010', 'Book Cash', 'ASSET', 'DEBIT'),
        revenueAccountId: await mk('4100', 'Sales Revenue', 'INCOME', 'CREDIT'),
        parentAccountId: await mk('1000', 'Assets', 'ASSET', 'DEBIT', { postable: false }),
    };
}

/** Insert a journal header + lines in one transaction, as PostingService will. */
async function postRaw(
    ctx: Ctx,
    lines: Array<{ accountId: string; debit: string; credit: string; currency?: string }>,
    headerTotals?: { debit: string; credit: string },
) {
    const journalId = randomUUID();
    const totalDebit =
        headerTotals?.debit ?? lines.reduce((s, l) => s + Number(l.debit), 0).toFixed(4);
    const totalCredit =
        headerTotals?.credit ?? lines.reduce((s, l) => s + Number(l.credit), 0).toFixed(4);

    await testPrisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe(
            `INSERT INTO journal_entries
               (id, workspace_id, entry_date, currency, description, source_type,
                posting_key, total_debit, total_credit, created_by_id, status)
             VALUES ($1::uuid, $2::uuid, CURRENT_DATE, 'UGX', 'test', 'MANUAL',
                     $3, $4::numeric, $5::numeric, $6::uuid, 'POSTED')`,
            journalId,
            ctx.workspaceId,
            `test:${journalId}`,
            totalDebit,
            totalCredit,
            ctx.userId,
        );

        let n = 1;
        for (const line of lines) {
            await tx.$executeRawUnsafe(
                `INSERT INTO journal_lines
                   (id, journal_entry_id, line_number, workspace_id, entry_date, currency,
                    ledger_account_id, debit, credit)
                 VALUES ($1::uuid, $2::uuid, $3, $4::uuid, CURRENT_DATE, $5,
                         $6::uuid, $7::numeric, $8::numeric)`,
                randomUUID(),
                journalId,
                n++,
                ctx.workspaceId,
                line.currency ?? 'UGX',
                line.accountId,
                line.debit,
                line.credit,
            );
        }
    });

    return journalId;
}

describe('ledger database invariants', () => {
    let ctx: Ctx;

    beforeEach(async () => {
        await resetDatabase();
        ctx = await makeContext();
    });

    it('accepts a balanced journal', async () => {
        const id = await postRaw(ctx, [
            { accountId: ctx.cashAccountId, debit: '100.0000', credit: '0' },
            { accountId: ctx.revenueAccountId, debit: '0', credit: '100.0000' },
        ]);

        const lines = await testPrisma.journalLine.count({ where: { journalEntryId: id } });
        expect(lines).toBe(2);
    });

    it('rejects a journal whose debits do not equal its credits', async () => {
        await expect(
            postRaw(
                ctx,
                [
                    { accountId: ctx.cashAccountId, debit: '100.0000', credit: '0' },
                    { accountId: ctx.revenueAccountId, debit: '0', credit: '90.0000' },
                ],
                // Header lies to get past the row-level CHECK; the deferred
                // trigger must still catch the line mismatch at COMMIT.
                { debit: '100.0000', credit: '100.0000' },
            ),
        ).rejects.toThrow(/unbalanced/i);

        expect(await testPrisma.journalEntry.count()).toBe(0);
    });

    it('rejects a header whose totals disagree with its lines', async () => {
        await expect(
            postRaw(
                ctx,
                [
                    { accountId: ctx.cashAccountId, debit: '100.0000', credit: '0' },
                    { accountId: ctx.revenueAccountId, debit: '0', credit: '100.0000' },
                ],
                { debit: '500.0000', credit: '500.0000' },
            ),
        ).rejects.toThrow(/unbalanced/i);
    });

    it('rejects a line carrying both a debit and a credit', async () => {
        await expect(
            postRaw(ctx, [
                { accountId: ctx.cashAccountId, debit: '100.0000', credit: '100.0000' },
                { accountId: ctx.revenueAccountId, debit: '0', credit: '0' },
            ]),
        ).rejects.toThrow(/jl_one_side|jl_nonzero/i);
    });

    it('rejects a negative amount', async () => {
        await expect(
            postRaw(ctx, [
                { accountId: ctx.cashAccountId, debit: '-100.0000', credit: '0' },
                { accountId: ctx.revenueAccountId, debit: '0', credit: '-100.0000' },
            ]),
        ).rejects.toThrow(/jl_nonneg/i);
    });

    it('rejects posting to a roll-up parent account', async () => {
        await expect(
            postRaw(ctx, [
                { accountId: ctx.parentAccountId, debit: '100.0000', credit: '0' },
                { accountId: ctx.revenueAccountId, debit: '0', credit: '100.0000' },
            ]),
        ).rejects.toThrow(/roll-up parent/i);
    });

    it('rejects a line whose currency differs from its ledger account', async () => {
        await expect(
            postRaw(ctx, [
                { accountId: ctx.cashAccountId, debit: '100.0000', credit: '0', currency: 'KES' },
                { accountId: ctx.revenueAccountId, debit: '0', credit: '100.0000' },
            ]),
        ).rejects.toThrow(/currency/i);
    });

    it('forbids updating a posted line', async () => {
        const id = await postRaw(ctx, [
            { accountId: ctx.cashAccountId, debit: '100.0000', credit: '0' },
            { accountId: ctx.revenueAccountId, debit: '0', credit: '100.0000' },
        ]);

        await expect(
            testPrisma.$executeRawUnsafe(
                `UPDATE journal_lines SET debit = 1 WHERE journal_entry_id = $1::uuid`,
                id,
            ),
        ).rejects.toThrow(/append-only/i);
    });

    it('forbids deleting a posted line', async () => {
        const id = await postRaw(ctx, [
            { accountId: ctx.cashAccountId, debit: '100.0000', credit: '0' },
            { accountId: ctx.revenueAccountId, debit: '0', credit: '100.0000' },
        ]);

        await expect(
            testPrisma.$executeRawUnsafe(
                `DELETE FROM journal_lines WHERE journal_entry_id = $1::uuid`,
                id,
            ),
        ).rejects.toThrow(/append-only/i);
    });

    it('enforces posting-key uniqueness per workspace', async () => {
        const key = `dup:${randomUUID()}`;
        const insert = () =>
            testPrisma.$executeRawUnsafe(
                `INSERT INTO journal_entries
                   (id, workspace_id, entry_date, currency, description, source_type,
                    posting_key, total_debit, total_credit, created_by_id, status)
                 VALUES (gen_random_uuid(), $1::uuid, CURRENT_DATE, 'UGX', 'dup', 'MANUAL',
                         $2, 0, 0, $3::uuid, 'POSTED')`,
                ctx.workspaceId,
                key,
                ctx.userId,
            );

        await insert();
        await expect(insert()).rejects.toThrow();
    });

    it('requires REVERSING status to carry a reversal target', async () => {
        await expect(
            testPrisma.$executeRawUnsafe(
                `INSERT INTO journal_entries
                   (id, workspace_id, entry_date, currency, description, source_type,
                    posting_key, total_debit, total_credit, created_by_id, status)
                 VALUES (gen_random_uuid(), $1::uuid, CURRENT_DATE, 'UGX', 'bad', 'MANUAL',
                         $2, 0, 0, $3::uuid, 'REVERSING')`,
                ctx.workspaceId,
                `rev:${randomUUID()}`,
                ctx.userId,
            ),
        ).rejects.toThrow(/je_reversal_consistent/i);
    });
});
