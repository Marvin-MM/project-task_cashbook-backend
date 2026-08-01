# Roles, project delivery and attendance

Companion to `accounting-model.md`, which covers the ledger. This one covers who
may do what, how work is assigned and approved, and how attendance is recorded.

---

## 1. Roles

Seven workspace roles. The two added most recently — `PROJECT_MANAGER` and `HR`
— exist to run work and people **without** touching money.

| Role | Runs | Sees money |
|---|---|---|
| `OWNER` | everything | yes |
| `ADMIN` | everything except deleting the workspace | yes |
| `ACCOUNTANT` | the books, across every cashbook | yes |
| `SUB_ACCOUNTANT` | the books, limited to granted cashbooks | yes |
| `PROJECT_MANAGER` | projects, tasks, assignment, task approvals | **no** |
| `HR` | attendance, schedules, leave, overtime, work reports | **no** |
| `MEMBER` | their own work | no |

`PROJECT_MANAGER` and `HR` hold **no** `ACCOUNTING` permission and, critically,
no `ACCESS_ALL_CASHBOOKS`. A book is reachable only through an explicit
`CashbookMember` row — the same path a plain member takes. This is not a special
case in the code: `requireCashbookMember` grants implicit access solely to roles
holding `ACCESS_ALL_CASHBOOKS`, so excluding them from that permission is the
whole mechanism.

Two consequences worth stating, because both are load-bearing:

- The book picker when approving an expense claim shows a project manager only
  the books they were actually added to. No filtering code makes that true; it
  falls out of the permission they do not have.
- `assignableRoles(HR)` is `[MEMBER]`. HR can onboard and offboard staff but
  cannot mint an admin, an accountant, another HR or a project manager — so they
  cannot route around the money ban through a second account. `members.service`
  checks the **target's current role** against the same list, which is what also
  stops HR demoting an existing admin.

### Permission bundles

`WORKSPACE_PERMISSION_MATRIX` is a `Record<WorkspaceRole, Set<…>>`, so adding a
role fails compilation until every row is handled. Three places do **not** fail
and must be updated by hand:

- `assignableRoles()` — its `default: return []` fails silently in the
  unhelpful direction, making a new role unassignable by anybody.
- `members.dto.ts` — a separate `z.enum` of assignable role names.
- Any remaining `role === WorkspaceRole.ADMIN` comparison.

A test asserts every role in `assignableRoles(OWNER)` is accepted by the DTO,
which catches the second of those.

### Route gating

`USE_PROJECTS`, `USE_TASKS` and `USE_TIME_TRACKING` are held by **every** role.
They answer "may you use this module", not "may you touch this record". Every
project, task and time route now names one; before this work all 34 were bare
`requireWorkspaceMember()` and the three permissions were decorative.

Row-level authority stays in the services, because it depends on the record:
task visibility is *created-by-me OR assigned-to-me OR in-a-project-I-belong-to*,
and write authority narrows further to the assignee. No route-level permission
can express that.

`requireWorkspaceMember` also accepts `{ anyOf: [...] }`. Member management
needs it: two different grants reach those routes (`MANAGE_MEMBERS` for
owner/admin/HR, the narrower `MANAGE_SUB_ACCOUNTANTS` for accountants) and
neither is a superset of the other.

---

## 2. Task lifecycle

```
TODO ──▶ IN_PROGRESS ──▶ IN_REVIEW ──▶ DONE
             ▲                │
             └── rejected ────┘
   BLOCKED reachable from anywhere
```

`IN_REVIEW` is the whole feature. An assignee **cannot** set `DONE`; they submit
an end-of-task report, which moves the task to `IN_REVIEW`, and approving is the
only route onwards. Rejecting returns it to `IN_PROGRESS` with a required note.

That one enum value makes two requirements the same mechanism: "members submit a
report at the end of each task" and "a member-created standalone task is signed
off by a manager once complete".

Three ways round it are closed:

- `IN_REVIEW` cannot be set directly — there would be nothing to decide.
- An assignee cannot move a task **out** of review.
- A manager *can* still force any status. They are the ones who would otherwise
  have to unpick a mistake.

### Asking for work

A member who can see a task but is not on it may request it. The gate:
`Workspace.maxConcurrentOpenTasks` (default 1, null = unlimited) caps how much
unfinished work one person may hold. `IN_REVIEW` still counts as unfinished —
the work can come back.

**The check runs twice**, and the second one is the real one. At request time it
produces a good error message; inside the approval transaction it decides.
Without the second, a member requests five tasks while free and a manager
approves all five an hour later.

---

## 3. Expense claims

A claim is an operational document. It becomes accounting only when somebody
approves it, and what gets posted depends on who paid.

**Paid from an org wallet** — one `EXPENSE` entry, wallet-linked:

```
Dr  Expense       40,000
    Cr  Wallet        40,000
```

Because it is wallet-linked the book balance does not move while money-out does,
and the wallet decreases. That is the existing rule, inherited rather than
reimplemented: the service calls `EntriesService` and does no arithmetic.

**Paid out of pocket** — a `PAYABLE` obligation owed to the claimant:

```
Dr  Deferred Purchases   40,000
    Cr  Accounts Payable     40,000   ← owed to the member
```

It deliberately does **not** hit the P&L yet. On this ledger's cash basis the
expense is recognised when the reimbursement is actually paid, and until then it
sits in AP aging under the person's name. Reimbursing them is an ordinary
`EXPENSE` entry settling that obligation.

`Contact.userId` + `ContactType.STAFF` make the member a counterparty; AP is
tracked against a `Contact` and a `User` is not one. The contact is created
idempotently on first reimbursement, so one person never splits across two.

### Posting exactly once

Three independent layers:

1. The claim row is claimed by compare-and-swap **before** anything posts, so a
   second approver never reaches the posting call.
2. `entryId` and `obligationId` are both `UNIQUE`.
3. A CHECK allows at most one of them to be set, and requires one when
   `APPROVED`.

If posting fails after the row is claimed, the claim is handed back rather than
becoming permanently un-approvable.

Proof is mandatory — checked at approval, not submission, so a claim can be
filed and the receipt attached a moment later, but never approved without one.

---

## 4. Attendance

### Time zones

`Workspace.timezone` is an IANA name. Every wall-clock policy is evaluated in
it. Before this existed, `enforceAttendanceTimeWindow` compared
`new Date().getHours()` — the *server container's* zone — against times the
schema described as "local". Deployed in UTC, a Kampala workspace configured
`08:00–09:30` really allowed 11:00–12:30 EAT.

`src/core/time/workspace-clock.ts` is the only place zone arithmetic happens. It
uses luxon, and its two DST policies are documented and tested rather than
assumed:

- **Spring forward** (a local time that does not exist): shifted forward by the
  gap, so 02:30 becomes 03:30 — not clamped to 03:00, because preserving the
  offset keeps a shift the length it was rostered for.
- **Fall back** (a local time that happens twice): the earlier, still-DST
  occurrence, so a shift is never retroactively lengthened by an hour nobody
  worked.

`isValidTimeZone` is stricter than luxon's. ICU resolves `EST`, `CET`, `EAT` —
and `EST` is a *fixed* −05:00 with no daylight saving, so a New York workspace
picking it would be an hour out from April to November, silently. Only
region-qualified names and `UTC` are accepted.

### Business dates

`business_date` is stored on sessions, time entries and the rollup, computed in
Node at write time and never derived on read. Three reasons:

- Aggregations group on an indexed plain `DATE` rather than
  `(ts AT TIME ZONE 'UTC' AT TIME ZONE tz)::date` on the hot path.
- Node's ICU tzdata and Postgres's can drift by a release. Only writes depend on
  Node's; only repair depends on Postgres's; they never have to agree live.
- Changing a workspace's zone later does not silently re-bucket history.

`AttendanceSettings.dayBoundaryMinutes` generalises cross-midnight shifts: set
it to 240 and a 01:30 clock-in belongs to the previous business date.

The period summary (`getTimeSummary`) is one `$queryRaw` with
`GROUPING SETS ((key), ())`, so the buckets and the grand total are computed in
a single pass and cannot disagree with each other. It groups and filters on
`business_date`. That is what fixed the bug it replaced: the old version pulled
rows into memory and bucketed on `startTime.toISOString().slice(0, 10)`, a UTC
slice, so under Kampala (+03:00) a 22:30Z entry — 01:30 the next local day —
was filed under the wrong date. `groupBy` maps through a whitelist to a column
name and is never interpolated.

### Windows are advisory

**Nothing may refuse a clock-out.** This is invariant, not preference.

The bug it replaces: a closed clock-out window made a session impossible to
close, and because the one-open-session rule is global that single stuck row
locked the person out of clocking in to *every* organisation, with no remedy
short of editing the database.

So `attendanceClockOutEnd` is deleted with no successor. `clockOutWindowStart`
survives as "earliest expected", raising an `EARLY_OUT` flag rather than
refusing. Clock-in windows may block, but only when the owner opts in via
`enforceClockWindows` — off by default, because refusing a late arrival means a
late employee records no attendance at all.

Four mechanisms back the invariant, and **all four are required**:

1. No clock-out upper bound exists.
2. Auto-close terminates a forgotten session.
3. `POST /me/attendance/close-open-session` is person-scoped, so it reaches a
   workspace the caller can no longer address. Deliberately not a `force=true`
   on another org's clock-in: a request authenticated against org A has no
   business writing into org B.
4. Removing a member force-closes their open session.

The geofence refuses **clock-in only**. GPS drifts indoors, and somebody who has
already left the site would otherwise be trapped.

### Uniqueness

The schema used to *claim* a partial unique index enforced one open
timer/session. No migration ever created it, so the guards were plain
read-then-write races and the `P2002` handlers were unreachable code. Real now:

```sql
CREATE UNIQUE INDEX work_sessions_one_open_per_user
  ON work_sessions (user_id) WHERE clock_out IS NULL;      -- the cross-org guard
CREATE UNIQUE INDEX time_entries_one_open_timer
  ON time_entries (user_id, workspace_id) WHERE end_time IS NULL AND source = 'TIMER';
CREATE UNIQUE INDEX presence_one_open_per_session
  ON work_session_presence (session_id) WHERE ended_at IS NULL;
```

Migration `0008` **closes duplicate open rows before creating these**, because
`CREATE UNIQUE INDEX` fails outright on a database that already hit the race.

### Presence

Intervals, not a column, because unpaid `BREAK`/`LUNCH` minutes are *subtracted*
from worked time and that needs durations. `WorkSession.presenceStatus` caches
the open interval, and a CHECK makes
`(clock_out IS NULL) = (presence_status IS NOT NULL)` structural — presence
cannot outlive its session.

Only the subject may set their own status. A manager writing it would make it a
claim *about* somebody rather than *by* them, at which point it means nothing.

Presence is shared with everyone; **location is not**. The team endpoint omits
location, distance and session detail for callers without
`VIEW_ALL_ATTENDANCE` — filtered in the query, so it never reaches the browser.

### The daily rollup

`attendance_days` is derived, with a single writer. It exists because absence
cannot be computed from rows that exist: "who was missing on Tuesday" needs a
day × member grid resolved against schedules, holidays, leave and employment
dates. No `GROUP BY` over `work_sessions` produces a row for somebody who never
clocked in.

Guard rails match the ledger's cached balances: one writer, **full recompute
never deltas**, and idempotence pinned by a test that recomputes three times and
compares byte-for-byte.

`WorkspaceMember.employmentStartDate/EndDate/attendanceTracked` stop it inventing
absences for the owner, for contractors, and for every day before somebody was
hired.

### Overtime is two numbers

- `rawOvertimeMinutes` — always measured, whatever the toggle says.
- `countedOvertimeMinutes` — what totals and pay use. Zero when the workspace
  does not track overtime **and** no approved request covers the day.

A CHECK enforces `counted <= raw`. Discarding the measurement is what makes a
later dispute unresolvable: an approval weeks afterwards needs something to turn
into counted time.

### Leave

Approved leave is materialised **one row per working day** into `leave_days`,
with a unique on `(workspace, user, date)`. That does two jobs: "is this person
expected today" becomes an indexed lookup instead of half-day range arithmetic,
and double-booking becomes impossible even when two approvals commit at the same
instant — which no service-level overlap check can promise.

Day counting skips non-working days and holidays, so Friday→Monday is two days,
not four. A clash rolls the entire approval back; you never get half a holiday
booked.

### Flags

`LATE_IN`, `EARLY_OUT`, `MISSED_CLOCK_OUT`, `ABSENT`, `OUT_OF_GEOFENCE`. Flags
only — no money, no scoring.

**Lateness has exactly one definition**: minutes past the scheduled start, past
the grace period. It briefly had two — the clock-in path measured from the
*window* closing while the rollup measured from the *shift start* — which are
different numbers and would have disagreed on the same day. The window is a
question of permission (may you clock in at all); lateness is a question about
the shift. `lateMinutes()` is the single implementation.

Flags are raised **where they are earned**, not only overnight: `LATE_IN` at
clock-in, `EARLY_OUT` and `OUT_OF_GEOFENCE` at clock-out, `ABSENT` and
`MISSED_CLOCK_OUT` by the jobs that need hindsight. A badge appears the moment
it is deserved, and the nightly rollup re-raising it is a no-op.

Idempotent by partial unique index, and raised with `ON CONFLICT DO NOTHING`
rather than upsert, which also means a **waived flag is never resurrected** by a
later recompute.

Waiving requires a reason at the database, and is **owner/admin only**. HR owns
the attendance policy, so letting them erase breaches of it would put the same
person on both sides.

### Scheduled jobs

`src/jobs/attendanceScheduler.ts`, every five minutes. Each workspace is
evaluated in its own zone, which is why one global tick serves tenants on
different continents.

- **Wrap-up reminder** — inside the window before the scheduled end, once per
  session thanks to the notification `groupKey`.
- **Auto-close** — credits the **scheduled end**, not the job's run time. A
  forgotten tap gives 8 hours, not 14; over-crediting is far harder to unpick,
  because nobody audits hours that look generous. The conditional UPDATE means a
  real clock-out a second earlier wins and the job no-ops.
- **Daily close** — rolls up yesterday once each workspace's local day is over.

These run on `setInterval` like the two existing schedulers, but unlike those
they **notify and write**, so multiple replicas would duplicate work. Each tick
therefore takes a Postgres **transaction-scoped advisory lock** first
(`pg_try_advisory_xact_lock`); the losers skip that tick rather than queue
behind the winner, since running the same work five minutes later is no better.

Transaction-scoped and not session-scoped, for two reasons that both bite under
a connection pool: a session lock's `pg_advisory_unlock` can be routed to a
different connection than the one holding it, silently wedging the scheduler for
the life of the process; and session locks are re-entrant, so two overlapping
ticks in one process would both be granted it. A transaction lock releases on
commit, on rollback, and on the process dying.

Belt and braces on top: the deterministic `groupKey` collapses duplicate
notifications and every write is conditional, so even a duplicated tick cannot
double-notify.

---

## 5. Notifications

`Notification` carries `entityType`/`entityId` so it can point at a request,
report or claim rather than only a task, plus a `groupKey` with a unique on
`(userId, type, groupKey)`. The worker upserts when a key is present, so BullMQ
retries and replica overlap collapse onto one row instead of ringing the bell
four times.

---

## 5a. Attachments

`Attachment` is polymorphic: `cashbookId`, `taskId`, `taskReportId` or
`expenseClaimId`, with a CHECK enforcing exactly one. One model rather than one
per owner, so storage, presigning and soft-delete stay a single code path — two
file stacks is how a delete ends up removing the row on one side and orphaning
the object on the other.

Who may attach differs by owner, and deliberately:

- **Task** — anyone who can *view* it. A photo of the thing you are describing
  is the same contribution as a sentence about it, so requiring write access
  would mean only managers could add evidence to work they are not doing.
- **Task report** — the author only, and only while it is still under review. A
  decided report is a record of what was reviewed.
- **Expense claim** — the claimant only, and only while pending. A receipt
  supplied by the person approving the spend is not proof of anything.

---

## 6. Known gaps

- The attendance scheduler is `setInterval` + an advisory lock rather than a
  BullMQ repeatable job. Correct across replicas (above), but the tick is a
  poll: a wrap-up reminder fires within five minutes of its moment, not at it.
  Delayed jobs keyed `wrapup:{sessionId}` would make it exact.
- `scripts/rebuild-attendance-days.ts` rebuilds the rollup for a date range and
  reports what changed. It always writes, deliberately: the table is fully
  derived, so a dry run would have to write and roll back, and a `--dry-run`
  flag that still writes is worse than none.
