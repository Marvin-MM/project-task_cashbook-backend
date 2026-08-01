/**
 * The only thing that writes to the ledger, and the only thing that writes the
 * cached balance columns on Cashbook and Account.
 *
 * Cache identities, which hold unconditionally under the cash-basis model:
 *
 *   Cashbook.balance      = Σ(debit − credit) on that book's BOOK_CASH account
 *   Cashbook.totalIncome  = Σ(credit − debit) on INCOME lines, CASHBOOK_ENTRY only
 *   Cashbook.totalExpense = Σ(debit − credit) on EXPENSE lines, CASHBOOK_ENTRY only
 *   Account.balance       = Σ(debit − credit) on that wallet's ledger account
 *
 * Because the deltas are derived from the resolved legs themselves, there is no
 * parallel arithmetic that can drift from the journal.
 */
import { injectable } from 'tsyringe';
import { JournalStatus, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { AppError, ConflictError } from '../errors/AppError';
import { LedgerAccountResolver } from './account-resolver';
import type { JournalDraft, LegDraft, PostedJournal, ResolvedLine } from './ledger.types';

interface ResolvedDraft {
    lines: ResolvedLine[];
    totalDebit: Decimal;
    totalCredit: Decimal;
    cashbookDeltas: Map<string, { balance: Decimal; totalIncome: Decimal; totalExpense: Decimal }>;
    walletDeltas: Map<string, Decimal>;
}

export interface PostOptions {
    /**
     * THROW           a duplicate posting key is a bug (default)
     * RETURN_EXISTING a duplicate is a safe retry; return the original
     */
    onDuplicate?: 'THROW' | 'RETURN_EXISTING';
    /**
     * Write the derived cache columns (default true).
     *
     * False during shadow mode, where the legacy arithmetic still owns those
     * columns and the ledger runs alongside purely so the integrity verifier can
     * prove the two agree before the legacy code is deleted. Writing from both
     * would double every balance.
     */
    applyCaches?: boolean;
}

const ZERO = new Decimal(0);

@injectable()
export class PostingService {
    /** Post a balanced journal and apply its cache deltas. */
    async post(
        tx: Prisma.TransactionClient,
        draft: JournalDraft,
        options: PostOptions = {},
    ): Promise<PostedJournal> {
        const { onDuplicate = 'THROW', applyCaches = true } = options;

        const existing = await tx.journalEntry.findUnique({
            where: {
                workspaceId_postingKey: {
                    workspaceId: draft.workspaceId,
                    postingKey: draft.postingKey,
                },
            },
            select: { id: true, postingKey: true, totalDebit: true, totalCredit: true, _count: { select: { lines: true } } },
        });

        if (existing) {
            if (onDuplicate === 'RETURN_EXISTING') {
                return {
                    id: existing.id,
                    postingKey: existing.postingKey,
                    totalDebit: existing.totalDebit,
                    totalCredit: existing.totalCredit,
                    lineCount: existing._count.lines,
                    replayed: true,
                };
            }
            throw new ConflictError(
                `A journal with posting key "${draft.postingKey}" already exists.`,
            );
        }

        const resolver = new LedgerAccountResolver(tx, draft.workspaceId, draft.currency);
        const resolved = await this.resolveDraft(resolver, draft);

        this.assertBalanced(draft, resolved);

        const journal = await tx.journalEntry.create({
            data: {
                workspaceId: draft.workspaceId,
                cashbookId: draft.cashbookId,
                entryDate: draft.entryDate,
                currency: draft.currency,
                description: draft.description,
                sourceType: draft.sourceType,
                sourceId: draft.sourceId,
                postingKey: draft.postingKey,
                totalDebit: resolved.totalDebit,
                totalCredit: resolved.totalCredit,
                createdById: draft.createdById,
                status: JournalStatus.POSTED,
            },
            select: { id: true },
        });

        await tx.journalLine.createMany({
            data: resolved.lines.map((line) => ({
                journalEntryId: journal.id,
                lineNumber: line.lineNumber,
                workspaceId: draft.workspaceId,
                cashbookId: draft.cashbookId,
                entryDate: draft.entryDate,
                currency: draft.currency,
                ledgerAccountId: line.ledgerAccountId,
                debit: line.debit,
                credit: line.credit,
                memo: line.memo,
                contactId: line.dims.contactId ?? null,
                categoryId: line.dims.categoryId ?? null,
                obligationId: line.dims.obligationId ?? null,
                inventoryItemId: line.dims.inventoryItemId ?? null,
                entryId: line.dims.entryId ?? null,
            })),
        });

        if (applyCaches) {
            await this.applyCacheDeltas(tx, resolved);
        }

        return {
            id: journal.id,
            postingKey: draft.postingKey,
            totalDebit: resolved.totalDebit,
            totalCredit: resolved.totalCredit,
            lineCount: resolved.lines.length,
            replayed: false,
        };
    }

    /**
     * Post the mirror image of an existing journal.
     *
     * The original is never edited — it is marked REVERSED and a REVERSING
     * journal with every debit and credit swapped is appended. Both continue to
     * appear in reports and net to zero, which is why report queries must never
     * filter on status.
     */
    async reverse(
        tx: Prisma.TransactionClient,
        args: {
            workspaceId: string;
            originalPostingKey: string;
            reason: string;
            createdById: string;
            /** Defaults to the original's date; a closed period forces today. */
            reversalDate?: Date;
            /** See PostOptions.applyCaches. */
            applyCaches?: boolean;
        },
    ): Promise<PostedJournal | null> {
        const original = await tx.journalEntry.findUnique({
            where: {
                workspaceId_postingKey: {
                    workspaceId: args.workspaceId,
                    postingKey: args.originalPostingKey,
                },
            },
            include: { lines: { orderBy: { lineNumber: 'asc' } } },
        });

        // Nothing to reverse: the event was never posted (e.g. shadow mode was
        // off when it was created). Not an error.
        if (!original) return null;

        if (original.status === JournalStatus.REVERSED) {
            const already = await tx.journalEntry.findUnique({
                where: { reversesJournalEntryId: original.id },
                select: { id: true, postingKey: true, totalDebit: true, totalCredit: true, _count: { select: { lines: true } } },
            });
            if (already) {
                return {
                    id: already.id,
                    postingKey: already.postingKey,
                    totalDebit: already.totalDebit,
                    totalCredit: already.totalCredit,
                    lineCount: already._count.lines,
                    replayed: true,
                };
            }
        }

        const reversalKey = `${args.originalPostingKey}:rev`;
        const entryDate = args.reversalDate ?? original.entryDate;

        const reversal = await tx.journalEntry.create({
            data: {
                workspaceId: original.workspaceId,
                cashbookId: original.cashbookId,
                entryDate,
                currency: original.currency,
                description: `Reversal: ${original.description} — ${args.reason}`,
                sourceType: original.sourceType,
                sourceId: original.sourceId,
                postingKey: reversalKey,
                totalDebit: original.totalCredit,
                totalCredit: original.totalDebit,
                createdById: args.createdById,
                status: JournalStatus.REVERSING,
                reversesJournalEntryId: original.id,
            },
            select: { id: true },
        });

        await tx.journalLine.createMany({
            data: original.lines.map((line) => ({
                journalEntryId: reversal.id,
                lineNumber: line.lineNumber,
                workspaceId: line.workspaceId,
                cashbookId: line.cashbookId,
                entryDate,
                currency: line.currency,
                ledgerAccountId: line.ledgerAccountId,
                // The swap.
                debit: line.credit,
                credit: line.debit,
                memo: line.memo,
                contactId: line.contactId,
                categoryId: line.categoryId,
                obligationId: line.obligationId,
                inventoryItemId: line.inventoryItemId,
                entryId: line.entryId,
            })),
        });

        await tx.journalEntry.update({
            where: { id: original.id },
            data: { status: JournalStatus.REVERSED },
        });

        // Cache deltas are the negation of the original's, derived the same way.
        const resolver = new LedgerAccountResolver(tx, original.workspaceId, original.currency);
        const negated = await this.deltasFromLines(
            resolver,
            original.lines.map((l) => ({
                lineNumber: l.lineNumber,
                ledgerAccountId: l.ledgerAccountId,
                debit: l.credit,
                credit: l.debit,
                memo: l.memo,
                dims: {},
            })),
            original.cashbookId,
            original.sourceType,
        );

        if (args.applyCaches !== false) {
            await this.applyCacheDeltas(tx, negated);
        }

        return {
            id: reversal.id,
            postingKey: reversalKey,
            totalDebit: original.totalCredit,
            totalCredit: original.totalDebit,
            lineCount: original.lines.length,
            replayed: false,
        };
    }

    /**
     * Atomically reverse the previous version of an event and post its new one.
     * Every edit path uses this rather than mutating a journal.
     */
    async repost(
        tx: Prisma.TransactionClient,
        args: {
            originalPostingKey: string;
            next: JournalDraft;
            reason: string;
            createdById: string;
            /** See PostOptions.applyCaches. */
            applyCaches?: boolean;
        },
    ): Promise<{ reversal: PostedJournal | null; replacement: PostedJournal }> {
        const reversal = await this.reverse(tx, {
            workspaceId: args.next.workspaceId,
            originalPostingKey: args.originalPostingKey,
            reason: args.reason,
            createdById: args.createdById,
            applyCaches: args.applyCaches,
        });

        const replacement = await this.post(tx, args.next, {
            onDuplicate: 'THROW',
            applyCaches: args.applyCaches,
        });

        return { reversal, replacement };
    }

    // ─── internals ────────────────────────────────────────────

    private async resolveDraft(
        resolver: LedgerAccountResolver,
        draft: JournalDraft,
    ): Promise<ResolvedDraft> {
        const lines: ResolvedLine[] = [];
        let lineNumber = 1;

        for (const leg of draft.legs) {
            const debit = leg.debit ?? ZERO;
            const credit = leg.credit ?? ZERO;

            // Zero-amount legs are dropped: rules emit them unconditionally
            // (e.g. the fee leg when chargeAmount is 0) and it keeps the rules
            // branch-free.
            if (debit.isZero() && credit.isZero()) continue;

            if (!debit.isZero() && !credit.isZero()) {
                throw new AppError(
                    `Journal leg ${lineNumber} of "${draft.postingKey}" has both a debit and a credit.`,
                    500,
                    'LEDGER_INVALID_LEG',
                );
            }
            if (debit.isNegative() || credit.isNegative()) {
                throw new AppError(
                    `Journal leg ${lineNumber} of "${draft.postingKey}" is negative. ` +
                    'Swap the debit and credit instead of negating.',
                    500,
                    'LEDGER_INVALID_LEG',
                );
            }

            lines.push({
                lineNumber: lineNumber++,
                ledgerAccountId: await resolver.resolve(leg.ref),
                debit,
                credit,
                memo: leg.memo ?? null,
                dims: leg.dims ?? {},
            });
        }

        const deltas = await this.deltasFromLines(
            resolver,
            lines,
            draft.cashbookId,
            draft.sourceType,
        );

        return { ...deltas, lines };
    }

    /**
     * Derive cache deltas from resolved legs.
     *
     * `countsTowardCashbookTotals` is the compatibility hinge: only cashbook
     * entries move totalIncome/totalExpense, which keeps those columns meaning
     * exactly what they mean today (direct wallet transactions and transfers
     * have never counted as cashbook activity).
     */
    private async deltasFromLines(
        resolver: LedgerAccountResolver,
        lines: ResolvedLine[],
        cashbookId: string | null,
        sourceType: string,
    ): Promise<ResolvedDraft> {
        const cashbookDeltas = new Map<
            string,
            { balance: Decimal; totalIncome: Decimal; totalExpense: Decimal }
        >();
        const walletDeltas = new Map<string, Decimal>();
        let totalDebit = ZERO;
        let totalCredit = ZERO;

        const countsTowardCashbookTotals = sourceType === 'CASHBOOK_ENTRY';

        const bumpCashbook = (
            id: string,
            field: 'balance' | 'totalIncome' | 'totalExpense',
            amount: Decimal,
        ) => {
            if (amount.isZero()) return;
            const current =
                cashbookDeltas.get(id) ?? { balance: ZERO, totalIncome: ZERO, totalExpense: ZERO };
            current[field] = current[field].add(amount);
            cashbookDeltas.set(id, current);
        };

        for (const line of lines) {
            totalDebit = totalDebit.add(line.debit);
            totalCredit = totalCredit.add(line.credit);

            const meta = await resolver.metaFor(line.ledgerAccountId);
            const signedDebit = line.debit.sub(line.credit);

            if (meta.origin === 'BOOK_CASH' && meta.cashbookId) {
                bumpCashbook(meta.cashbookId, 'balance', signedDebit);
            }

            if (meta.origin === 'WALLET' && meta.walletAccountId) {
                walletDeltas.set(
                    meta.walletAccountId,
                    (walletDeltas.get(meta.walletAccountId) ?? ZERO).add(signedDebit),
                );
            }

            if (countsTowardCashbookTotals && cashbookId) {
                if (meta.class === 'INCOME') {
                    bumpCashbook(cashbookId, 'totalIncome', line.credit.sub(line.debit));
                }
                if (meta.class === 'EXPENSE') {
                    bumpCashbook(cashbookId, 'totalExpense', signedDebit);
                }
            }
        }

        return { lines, totalDebit, totalCredit, cashbookDeltas, walletDeltas };
    }

    private assertBalanced(draft: JournalDraft, resolved: ResolvedDraft): void {
        if (resolved.lines.length === 0) {
            throw new AppError(
                `Journal "${draft.postingKey}" has no legs.`,
                500,
                'LEDGER_EMPTY_JOURNAL',
            );
        }
        if (!resolved.totalDebit.equals(resolved.totalCredit)) {
            throw new AppError(
                `Unbalanced journal "${draft.postingKey}": ` +
                `debits ${resolved.totalDebit.toString()} ≠ credits ${resolved.totalCredit.toString()}.`,
                500,
                'LEDGER_UNBALANCED',
            );
        }
    }

    private async applyCacheDeltas(
        tx: Prisma.TransactionClient,
        resolved: ResolvedDraft,
    ): Promise<void> {
        // Deterministic order so concurrent posts touching the same rows queue
        // rather than deadlock.
        for (const cashbookId of [...resolved.cashbookDeltas.keys()].sort()) {
            const delta = resolved.cashbookDeltas.get(cashbookId)!;
            const data: Prisma.CashbookUpdateInput = {};
            if (!delta.balance.isZero()) data.balance = { increment: delta.balance };
            if (!delta.totalIncome.isZero()) data.totalIncome = { increment: delta.totalIncome };
            if (!delta.totalExpense.isZero()) data.totalExpense = { increment: delta.totalExpense };
            if (Object.keys(data).length > 0) {
                await tx.cashbook.update({ where: { id: cashbookId }, data });
            }
        }

        for (const accountId of [...resolved.walletDeltas.keys()].sort()) {
            const delta = resolved.walletDeltas.get(accountId)!;
            if (delta.isZero()) continue;
            await tx.account.update({
                where: { id: accountId },
                data: { balance: { increment: delta } },
            });
        }
    }
}
