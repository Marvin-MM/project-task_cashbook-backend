# Accounting model

This product keeps a **double-entry general ledger** on a **cash basis**.

Every financial event posts a balanced journal. The screens users see are
unchanged — someone still records an income or expense entry and may optionally
attach a wallet, contact, category, obligation or inventory line. The
double-entry sits entirely behind that.

## The load-bearing idea

Two facts make the product's existing rules fall out of double-entry for free:

1. Every **Cashbook** owns a private ASSET account — its **Book Cash**.
2. Every wallet **Account** owns its own ledger account.

An entry's cash leg routes to Book Cash when no wallet is attached, and to the
wallet when one is. Nothing else changes. So:

| Event | Legs | `Cashbook.balance` | `totalIncome` | `totalExpense` | Wallet |
|---|---|---|---|---|---|
| INCOME 100, charge 5, **unlinked** | Dr BookCash 95 · Dr TxnFees 5 · Cr Revenue 100 | +95 | +100 | +5 | — |
| INCOME 100, charge 5, **wallet-linked** | Dr Wallet 95 · Dr TxnFees 5 · Cr Revenue 100 | **0** | +100 | +5 | +95 |
| EXPENSE 100, charge 5, unlinked | Dr GenExp 100 · Dr TxnFees 5 · Cr BookCash 105 | −105 | 0 | +105 | — |
| EXPENSE 100, charge 5, wallet-linked | Dr GenExp 100 · Dr TxnFees 5 · Cr Wallet 105 | **0** | 0 | +105 | −105 |

"A wallet-linked entry does not move the book balance but still counts toward
money in and out" is no longer a rule anyone enforces. It is simply where the
debit went. The income and expense legs are identical in both cases, which is
exactly why the totals are unaffected by linking.

## Cached balances

Four columns are caches, derived from the ledger, with exactly one writer —
`PostingService`:

```
Cashbook.balance      = Σ(debit − credit) on that book's Book Cash account
Cashbook.totalIncome  = Σ(credit − debit) on INCOME lines,  sourceType = CASHBOOK_ENTRY
Cashbook.totalExpense = Σ(debit − credit) on EXPENSE lines, sourceType = CASHBOOK_ENTRY
Account.balance       = Σ(debit − credit) on that wallet's ledger account
```

The `sourceType = CASHBOOK_ENTRY` restriction is what preserves the original
meaning of the activity totals: direct wallet transactions and transfers have
never counted as cashbook activity, and still don't.

`LedgerIntegrityService` asserts all four as **exact equalities**, with no
exception list. `npm run repair:balances` re-derives them.

## Chart of accounts

Seeded per workspace on creation. Users never see most of it — the Accounts page
still shows only wallets. The full chart is an accountant-only surface.

```
1000 Assets                                   3000 Equity
  1010 Book Cash    (one per cashbook)          3100 Opening Balance Equity
  1100 Wallets      (one per asset wallet)      3200 Retained Earnings
  1200 Accounts Receivable                      3900 Owner Drawings
  1300 Inventory                              4000 Income
  1310 Inventory On Rent                        4100 Sales Revenue
  1900 Suspense                                 4200 Rental Income
2000 Liabilities                                4900 Other Income
  2100 Accounts Payable                       5000 Expenses
  2200 Tax Payable                              5100 Cost of Goods Sold
  2400 Deferred Revenue  (cash-basis offset)    5200 General Expenses
  2450 Deferred Purchases (cash-basis offset)   5300 Transaction Fees
  2900 Wallet Liabilities (credit cards, loans) 5400 Inventory Adjustments
```

Categories may optionally map to an income or expense account
(`Category.glAccountId`). Unmapped categories — the common case — post to Sales
Revenue or General Expenses, which is why the entry form never mentions any of
this.

## Why "Deferred Revenue" exists

Two requirements pull in opposite directions: revenue is recognized on **cash**,
but a balance sheet without receivables is not a balance sheet.

Booking `Dr AR / Cr Revenue` when an invoice is sent would put AR on the balance
sheet, but the later payment entry would then have no income leg — and
`Cashbook.totalIncome` would silently stop matching what every existing screen
shows.

So an obligation books `Dr AR / Cr Deferred Revenue`: the receivable appears as
an asset, offset by a liability, with no effect on the P&L. When cash arrives,
the entry rules move the amount out of Deferred Revenue into Revenue:

```
Obligation opened   Dr Accounts Receivable        Cr Deferred Revenue
Payment received    Dr Cash          Cr AR   +   Dr Deferred Revenue  Cr Revenue
```

Revenue is still recognized on cash. AR is still on the balance sheet. Every
cache identity above holds unconditionally. The cost is one account an
accountant will ask about — the answer being that this workspace is cash-basis
and AR is tracked as a memorandum asset with a matching offset.

`Workspace.revenueBasis` reserves `ACCRUAL` for later. Only `CASH` is
implemented; switching would decouple `Cashbook.totalIncome` from ledger income.

## Corrections are reversals, never deletions

Nothing is removed from the ledger. `journal_lines` is append-only, enforced by
a database trigger.

- **Deleting an entry** posts a mirror-image reversing journal and marks the
  entry `REVERSED`. It disappears from the list by default; `?includeReversed=true`
  shows it. Attachments are soft-deleted, not destroyed.
- **Editing an entry** reverses the previous version's journal and posts a new
  one under a fresh posting key (`entry:<id>:v2`). The entry keeps its id.
- **Cancelling an obligation** writes off only the amount still **outstanding**,
  not the original total. Reversing the opening journal would undo the full
  amount and drive AR negative by whatever had already been collected.

Reports never filter on journal status: a `REVERSED` original and its
`REVERSING` counterpart both contribute lines and net to zero. Filtering would
remove one side and double-count the correction.

## Database invariants

Four layers, none of which the application can bypass:

| Guard | Enforces |
|---|---|
| `assertBalanced` in `PostingService` | Debits equal credits, with a useful error |
| `journal_lines_balanced` (deferred trigger) | Same, at COMMIT, for every write path including psql |
| CHECK constraints | Non-negative amounts, one side per line, header totals match |
| `journal_lines_append_only` | No UPDATE or DELETE on posted lines |

Plus per-line currency and postable-account triggers. The escape hatch
(`SET LOCAL app.allow_ledger_maintenance = 'on'`) exists only for the test
harness and the seed script.

## Money placement rules

1. **Entry without a wallet** — cash leg on Book Cash; moves `Cashbook.balance`.
2. **Entry with a wallet** — cash leg on the wallet; `Cashbook.balance` untouched,
   activity totals still move.
3. **Direct wallet transaction** — journal carries `cashbookId: null`, so no book's
   totals move. Appears in the org-wide income statement under "Unassigned to a book".
4. **Transfer** — `Dr destination · Dr Fees · Cr source`. The principal is not
   income or expense; the fee is a real expense (it previously vanished).
5. **Charges** — INCOME: cash effect `amount − charge`, charge counts as expense.
   EXPENSE: cash effect `amount + charge`.
6. **Opening balance** — `Dr Wallet / Cr Opening Balance Equity`.
7. **Obligation payment** — always an entry; RECEIVABLE→INCOME, PAYABLE→EXPENSE.

## Period close

A closed `FiscalPeriod` rejects any posting dated inside it. Reversals of
entries in a closed period post at **today's** date instead of failing, so a
correction is still recorded without reopening the books.

## Concurrency

- `withFinancialTransaction` — READ COMMITTED, 20 s timeout, retries deadlocks
  and serialization failures with jitter.
- `acquireLocks` — every financial write declares its full lock set up front and
  takes rows in one global order (by table rank, then id). This removed a real
  deadlock where two entries swapping wallets in opposite directions each held
  one lock and waited on the other.
- Entry edits use a compare-and-swap on `version` inside the transaction.
  `expectedVersion` is required for any money-affecting change.
- Two idempotency layers: an `Idempotency-Key` header, and a unique
  `(workspaceId, postingKey)` on every journal — which holds even if the
  middleware is bypassed.

## Inventory

`Workspace.inventoryValuation` defaults to `OFF`: inventory is an operational
subledger, COGS feeds gross-margin reports, and stock purchases hit expense at
cash-out. This matches the cash-basis meaning of `totalExpense`.

`PERPETUAL` capitalizes purchases and recognizes COGS at sale. The posting rules
exist, but turning it on changes what `Cashbook.totalExpense` means for any book
that buys stock — it is an explicit, informed switch.

## Reports

All read from the ledger, all grouped by currency and never summed across it
(there is no FX, so a combined total would be fiction).

| Report | Notes |
|---|---|
| Balance sheet | As-of date. Includes current-period earnings so it balances before year-end close. |
| Income statement | Per book **and** consolidated in one query, via `GROUPING SETS`. |
| Trial balance | Debit and credit columns must match. |
| General ledger | Running balance ordered by `(entry_date, seq, line_number)`. |
| Cash flow | Direct method: decomposes cash-touching journals into non-cash counter-legs. Transfers self-cancel. |
| AR/AP aging | Balances from the ledger's obligation dimension; dates from the obligation table. Reports `controlVariance`. |

## Out of scope

- Multi-currency FX conversion
- Accrual revenue recognition (`revenueBasis = ACCRUAL` is reserved, not built)
- Automatic year-end close into Retained Earnings (the account exists; the
  balance sheet computes current-period earnings on the fly)

## Backfilling pre-ledger data

`npm run backfill:ledger` replays workspaces created before the ledger existed.

```
npm run backfill:ledger                        preview (rolls back)
npm run backfill:ledger -- --apply             write
npm run backfill:ledger -- --apply --workspace <id>
```

It walks each workspace's source records in chronological order and posts the
journals the live code would have posted at the time:

1. Opening balances — the old `Initial Balance` DIRECT transactions, booked to
   Opening Balance Equity rather than replayed as income
2. Obligations — the AR/AP opening entries
3. Entries — wallet link taken from the non-voided `CASHBOOK_ENTRY` transaction
4. Direct wallet transactions
5. Transfers
6. Obligation reconciliation — `outstandingAmount` recomputed from the entries
   that actually settled each obligation, since it has always been a cache
7. Write-offs — for cancelled obligations, and for ones archived while still open
8. Cache reconciliation — cashbook and wallet balances rebuilt from the ledger

**Guarantees.** Source records are the truth, never the cached balances. Posting
keys match the live code, so re-running is a no-op. A dry run does the whole
thing inside a transaction and rolls back, so the preview is exactly what
`--apply` produces.

**Nothing is guessed.** A record the ledger cannot represent faithfully is
skipped and reported with its id — most often an entry whose wallet is in a
different currency from its cashbook, which older builds allowed and current
code rejects. When anything is skipped the workspace's cached balances are left
alone rather than rewritten from an incomplete ledger.

### Running it in production

`npm run backfill:ledger` uses `tsx`, which is a devDependency and is pruned out
of the production image — so that command works on a developer machine and not
on the server. The compiled form is what runs in production, built by
`npm run build:scripts` into `dist-scripts/` and copied into the image by the
Dockerfile.

`tsconfig.scripts.json` exists for exactly this. The main build sets
`rootDir: ./src`, so widening it to include `scripts/` would relocate
`dist/server.js` and break `npm start`, the Dockerfile CMD and CI at once.

**On Kubernetes** (the deployment runs two replicas on k3s):

```
./k8s/ops-job.sh backfill-ledger.js              # preview, rolls back
./k8s/ops-job.sh backfill-ledger.js --apply      # write, once
```

The script builds a `Job` from the live Deployment, so the image and every
secret are by construction the ones the app itself uses.

**Once for the cluster, not once per pod.** These scripts act on the shared
Postgres; two replicas is a serving concern and the database is singular. One
Job is one pod is one execution. Running it per pod would at best do identical
work twice, and at worst have the two contend for the same rows.

**A Job, not `kubectl exec`.** `exec` runs inside a serving pod, where a
rollout, an eviction, a failed probe or a node drain kills it mid-run — while it
competes for that pod's memory and connection budget. A Job gets its own pod
with its own lifecycle, and its logs outlive the run.

**Not at startup.** Nothing runs these automatically and nothing should. The
container `CMD` is `prisma migrate deploy && node dist/server.js`; the scripts
are just files in the image. The backfill is a one-shot: it is idempotent — the
posting keys match the live code, so a second run is a no-op — but on every boot
it would scan every workspace before serving traffic, and a crash-loop would
hammer it.

Order on a first deploy: let the rollout finish (migrations run with it), then
preview, read the skipped list, `--apply`, then re-check integrity — the
script's own final section, or the **Reports → integrity banner** in the app. A
workspace with skipped records deliberately keeps its old cached balances, so
the banner flagging it afterwards is expected, not a second failure. Prefer a
quiet window: entries written while the backfill is rebuilding cached totals can
leave residual drift, which is precisely what the repair button then fixes.

The other two scripts take the same route:

```
./k8s/ops-job.sh repair-financial-balances.js --apply
./k8s/ops-job.sh rebuild-attendance-days.js --from 2026-05-01
```

Locally, without a cluster, the same binaries run directly:

```
docker compose run --rm api node dist-scripts/scripts/backfill-ledger.js --apply
```

### Migrations under two replicas

Both pods start together and both run the migration step. `prisma migrate
deploy` takes a Postgres advisory lock, so the first applies and the rest wait
and no-op — concurrent replicas are safe. `prisma db push` takes **no** such
lock and two concurrent pushes against one database can race; that is the second
reason to use `migrate deploy`, beyond it being the only one of the two that
keeps a migration history.

### Multi-currency workspaces

`createAccount` and `createCashbook` force the workspace currency, so new data
is single-currency. Older data is not. Where a workspace holds more than one,
each currency gets its own set of system accounts (`4100` and `4100-USD`), and
no journal ever mixes them — each currency's books balance independently. This
is what the per-currency report grouping has always assumed.
