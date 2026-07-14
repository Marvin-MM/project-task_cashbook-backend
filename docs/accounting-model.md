# Accounting model (enhanced single-entry)

This product uses **cash-basis single-entry bookkeeping** with **wallet accounts**. It is **not** a double-entry general ledger.

## Core concepts

| Concept | Role |
|---------|------|
| **Cashbook** | Activity book: income/expense history, categories, contacts. `totalIncome` / `totalExpense` track activity. `balance` is **unallocated book cash** only (entries with no wallet). |
| **Account (wallet)** | Where liquid money sits (bank, cash, mobile money). Classified ASSET or LIABILITY for net-worth presentation. |
| **Entry** | Single-sided INCOME or EXPENSE event in a cashbook. May link to one wallet, an obligation, and/or inventory. |
| **Obligation** | AR/AP tracker (receivable/payable). Payments are Entries; outstanding is denormalized. |
| **Invoice** | Commercial document. On send → RECEIVABLE obligation. Cash is recognized when a payment Entry is posted (cash basis). |
| **Account transfer** | Move between wallets: **not** income/expense. Optional fee reduces the source wallet only. |
| **Inventory** | Operational stock + COGS; linked by reference. COGS is not auto-posted into cashbook P&L. |

## Money placement rules

1. **Entry without `accountId`** — updates `Cashbook.balance` and activity totals.
2. **Entry with `accountId`** — updates **wallet** balance only; cashbook activity totals still update; cashbook `balance` does **not**.
3. **Direct wallet transaction** — wallet only; not cashbook activity.
4. **Transfer** — atomic dual-wallet move; principal is not income/expense.
5. **Charges (`chargeAmount`)**  
   - INCOME: cash effect = `amount − charge`; charge counts toward `totalExpense`.  
   - EXPENSE: cash effect = `amount + charge`; full cash-out in `totalExpense`.
6. **Obligation payment** — always an Entry; direction RECEIVABLE→INCOME, PAYABLE→EXPENSE; invoice resynced on apply **and** reverse.

## Soft immutability

- Reconciled entries (`isReconciled = true`) cannot have amount/type/wallet/obligation/charge/date changed or be deleted until unreconciled.
- Preferred correction after reconcile: reverse (delete/void) after unreconcile, or unreconcile → edit → re-reconcile.

## Source of truth vs caches

| Source of truth | Cached fields |
|-----------------|---------------|
| Non-deleted Entries | Cashbook `balance`, `totalIncome`, `totalExpense` |
| Non-voided AccountTransactions + AccountTransfers | Account `balance` |
| Obligation outstanding math | Obligation `status` |
| Obligation outstanding (invoice-linked) | Invoice `amountPaid`, `amountDue`, `status` |

Use recalculate/repair endpoints to recompute caches; they must use the same formulas as the write path (`src/core/finance`).

## Out of scope

- Full chart of accounts / double-entry journals  
- Multi-currency FX  
- Accrual revenue on invoice send  
- Auto-posting inventory COGS into cashbook expense  
