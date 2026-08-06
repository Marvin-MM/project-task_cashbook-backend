/**
 * Deadlock-free pessimistic locking for financial writes.
 *
 * Two concurrent requests that lock the same rows in different orders will
 * deadlock. This module removes that class of bug by construction: every caller
 * declares the complete set of rows it needs up front, and `acquireLocks` takes
 * them in one globally consistent order — by table rank first, then by id.
 *
 * The bug this replaces: `EntriesService.updateEntry` locked the entry's current
 * wallet and then its target wallet in *argument* order. Two requests moving
 * entries X->Y and Y->X at the same time each held one lock and waited on the
 * other. `AccountsService.transferBetweenAccounts` already sorted its two ids;
 * this generalizes that discipline to every table.
 */
import { Prisma } from '@prisma/client';

/**
 * Global lock order. Lower rank is locked first.
 *
 * Rationale for the ordering: coarse containers before the rows they contain, so
 * a transaction that needs both never waits on a holder that is about to ask for
 * something it already has. INVENTORY_* rank after the financial rows because
 * `processStockIn`/`processStockOut` take their own `FOR UPDATE` on
 * inventory_stock while already inside an entry transaction — keeping them last
 * means that nested lock stays legal.
 *
 * TICKET_DAY and TICKET_SHIFT rank ABOVE cashbook for the same reason: a ticket
 * sale locks the day (to allocate a serial and check capacity) and then calls
 * into the entry path, which locks the cashbook and the wallet. Ranking the day
 * first means those two lock acquisitions compose into one globally consistent
 * order rather than racing each other.
 */
export const LOCK_RANK = {
    WORKSPACE: 0,
    TICKET_DAY: 1,
    TICKET_SHIFT: 2,
    CASHBOOK: 3,
    LEDGER_ACCOUNT: 4,
    WALLET_ACCOUNT: 5,
    OBLIGATION: 6,
    INVOICE: 7,
    INVENTORY_STOCK: 8,
    INVENTORY_LOT: 9,
    ENTRY: 10,
} as const;

export type LockTarget = keyof typeof LOCK_RANK;

const TABLE: Record<LockTarget, string> = {
    WORKSPACE: 'workspaces',
    TICKET_DAY: 'ticket_days',
    TICKET_SHIFT: 'ticket_shifts',
    CASHBOOK: 'cashbooks',
    LEDGER_ACCOUNT: 'ledger_accounts',
    WALLET_ACCOUNT: 'accounts',
    OBLIGATION: 'cashbook_obligations',
    INVOICE: 'invoices',
    INVENTORY_STOCK: 'inventory_stock',
    INVENTORY_LOT: 'inventory_lots',
    ENTRY: 'entries',
};

export interface LockRequest {
    target: LockTarget;
    /** Row ids. Nulls/undefined are ignored so callers can pass optional links directly. */
    ids: Array<string | null | undefined>;
}

/**
 * Lock every requested row `FOR UPDATE` in a globally consistent order.
 *
 * Call this ONCE per transaction, before any read whose value you intend to
 * write back. Incremental locking mid-transaction reintroduces the ordering
 * problem this exists to prevent.
 */
export async function acquireLocks(
    tx: Prisma.TransactionClient,
    requests: LockRequest[],
): Promise<void> {
    const byTarget = new Map<LockTarget, Set<string>>();

    for (const request of requests) {
        for (const id of request.ids) {
            if (!id) continue;
            let set = byTarget.get(request.target);
            if (!set) {
                set = new Set<string>();
                byTarget.set(request.target, set);
            }
            set.add(id);
        }
    }

    const targets = [...byTarget.keys()].sort((a, b) => LOCK_RANK[a] - LOCK_RANK[b]);

    for (const target of targets) {
        const ids = [...byTarget.get(target)!].sort();
        // ORDER BY id is not cosmetic: without it Postgres locks rows in scan
        // order, which can differ between two transactions even when the id
        // list passed in is identical.
        await tx.$queryRawUnsafe(
            `SELECT id FROM "${TABLE[target]}" WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
            ids,
        );
    }
}
