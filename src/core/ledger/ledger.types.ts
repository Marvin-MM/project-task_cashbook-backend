/**
 * Types for the double-entry posting engine.
 *
 * The split that matters: posting *rules* are pure functions producing a
 * declarative JournalDraft, and *resolution* (turning a LedgerRef into an
 * account id) is the only impure part. That keeps the rules exhaustively
 * unit-testable with zero I/O while the resolver is integration-tested once.
 */
import { Decimal } from '@prisma/client/runtime/library';
import type { JournalSourceType } from '@prisma/client';

/** Stable handles for seeded accounts, so rules never depend on codes or names. */
export type SystemLedgerKey =
    | 'AR'
    | 'AP'
    | 'INVENTORY'
    | 'INVENTORY_ON_RENT'
    | 'TAX_PAYABLE'
    | 'DEFERRED_REVENUE'
    | 'DEFERRED_EXPENSE'
    | 'OPENING_BALANCE_EQUITY'
    | 'RETAINED_EARNINGS'
    | 'OWNER_DRAWINGS'
    | 'SALES_REVENUE'
    | 'RENTAL_INCOME'
    | 'OTHER_INCOME'
    | 'COGS'
    | 'GENERAL_EXPENSES'
    | 'TRANSACTION_FEES'
    | 'INVENTORY_ADJUSTMENT'
    | 'SUSPENSE';

/** How a leg names the account it posts to. Resolved by LedgerAccountResolver. */
export type LedgerRef =
    | { kind: 'SYSTEM'; key: SystemLedgerKey }
    | { kind: 'WALLET'; accountId: string }
    | { kind: 'BOOK_CASH'; cashbookId: string }
    /** A user category, falling back to a seeded account when unmapped. */
    | { kind: 'CATEGORY'; categoryId: string | null; fallback: SystemLedgerKey }
    | { kind: 'EXPLICIT'; ledgerAccountId: string };

export interface LegDimensions {
    contactId?: string | null;
    categoryId?: string | null;
    obligationId?: string | null;
    inventoryItemId?: string | null;
    entryId?: string | null;
}

/** One side of a journal. Exactly one of debit/credit, strictly positive. */
export interface LegDraft {
    ref: LedgerRef;
    debit?: Decimal;
    credit?: Decimal;
    memo?: string;
    dims?: LegDimensions;
}

export interface JournalDraft {
    workspaceId: string;
    /** Null for org-level events (transfers, direct wallet transactions). */
    cashbookId: string | null;
    currency: string;
    entryDate: Date;
    description: string;
    sourceType: JournalSourceType;
    sourceId: string | null;
    /** Deterministic and unique per workspace. The exactly-once guarantee. */
    postingKey: string;
    createdById: string;
    /** Zero-amount legs are dropped during resolution. */
    legs: LegDraft[];
}

export interface ResolvedLine {
    lineNumber: number;
    ledgerAccountId: string;
    debit: Decimal;
    credit: Decimal;
    memo: string | null;
    dims: LegDimensions;
}

export interface PostedJournal {
    id: string;
    postingKey: string;
    totalDebit: Decimal;
    totalCredit: Decimal;
    lineCount: number;
    /** True when an existing journal was returned instead of a new one. */
    replayed: boolean;
}

/** Metadata the posting service needs to derive cache deltas from resolved legs. */
export interface LedgerAccountMeta {
    id: string;
    class: string;
    origin: string;
    currency: string;
    /** Set when origin === 'WALLET'. */
    walletAccountId: string | null;
    /** Set when origin === 'BOOK_CASH'. */
    cashbookId: string | null;
}
