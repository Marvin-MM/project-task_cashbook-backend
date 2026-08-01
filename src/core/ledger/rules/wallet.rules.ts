/**
 * Posting rules for wallet-level events. Pure — no I/O.
 *
 * These journals carry `cashbookId: null`, which is what keeps direct wallet
 * activity out of any cashbook's totalIncome/totalExpense — exactly as it has
 * always behaved. It still appears in the org-wide income statement, under an
 * "unassigned to a book" section.
 */
import { JournalSourceType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from '../../finance/money';
import type { JournalDraft, LegDraft } from '../ledger.types';

// ─── Direct wallet transaction ────────────────────────────

export interface DirectWalletPostingInput {
    workspaceId: string;
    accountId: string;
    transactionId: string;
    version: number;
    type: 'INCOME' | 'EXPENSE';
    amount: Decimal | string | number;
    chargeAmount?: Decimal | string | number | null;
    description: string;
    transactionDate: Date;
    currency: string;
    createdById: string;
}

export function walletTxPostingKey(transactionId: string, version: number): string {
    return `wallet-tx:${transactionId}:v${version}`;
}

/**
 * INCOME:  Dr Wallet (A−C) · Dr Fees (C) · Cr Other Income (A)
 * EXPENSE: Dr General Expenses (A) · Dr Fees (C) · Cr Wallet (A+C)
 */
export function buildDirectWalletJournal(input: DirectWalletPostingInput): JournalDraft {
    const amount = toDecimal(input.amount);
    const charge = toDecimal(input.chargeAmount);
    const wallet = { kind: 'WALLET', accountId: input.accountId } as const;

    const legs: LegDraft[] =
        input.type === 'INCOME'
            ? [
                { ref: wallet, debit: amount.sub(charge), memo: input.description },
                { ref: { kind: 'SYSTEM', key: 'TRANSACTION_FEES' }, debit: charge, memo: 'Transaction charge' },
                { ref: { kind: 'SYSTEM', key: 'OTHER_INCOME' }, credit: amount, memo: input.description },
            ]
            : [
                { ref: { kind: 'SYSTEM', key: 'GENERAL_EXPENSES' }, debit: amount, memo: input.description },
                { ref: { kind: 'SYSTEM', key: 'TRANSACTION_FEES' }, debit: charge, memo: 'Transaction charge' },
                { ref: wallet, credit: amount.add(charge), memo: input.description },
            ];

    return {
        workspaceId: input.workspaceId,
        // Deliberately null: direct wallet activity is not cashbook activity.
        cashbookId: null,
        currency: input.currency,
        entryDate: input.transactionDate,
        description: input.description,
        sourceType: JournalSourceType.ACCOUNT_TRANSACTION,
        sourceId: input.transactionId,
        postingKey: walletTxPostingKey(input.transactionId, input.version),
        createdById: input.createdById,
        legs,
    };
}

// ─── Opening balance ──────────────────────────────────────

export interface OpeningBalancePostingInput {
    workspaceId: string;
    accountId: string;
    /** Signed: negative means the wallet starts overdrawn (e.g. a credit card). */
    amount: Decimal | string | number;
    accountName: string;
    openedAt: Date;
    currency: string;
    createdById: string;
}

export function openingBalancePostingKey(accountId: string): string {
    return `account-open:${accountId}`;
}

/**
 * Dr Wallet / Cr Opening Balance Equity — the standard way to introduce a
 * starting balance without inventing income. Reversed when negative.
 */
export function buildOpeningBalanceJournal(input: OpeningBalancePostingInput): JournalDraft {
    const signed = toDecimal(input.amount);
    const magnitude = signed.abs();
    const wallet = { kind: 'WALLET', accountId: input.accountId } as const;
    const equity = { kind: 'SYSTEM', key: 'OPENING_BALANCE_EQUITY' } as const;

    const legs: LegDraft[] = signed.isNegative()
        ? [
            { ref: equity, debit: magnitude, memo: 'Opening balance' },
            { ref: wallet, credit: magnitude, memo: 'Opening balance' },
        ]
        : [
            { ref: wallet, debit: magnitude, memo: 'Opening balance' },
            { ref: equity, credit: magnitude, memo: 'Opening balance' },
        ];

    return {
        workspaceId: input.workspaceId,
        cashbookId: null,
        currency: input.currency,
        entryDate: input.openedAt,
        description: `Opening balance: ${input.accountName}`,
        sourceType: JournalSourceType.ACCOUNT_OPENING,
        sourceId: input.accountId,
        postingKey: openingBalancePostingKey(input.accountId),
        createdById: input.createdById,
        legs,
    };
}

// ─── Wallet-to-wallet transfer ────────────────────────────

export interface TransferPostingInput {
    workspaceId: string;
    transferId: string;
    fromAccountId: string;
    toAccountId: string;
    amount: Decimal | string | number;
    feeAmount?: Decimal | string | number | null;
    description: string;
    transferredAt: Date;
    currency: string;
    createdById: string;
}

export function transferPostingKey(transferId: string): string {
    return `transfer:${transferId}`;
}

/**
 * Dr destination (A) · Dr Fees (fee) · Cr source (A + fee)
 *
 * The principal is not income or expense — it moves between two asset accounts.
 * The fee is a genuine expense, and posting it here fixes a real gap: transfer
 * fees reduced the source wallet but appeared in no expense total anywhere.
 */
export function buildTransferJournal(input: TransferPostingInput): JournalDraft {
    const amount = toDecimal(input.amount);
    const fee = toDecimal(input.feeAmount);

    const legs: LegDraft[] = [
        { ref: { kind: 'WALLET', accountId: input.toAccountId }, debit: amount, memo: input.description },
        { ref: { kind: 'SYSTEM', key: 'TRANSACTION_FEES' }, debit: fee, memo: 'Transfer fee' },
        {
            ref: { kind: 'WALLET', accountId: input.fromAccountId },
            credit: amount.add(fee),
            memo: input.description,
        },
    ];

    return {
        workspaceId: input.workspaceId,
        cashbookId: null,
        currency: input.currency,
        entryDate: input.transferredAt,
        description: input.description,
        sourceType: JournalSourceType.ACCOUNT_TRANSFER,
        sourceId: input.transferId,
        postingKey: transferPostingKey(input.transferId),
        createdById: input.createdById,
        legs,
    };
}
