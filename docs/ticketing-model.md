# Ticketing

Companion to `accounting-model.md` (the ledger) and `workforce-model.md` (who
may do what). This one covers the gate desk: how a ticket sale becomes money in
the books, how offers are priced, and who is allowed to work it.

---

## 1. The one-sentence version

**A ticket sale is an ordinary cashbook entry.** Everything else in this module
records *what was sold*; the entry records *that money moved*, through exactly
the same path a hand-typed entry takes.

No parallel money model was introduced, and that is the design constraint the
whole module is built around. `TicketingService.createSale` calls
`EntriesService.createEntryWithin`, which posts the journal, moves the wallet,
updates the cached balances and writes the financial audit rows. A ticket sale
is indistinguishable from any other income entry to the ledger, the reports, the
trial balance and the integrity checker — because it *is* one.

---

## 2. Enabling it

Ticketing is off for every organisation until a superadmin turns it on.

```
PATCH /platform/workspaces/:workspaceId/features   { feature: 'TICKETING', enabled: true }
```

This writes a `WorkspaceFeature` row. Its absence makes every ticketing route
answer **404, not 403** — an organisation that was never granted the module
should not be able to discover that other organisations have it.

Enabling only *unlocks* the module. The organisation still has to choose which
book gate money posts to and which category it counts as, because that is a
chart-of-accounts decision nobody outside the org is in a position to make.
Until `TicketSettings.isConfigured`, the desk returns `SETUP_REQUIRED` and
refuses to sell. `POST /ticketing/settings/provision` creates a dedicated
"Gate / Tickets" book in one call — worth doing, because a busy night is
hundreds of entries and they would otherwise bury a shared operational book.

---

## 3. Who may work the desk

Two axes, and keeping them apart is the point.

**`WorkspaceRole` carries authority.** One new role, `GENERAL_MANAGER`, which
runs the operation and owns ticketing outright while deliberately not being able
to change what the organisation *is* (rename, delete, bulk-import) or what its
books *mean* (chart of accounts, period close, manual journals), nor appoint
accountants. See its docstring in `core/types/workspace-permissions.ts`.

**`WorkspaceMember.staffTag` carries assignment.** A bar attendant, a
maintenance hand, a social media manager and a general supervisor all hold
exactly `MEMBER`'s permissions. Minting a role per job title would have grown the
permission matrix by five entries that differ only in their name, so the job is a
tag: `BAR`, `RESTAURANT`, `KITCHEN`, `TICKETING`, `MAINTENANCE`, `SOCIAL_MEDIA`,
`SUPERVISOR`, `SECURITY`, `OTHER`.

**`TICKETING` is the one tag that grants anything.** It admits its holder to the
desk — `VIEW_TICKETING`, `SELL_TICKETS`, `VOID_TICKET_SALE`, and nothing else.
That resolution lives in `core/authz/ticketing-access.ts` rather than in
`WORKSPACE_PERMISSION_MATRIX`, which is keyed by role alone and must stay that
way: a matrix that sometimes depended on a second column would stop being
checkable by reading it.

The escalation this guards against, and the reason the tag is not just a label:
HR holds `MANAGE_MEMBERS` and no financial permission whatsoever. Confirming a
ticket sale posts a cashbook entry and moves a wallet. So assigning or clearing
the `TICKETING` tag requires `MANAGE_TICKETING`, not `MANAGE_MEMBERS` —
otherwise HR could hand out the ability to post money by relabelling somebody, a
sideways route to exactly what `assignableRoles()` blocks on the role axis.

| | View | Sell | Void | Manage | Reconcile | Memberships | Analytics |
|---|---|---|---|---|---|---|---|
| `OWNER` / `ADMIN` / `GENERAL_MANAGER` | ✓ | ✓ | any | ✓ | ✓ | ✓ | ✓ |
| `ACCOUNTANT` / `SUB_ACCOUNTANT` | ✓ | — | — | — | — | — | ✓ |
| `MEMBER` + `TICKETING` tag | ✓ | ✓ | own | — | — | — | — |
| `MEMBER`, `HR`, `PROJECT_MANAGER` | — | — | — | — | — | — | — |

An attendant cannot change the prices they sell at, reconcile their own drawer,
or read the takings analytics. That is what makes the desk safe to be two taps.

---

## 4. Pricing

**`TicketSession` is a "day"** in the client's language: Thursday is one session
with its own tiers and offers, Friday another. A session is either a weekly
pattern (`dayOfWeek`) or a one-off override for a single date (`specificDate`),
never both — asserted by a CHECK. A date-specific session wins, which is how a
public holiday gets its own prices without disturbing the weekly rota. Partial
unique indexes keep at most one active session per weekday and per date, so
"which session is running tonight" always has one answer.

**`TicketType` is a price tier** inside a session: Adult, Minor, VIP. Its
`patronClass` (`ADULT` / `MINOR` / `OTHER`) is what the guardian-comp rule counts.

**`TicketDiscountRule` is an offer.** `config` is JSON so adding an offer shape
does not mean a migration:

```
GUARDIAN_COMP { minMinors, compPatronClass, maxCompPerSale }
GROUP         { minQuantity, ticketTypeIds }
MEMBERSHIP    { ticketTypeIds }          — tier comes from membershipTierId
MANUAL        { ticketTypeIds }          — never applies unless explicitly named
```

`modules/ticketing/pricing.ts` is pure — no I/O, no clock — and exhaustively
unit-tested, for the same reason `core/ledger/rules/entry.rules.ts` is: the
arithmetic that decides what somebody is charged should be readable end to end
without a database in the way.

Three properties worth knowing:

- **Offers apply per head, not per line.** An adult with two minors yields three
  tickets, one of which is free. Rolling that into a line total would lose which
  head was comped and why.
- **Best value first.** Where a rule can only cover so many heads, it covers the
  dearest ones. Cheapest-first would be compliant and would feel like being
  short-changed.
- **`net = gross − discount` holds exactly** at ticket, line and sale level. The
  database asserts precisely that in CHECK constraints, so rounding is applied to
  the *discount* and the net is subtracted — rounding both would eventually
  produce a sale Postgres refuses to store.

The desk previews a price via `POST /ticketing/quote`, but **confirm re-runs
`quoteSale` server-side from database state and ignores anything the client
thought the answer was.**

---

## 5. What a sale does

```
resolve business day (timezone + dayStartMinutes)
resolve session, price the basket, validate the wallet
ensureDay()                                    ← outside the transaction, see §8

withFinancialTransaction:
  lock TICKET_DAY                              ← ranks ABOVE cashbook
  re-price under the lock, from the database
  capacity check (issued non-voided + wanted ≤ cap)  → SOLD_OUT
  allocate serials from TicketDay.nextSerial
  create TicketSale + TicketSaleLine[] + Ticket[]
  if net > 0:  createEntryWithin(...)          ← the money
  MembershipUsage row if a card discounted anything
  AuditLog TICKET_SALE_CREATED
```

**Discounts post net.** The entry records cash actually received. Gross, discount
and the rule that fired are kept on each `Ticket` row, so the analytics page can
still report what was given away. This matches the cash-basis ledger
(`revenueBasis = CASH`) and needs no new GL accounts.

**A fully comped sale posts no entry at all.** There is no money to record, and a
zero-amount entry would fail validation. The tickets are still issued and still
count as admissions — which is the point of tracking comps.

**Prices are snapshotted** onto `TicketSaleLine.unitPrice` and
`Ticket.grossPrice`. Editing Friday's adult price changes what the next sale
costs and nothing else; last Friday's takings are not rewritten.

The route carries the existing `idempotency()` middleware, so a double-tapped
confirm on a slow connection replays the stored response instead of charging
twice.

---

## 6. Reversing

There is **no edit**. A wrong amount is voided and re-issued, so the record shows
what happened rather than what somebody later decided it should have said.

| Who | What they reach |
|---|---|
| Attendant | their **own** sale, on the **current open** day (`allowSelfVoid` can turn this off) |
| `MANAGE_TICKETING` | any sale, any open day |
| Anybody, on a **closed** day | nothing |

A void calls `EntriesService.reverseEntryWithin`, so the original journal is kept
and marked `REVERSED` and a mirror-image `REVERSING` journal is appended — the
books stay balanced and the correction is itself auditable. Tickets become
`VOIDED`, which frees their capacity. The `MembershipUsage` row is *deleted*
rather than kept, because those rows enforce the tier's per-day cap and leaving a
voided redemption in place would spend an allowance nobody received; the void
itself is audited, so nothing is lost.

Rationale for letting attendants self-void: a mis-tap at a gate is caught in
seconds, and routing that through an approval blocks the queue on somebody else's
phone. The narrowing to own-sale-and-open-day is what keeps it safe.

---

## 7. Reconciling

**`TicketShift` is a cash drawer.** Counts are per **wallet**, not one total,
because a gate takes cash and mobile money in the same shift and they are
separate pots with separate risks — one combined figure hides a cash shortfall
behind a mobile-money surplus, which is exactly the discrepancy a drawer count
exists to surface. Expected takings are computed from the shift's non-voided
sales and **snapshot** onto the shift at close, so a later reopen-and-void cannot
change what the attendant was held to. A wallet that took money and was not
counted shows as short rather than disappearing.

**Closing a `TicketDay` is what "reconcile" means.** It sets `isReconciled` on
every entry the night posted, and the ledger already treats a reconciled entry as
immutable: it cannot be deleted, reassigned, or have its money fields edited from
anywhere in the application. Closing requires every drawer to be counted in
first. Reopening requires `MANAGE_TICKETING`, clears the flag, and is audited.

---

## 8. Two things that are easy to get wrong

**Business day, not calendar day.** A venue running past midnight rings a sale at
01:30 that belongs to the previous evening: Thursday's prices, Thursday's
session, Thursday's Z-report. `TicketSettings.dayStartMinutes` (e.g. 360 = 06:00)
is applied through `WorkspaceClock` — the same class attendance uses for night
shifts, already tested against DST gaps and ambiguities — so the two features
cannot drift into two different notions of "yesterday".

**`ensureDay` runs outside the sale transaction.** Two attendants ringing the
first sale of the night at the same instant race on the day's unique constraint,
and in Postgres a failed statement aborts the surrounding transaction: every
subsequent command returns `25P02`. So the loser cannot recover by reading the
winner's row from inside the same transaction — it can only roll the whole sale
back. Creating the day first, in its own statement, means both sales stand.
There is a regression test for this in `src/test/ticketing/capacity-and-shifts.test.ts`.

Related: `TICKET_DAY` and `TICKET_SHIFT` rank **above** `CASHBOOK` in
`core/db/locks.ts`, so the day lock a sale takes composes with the cashbook and
wallet locks `createEntryWithin` takes rather than racing them.

---

## 9. Memberships

A `Membership` is layered on an existing `Contact` of type `CUSTOMER` rather than
carrying its own name and phone, so a member who is also invoiced or receipted is
one customer record with one history.

A `MembershipTier` carries its offer, and creating a tier also creates the
matching `MEMBERSHIP` discount rule — configuring "Gold is 20% off adults" in two
places is how a tier quietly keeps giving the old rate. `maxUsesPerDay` is
counted **across sales** on the business day, not within one basket; without that
one card discounts a coach party one ticket at a time.

A tier with a `price` charges a joining fee, and issuing or renewing that
membership posts its own income entry through `createEntryWithin`. Membership
fees are revenue; leaving them out of the books because they were collected by
the ticketing module rather than the cashbook module would be an accident of code
structure showing up as missing income.

---

## 10. Not built

Named here so nobody assumes otherwise:

- **Offline replay.** A gate loses signal. The client is a PWA and the backend
  has idempotency records, so queuing confirms and replaying them is a contained
  follow-up — but until then, a dead network is a dead desk.
- **Printed stubs.** Serials (`TKT-YYYYMMDD-0001`) are allocated and stored, but
  there is no thermal-printer view.
- **Gate scanning.** Nothing stops one ticket being used twice.
- **Partial refunds.** Only whole-sale voids; refunding one of three tickets
  would need a new flow.
