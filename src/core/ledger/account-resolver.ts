/**
 * Turns declarative LedgerRefs into ledger account ids.
 *
 * This is the only impure part of the posting pipeline. Rules stay pure and
 * exhaustively unit-testable; all database lookups live here, behind a
 * per-transaction cache so a multi-leg journal does not re-query the same
 * account repeatedly.
 */
import { Prisma } from '@prisma/client';
import { AppError } from '../errors/AppError';
import {
    ensureCashbookLedgerAccount,
    ensureWalletLedgerAccount,
    ensureWorkspaceChartOfAccounts,
} from './coa.seed';
import type { LedgerAccountMeta, LedgerRef, SystemLedgerKey } from './ledger.types';

export class LedgerAccountResolver {
    private readonly systemKeyCache = new Map<SystemLedgerKey, string>();
    private readonly metaCache = new Map<string, LedgerAccountMeta>();
    private chartEnsured = false;

    constructor(
        private readonly tx: Prisma.TransactionClient,
        private readonly workspaceId: string,
        private readonly currency: string,
    ) { }

    async resolve(ref: LedgerRef): Promise<string> {
        switch (ref.kind) {
            case 'EXPLICIT':
                return ref.ledgerAccountId;
            case 'SYSTEM':
                return this.resolveSystem(ref.key);
            case 'WALLET':
                return this.resolveWallet(ref.accountId);
            case 'BOOK_CASH':
                return this.resolveBookCash(ref.cashbookId);
            case 'CATEGORY':
                return this.resolveCategory(ref.categoryId, ref.fallback);
        }
    }

    /**
     * System accounts are scoped by currency: a workspace holding both UGX and
     * USD books has one Sales Revenue account per currency, because a journal
     * may never mix currencies and there is no FX to convert between them.
     * The journal's currency selects which one.
     */
    private async resolveSystem(key: SystemLedgerKey): Promise<string> {
        const cached = this.systemKeyCache.get(key);
        if (cached) return cached;

        const lookup = () =>
            this.tx.ledgerAccount.findUnique({
                where: {
                    workspaceId_systemKey_currency: {
                        workspaceId: this.workspaceId,
                        systemKey: key,
                        currency: this.currency,
                    },
                },
                select: { id: true },
            });

        let account = await lookup();

        // Self-heal: a workspace created before the ledger existed, or one
        // posting in a currency it has not used before, provisions the chart on
        // first use rather than failing.
        if (!account && !this.chartEnsured) {
            const workspace = await this.tx.workspace.findUnique({
                where: { id: this.workspaceId },
                select: { defaultCurrency: true },
            });
            await ensureWorkspaceChartOfAccounts(
                this.tx,
                this.workspaceId,
                this.currency,
                workspace?.defaultCurrency ?? this.currency,
            );
            this.chartEnsured = true;
            account = await lookup();
        }

        if (!account) {
            throw new AppError(
                `Chart of accounts is missing the "${key}" account in ${this.currency} for this workspace.`,
                500,
                'LEDGER_ACCOUNT_MISSING',
            );
        }

        this.systemKeyCache.set(key, account.id);
        return account.id;
    }

    private async resolveWallet(accountId: string): Promise<string> {
        const account = await this.tx.account.findUnique({
            where: { id: accountId },
            select: {
                id: true,
                workspaceId: true,
                name: true,
                currency: true,
                ledgerAccountId: true,
                accountType: { select: { classification: true } },
            },
        });

        if (!account) {
            throw new AppError(`Wallet ${accountId} not found`, 404, 'ACCOUNT_NOT_FOUND');
        }
        if (account.workspaceId !== this.workspaceId) {
            throw new AppError('Wallet belongs to a different workspace', 400, 'INVALID_ACCOUNT');
        }

        // Backfills wallets that predate the ledger on first use.
        return ensureWalletLedgerAccount(this.tx, account, account.accountType.classification);
    }

    private async resolveBookCash(cashbookId: string): Promise<string> {
        const cashbook = await this.tx.cashbook.findUnique({
            where: { id: cashbookId },
            select: {
                id: true,
                workspaceId: true,
                name: true,
                currency: true,
                cashLedgerAccountId: true,
            },
        });

        if (!cashbook) {
            throw new AppError(`Cashbook ${cashbookId} not found`, 404, 'CASHBOOK_NOT_FOUND');
        }

        return ensureCashbookLedgerAccount(this.tx, cashbook);
    }

    /**
     * A category may map to a GL account. Unmapped categories — the common case,
     * since mapping is optional and hidden from non-accountants — fall back to
     * the seeded revenue/expense account.
     */
    private async resolveCategory(
        categoryId: string | null,
        fallback: SystemLedgerKey,
    ): Promise<string> {
        if (!categoryId) return this.resolveSystem(fallback);

        const category = await this.tx.category.findUnique({
            where: { id: categoryId },
            select: { glAccountId: true, glAccount: { select: { isPostable: true, isActive: true } } },
        });

        if (
            category?.glAccountId &&
            category.glAccount?.isPostable &&
            category.glAccount.isActive
        ) {
            return category.glAccountId;
        }

        return this.resolveSystem(fallback);
    }

    /** Metadata the posting service needs to derive cache deltas from legs. */
    async metaFor(ledgerAccountId: string): Promise<LedgerAccountMeta> {
        const cached = this.metaCache.get(ledgerAccountId);
        if (cached) return cached;

        const account = await this.tx.ledgerAccount.findUnique({
            where: { id: ledgerAccountId },
            select: {
                id: true,
                class: true,
                origin: true,
                currency: true,
                walletAccount: { select: { id: true } },
                cashbook: { select: { id: true } },
            },
        });

        if (!account) {
            throw new AppError(
                `Ledger account ${ledgerAccountId} not found`,
                500,
                'LEDGER_ACCOUNT_MISSING',
            );
        }

        const meta: LedgerAccountMeta = {
            id: account.id,
            class: account.class,
            origin: account.origin,
            currency: account.currency,
            walletAccountId: account.walletAccount?.id ?? null,
            cashbookId: account.cashbook?.id ?? null,
        };

        this.metaCache.set(ledgerAccountId, meta);
        return meta;
    }
}
