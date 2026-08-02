# Moving production from `db push` to `migrate deploy`

The production database was built with `prisma db push`. Both commands now fail,
and they fail for different reasons:

```
db push        → Added the required column `business_date` … There are 9 rows …
                 You may use the --force-reset flag …
migrate deploy → P3005 The database schema is not empty.
```

**Never `--force-reset`.** It drops the database. It is not a fix, it is the
loss of every workspace, book and entry.

The rest of this document is the procedure that keeps the data. It has been
rehearsed against a database reconstructed to match production — same 9 work
sessions, same 2 time entries, same missing migration history — and the
rehearsal caught one real defect before it could reach the cluster.

## Why each command fails

**`db push` cannot do this, ever.** It diffs `schema.prisma` against the live
database and applies the difference in one step. Three columns are new and
`NOT NULL`, so for existing rows there is no value to write and push has nothing
to offer but dropping the table.

Migration `0008` does what push cannot: it adds each column **nullable**,
backfills it — `business_date` from `clock_in` converted into the workspace's
timezone, `created_by_id` from `user_id` — and only then applies `SET NOT NULL`.
The migration was written for exactly this data.

**`migrate deploy` fails on the missing history.** The database has no
`_prisma_migrations` table, because push never writes one. Prisma will not guess
which of the 15 migrations are already reflected in a non-empty schema, so it
stops rather than replaying `CREATE TABLE` over live tables. That is the right
instinct, and P3005 is a request for the answer, not a failure.

## The thing baselining alone would have got wrong

Baselining means recording migrations 0001–0007 as applied so deploy skips them.
Done naively, that is quietly destructive — not to data, to guarantees.

`db push` **never executes a migration file.** It only applies what
`schema.prisma` expresses, and Prisma's schema language has no syntax for
triggers, functions, or CHECK constraints. So the production database has the
ledger tables but none of the enforcement in `0004_ledger_core`:

| Missing object | What it enforces |
|---|---|
| `journal_lines_balanced` | debits equal credits, per journal, checked at COMMIT |
| `journal_lines_append_only` | history is reversed, never edited or deleted |
| `journal_lines_currency_matches` | a line's currency matches its ledger account |
| `journal_lines_account_postable` | nothing posts to a roll-up parent |
| `jl_nonneg`, `jl_one_side`, `jl_nonzero` | row-level sanity on every line |
| `je_balanced`, `je_reversal_consistent` | header totals agree; reversals point somewhere |

Production has been running the ledger with **none** of these since it was
deployed. Nothing has necessarily gone wrong — the application code posts
balanced journals — but the database has not been enforcing it, and the whole
point of that layer is that it holds when application code is bypassed or buggy.

Marking 0004 as applied would make the omission permanent, because 0004 would
never run again on that database.

`0015_ledger_integrity_backstop` closes it. Every statement is idempotent:
`CREATE OR REPLACE` for functions, `DROP TRIGGER IF EXISTS` then create for
triggers, and a catalogue check before each constraint (Postgres has no
`ADD CONSTRAINT IF NOT EXISTS`). On a correctly migrated database it changes
nothing; on the pushed one it installs what was missing. Verified both ways.

## Procedure

Every step runs as its own Job via `k8s/ops-job.sh`, which builds the pod from
the live Deployment so `DATABASE_URL` and every secret are by construction the
ones the app uses.

**Run it once for the cluster, not once per replica.** Two replicas is a serving
concern; the database is singular.

### 0. Back up

Not optional, and not "the cluster has snapshots".

```sh
kubectl exec -n inchange-app postgres-postgresql-0 -- \
  pg_dump -U postgres -Fc inchange_db > inchange_db-$(date +%F-%H%M).dump
ls -lh inchange_db-*.dump      # confirm it is not zero bytes
```

Restoring is `pg_restore -U postgres -d inchange_db --clean`. Know that before
you need it.

### 1. Preflight — read-only, changes nothing

```sh
./k8s/ops-job.sh preflight-baseline.js
```

It reports: whether the database is really unmanaged, whether the schema matches
the 0007 baseline point, which integrity objects are missing, **whether existing
data would violate the constraints 0015 adds**, and how many rows 0008 will
rewrite. It exits non-zero if anything would fail the deploy.

Read it. A `✗` means stop. Warnings about missing integrity objects are
expected — that is the whole point of 0015.

### 2. Stop the initContainer from fighting you

While the deployment's init step is `db push`, every rollout retries the failing
push. Change it to `npx prisma migrate deploy` **before** baselining, or scale to
zero for the duration:

```sh
kubectl scale deployment/inchange-app -n inchange-app --replicas=0
```

Scaling to zero is a short outage but it means nothing writes while the data
migrations run. With 9 sessions and 2 entries it takes seconds.

### 3. Baseline 0001–0007

These seven are already reflected in the schema, so they are recorded as applied
rather than re-run:

```sh
for m in 0001_baseline \
         0002_business_date_and_inventory_reversal \
         0003_idempotency_records \
         0004_ledger_core \
         0005_wallet_tx_version \
         0006_accountant_roles \
         0007_currency_scoped_system_accounts; do
  ./k8s/ops-job.sh --exec npx prisma migrate resolve --applied "$m"
done
```

`migrate resolve --applied` writes one row to `_prisma_migrations`. It runs no
DDL and touches no data.

### 4. Deploy the rest

```sh
./k8s/ops-job.sh --exec npx prisma migrate deploy
```

This applies 0008–0015. Expect, in order: the timezone column and business-date
backfill, the two new roles, task approvals, expense claims, attendance core,
people ops, the leave-cancellation fix, and the ledger integrity backstop.

Each migration is one transaction. If one fails, it rolls back and the ones
before it stay applied — fix the cause and re-run `migrate deploy`, which
resumes from where it stopped.

### 5. Bring it back up and verify

```sh
kubectl scale deployment/inchange-app -n inchange-app --replicas=2
./k8s/ops-job.sh --exec npx prisma migrate status     # expect: up to date
```

Then in the app, **Reports → integrity check**. It should be clean, or offer the
recalculate button for cached-balance drift — which is repairable and expected
if entries were written during the window.

### 6. Only now, the ledger backfill

Separate step, separate decision, and only if there is pre-ledger history to
replay:

```sh
./k8s/ops-job.sh backfill-ledger.js            # preview, rolls back
./k8s/ops-job.sh backfill-ledger.js --apply    # once
```

## What 0008 will change in your data

From the preflight against production-shaped data:

- **8 of the 9 open work sessions get closed** as `MIGRATION_DUPLICATE_OPEN`.
  They are duplicate open sessions for one user, which the old code allowed
  because the uniqueness guard had no index behind it. The newest stays open;
  the rest close at their own `clock_in` so no minutes are invented. This must
  happen before `work_sessions_one_open_per_user` is created, or the index build
  fails outright.
- Sessions open more than 36 hours close at `clock_in + 8h` as
  `MIGRATION_STALE_OPEN` — visible rather than silent.
- Every workspace gets `timezone = 'Africa/Kampala'`. Change it in settings
  afterwards if any workspace is elsewhere; business dates already written are
  not re-bucketed by a later change, which is deliberate.

## A defect this rehearsal found

Migration `0012` added

```sql
CHECK (("clock_out" IS NULL) = ("presence_status" IS NOT NULL))
```

with no backfill. Sessions written before presence existed have
`presence_status = NULL` whatever their state, so on any database with
attendance history the constraint is violated the instant it is added — the
deploy fails at 0012, in production, after 0008–0011 have already committed.

The test suite could not have caught it: `resetDatabase()` starts empty, and
every session the current code writes sets a presence. It took a database shaped
like production.

0012 now backfills both directions first — open sessions get `AVAILABLE`, closed
sessions get `NULL` — and then adds the constraint. Editing 0012 was safe
precisely because production had never applied it.

## Afterwards

Change the initContainer permanently:

```yaml
initContainers:
  - name: init-db-migrate          # was init-db-push
    command: ["npx", "prisma", "migrate", "deploy"]
```

Both replicas run it on every rollout. `migrate deploy` takes a Postgres
advisory lock, so the first applies and the rest wait and no-op. `db push` takes
no such lock, and two concurrent pushes against one database can race — which is
a second reason to switch, beyond it being the only one of the two that can add
a NOT NULL column to a table that already has rows.

---

# Exporting all data before a reset

The authoritative archive is a `pg_dump` — complete, restorable, and the only
form that can bring the system back. The Excel export is the *human-readable
rendering* of it, for people who want to read the numbers rather than restore
them. Keep both; they answer different questions.

**Do not build an endpoint for this.** An admin route returning every tenant's
finances in one response is the highest-value target in the system, has to hold
the result in a 512Mi pod, and "we will remove it after the export" is how such
routes come to live in a codebase for years. A script reading a restored dump
produces the identical spreadsheet with no auth surface and nothing left behind.

```sh
# 1. Fresh dump of current production
kubectl exec -n inchange-app postgres-postgresql-0 -- \
  env PGPASSWORD="$(kubectl get secret postgres-postgresql -n inchange-app \
    -o jsonpath='{.data.postgres-password}' | base64 -d)" \
  pg_dump -U postgres -Fc inchange_db > prod-$(date +%F).dump

# 2. Restore it somewhere that is not production — your laptop is ideal
createdb export_scratch
pg_restore -d export_scratch --no-owner prod-$(date +%F).dump

# 3. Render it
DATABASE_URL=postgresql://localhost/export_scratch npm run export:data -- --out ./exports
```

Output is one workbook per workspace (`Summary`, `Cashbooks`, `Entries`,
`Wallets`, `Wallet transactions`, `Contacts`, `Categories`, `Members`) plus
`_index-all-workspaces.xlsx` listing every workspace with its row counts and
filename. Amounts are written as numbers, not text, so they sum in Excel.

If the restored copy predates the current schema, run `prisma migrate deploy`
against the scratch database first — the script reads through the Prisma client,
which expects today's columns.

Reads only, re-runnable, and it never touches the live app.
