# API changes

What the frontend needs to know. Grouped by whether it **breaks**, **extends**,
or is **new**.

---

## Breaking

### `/admin` → `/platform`

The `admin` module duplicated `platform` exactly, without audit logging, and has
been deleted. There is no alias.

| Was | Now |
|---|---|
| `GET /admin/stats` | `GET /platform/stats` |
| `GET /admin/users` | `GET /platform/users` |
| `PATCH /admin/users/:userId/toggle-status` | `PATCH /platform/users/:userId/toggle-status` |
| `GET /admin/workspaces` | `GET /platform/workspaces` |

Response shapes are supersets of the old ones:

```jsonc
// GET /platform/stats
{
  "users":      { "total": 42, "active": 40 },
  "workspaces": 12,
  "cashbooks":  31,
  "entries":    { "posted": 980, "reversed": 14 },   // was a flat number
  "ledger":     { "journalEntries": 1204 }           // new
}
```

`src/hooks/useAdmin.ts` is the only caller and needs its three URLs updated.

### `expectedVersion` is now required for money-affecting entry edits

`PATCH /entries/:entryId/cashbook/:cashbookId` returns
`400 EXPECTED_VERSION_REQUIRED` when the body changes `amount`, `type`,
`chargeAmount`, `entryDate`, `accountId`, `obligationId` or `inventoryItems`
without `expectedVersion`.

Description-only and category-only edits are unaffected.

Pass the `version` from the entry you loaded. On `409` the entry changed
underneath you — refetch and let the user retry.

```ts
await apiClient.patch(`/entries/${id}/cashbook/${cashbookId}`, {
  amount: '500',
  expectedVersion: entry.version,   // ← required
});
```

### Reference data writes now need accountant-level access

`POST`/`PATCH`/`DELETE` on `/categories`, `/contacts` and `/payment-modes`
require `MANAGE_REFERENCE_DATA`, which `MEMBER` does not hold. Reads are
unchanged. Previously any member could delete a category used by every book in
the workspace.

### Financial modules are closed to `MEMBER`

`accounts`, `account-types`, `account-categories`, `account-transactions`,
`inventory`, `catalog`, `invoicing` and everything under `ledger-reports` and
`chart-of-accounts` now return `403` for a plain `MEMBER`. Hide the
corresponding nav items rather than letting the user click into a 403.

---

## Extended

### `WorkspaceRole` has two new values

```ts
type WorkspaceRole = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'SUB_ACCOUNTANT' | 'MEMBER';
```

| Role | Org financials | All cashbooks | Manage members |
|---|---|---|---|
| OWNER | ✓ | ✓ | ✓ (any role) |
| ADMIN | ✓ | ✓ | ✓ (any role except OWNER) |
| ACCOUNTANT | ✓ | ✓ | only `SUB_ACCOUNTANT` |
| SUB_ACCOUNTANT | ✓ | **granted books only** | — |
| MEMBER | — | granted books only | — |

`POST /workspaces/:workspaceId/members` accepts the new roles:

```jsonc
{ "email": "bookkeeper@example.com", "role": "SUB_ACCOUNTANT" }
```

Assigning a role above your own returns `403` with a message naming what you may
assign.

**Granting a sub-accountant their books** is a separate step, using the existing
endpoint, once they accept the invite:

```
POST /cashbooks/:cashbookId/members   { "userId": "…", "role": "BOOK_ADMIN" }
```

An invite creates no membership until accepted, so book grants cannot be bundled
into it. In the UI this is naturally a second step on the member's detail page.

### Entries: reversal replaces deletion

`DELETE /entries/:entryId/cashbook/:cashbookId` no longer destroys anything. It
posts a reversing journal and marks the entry `REVERSED`.

`Entry` gains:

```ts
status: 'POSTED' | 'REVERSED';
reversedAt: string | null;
reversedById: string | null;
reversalReason: string | null;
```

`GET /entries/cashbook/:cashbookId` hides reversed entries by default. Pass
`?includeReversed=true` for a "show reversed" toggle. Render those rows
distinctly — they are history, not live entries.

### Direct wallet transactions accept a business date

`POST`/`PATCH` on `/workspaces/:wid/accounts/:aid/transactions` accept an
optional `transactionDate` (ISO). Defaults to now. Lets a user backdate to match
a bank statement.

`AccountTransaction` now carries `transactionDate`, and statements are ordered by
it rather than `createdAt`.

### `Idempotency-Key` on financial writes

Optional today, logged when absent, and honoured when present. Send a UUID v4 on
entry create/update/delete, wallet transactions, transfers and manual journals.
A retry with the same key replays the original response instead of creating a
second record.

```ts
apiClient.post(url, body, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
```

`422 IDEMPOTENCY_KEY_REUSE` means the same key was sent with a different body —
a client bug. `409` means the original is still in flight; retry shortly.

### `GET /users/me` exposes `isSuperAdmin`

Use it to decide whether to show the `/platform` link in the sidebar dropdown.

---

## New

### Financial reports — `/workspaces/:workspaceId/ledger-reports/*`

All require `VIEW_FINANCIAL_REPORTS` (accountant and above).

| Endpoint | Query |
|---|---|
| `GET /balance-sheet` | `asOf?`, `fiscalYearStart?` |
| `GET /income-statement` | `from`, `to`, `cashbookId?` |
| `GET /trial-balance` | `asOf?`, `includeZeroBalances?` |
| `GET /general-ledger` | `ledgerAccountId`, `from`, `to` |
| `GET /cash-flow` | `from`, `to` |
| `GET /aging` | `type=RECEIVABLE\|PAYABLE`, `asOf?` |
| `GET /integrity` | — |

**Every report is currency-scoped.** There is no FX, so nothing is summed across
currencies:

```jsonc
{
  "mixedCurrency": false,
  "generatedAt": "2026-07-28T…",
  "byCurrency": [
    {
      "currency": "UGX",
      "sections": { /* report-specific */ },
      "outOfBalance": "0.0000"   // render loudly if not "0.0000"
    }
  ]
}
```

The income statement returns per-book **and** consolidated figures in one call:

```jsonc
{
  "books": [
    { "cashbookId": "…", "cashbookName": "Shop Floor",
      "income": [...], "expenses": [...],
      "totals": { "income": "750.0000", "expenses": "200.0000", "net": "550.0000" } },
    { "cashbookId": null, "cashbookName": "Unassigned to a book", ... }
  ],
  "consolidated": { "income": [...], "expenses": [...], "totals": {...} }
}
```

A book's `totals.income` equals the `totalIncome` already shown on the cashbook
summary. If they ever disagree, `GET /integrity` will say why.

### Chart of accounts — `/workspaces/:workspaceId/chart-of-accounts/*`

Accountant-only. The Accounts page is unchanged and still lists wallets only.

| Endpoint | Permission |
|---|---|
| `GET /` | `VIEW_CHART_OF_ACCOUNTS` |
| `POST /`, `PATCH /:id`, `POST /:id/archive` | `MANAGE_CHART_OF_ACCOUNTS` |
| `PUT /category-mappings/:categoryId` | `MANAGE_CHART_OF_ACCOUNTS` |
| `GET /journals` | `VIEW_LEDGER` |
| `POST /journals`, `POST /journals/:id/reverse` | `POST_MANUAL_JOURNAL` |
| `GET /periods` | `VIEW_LEDGER` |
| `POST /periods/close`, `POST /periods/:id/reopen` | `CLOSE_PERIOD` |

Accounts are **archived, never deleted** — one with postings cannot be removed
without destroying the journals that reference it. System accounts can be
renamed but not re-coded or re-classified.

Manual journals must balance; the API rejects unbalanced ones before they reach
the database.

### Period close

Once a period is closed, any posting dated inside it returns
`400 PERIOD_CLOSED`. Reversals of entries in a closed period are still accepted
and post at today's date instead — surface that in the UI so the user is not
surprised by the date on the correction.

---

## Unchanged

Worth stating explicitly, because the accounting underneath changed completely:

- The entry form. Income/expense, optional wallet, contact, category,
  obligation, inventory — same fields, same behaviour.
- **A wallet-linked entry still does not move the book balance, and still counts
  toward money in and out.** This is now a consequence of double-entry rather
  than a special case, but the numbers are identical.
- Cashbook summary, wallet list, net worth, invoices, inventory, obligations:
  same shapes, same semantics.
- The existing per-cashbook PDF/Excel export at `/reports/:cashbookId`.
