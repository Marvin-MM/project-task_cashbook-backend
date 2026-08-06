-- Interest on receivables and payables.
--
-- The case this exists for: lending. Hand someone 100,000 at 10% and you are
-- owed 110,000 — but only the 10,000 is profit, and the 100,000 is capital you
-- are waiting to get back. Storing one blended `total_amount` cannot tell those
-- apart, so it cannot answer "how much have I actually made" or "how much of my
-- money is still at risk".
--
-- Splitting it costs nothing downstream: `total_amount` stays the single figure
-- every settlement, overpayment guard, status transition and journal already
-- works from. Principal and interest are additional facts about how that figure
-- was arrived at, not a new way of settling it.
--
-- Interest is FLAT and fixed at creation, deliberately. A per-annum rate that
-- accrues would mean the amount owed changes with no one touching it, which in
-- turn means re-posting the obligation's journal on a schedule — a much larger
-- machine, and one that can silently disagree with the ledger between runs.

-- ─── Columns ──────────────────────────────────────────────────────────

-- Nullable first so existing rows can be backfilled before the NOT NULL lands.
ALTER TABLE "cashbook_obligations"
  ADD COLUMN "principal_amount" DECIMAL(20,4);

ALTER TABLE "cashbook_obligations"
  ADD COLUMN "interest_amount" DECIMAL(20,4) NOT NULL DEFAULT 0;

-- Nullable for good: an obligation whose interest was typed as a flat figure
-- rather than a percentage has no rate, and inventing one would be a lie.
ALTER TABLE "cashbook_obligations"
  ADD COLUMN "interest_rate" DECIMAL(9,4);

-- Every obligation that existed before interest did is, by definition, all
-- principal and no interest.
UPDATE "cashbook_obligations"
  SET "principal_amount" = "total_amount"
  WHERE "principal_amount" IS NULL;

ALTER TABLE "cashbook_obligations"
  ALTER COLUMN "principal_amount" SET NOT NULL;

-- ─── Invariants ───────────────────────────────────────────────────────

-- The split must reconcile to the total. Without this, principal and interest
-- become decorative: reporting would show a profit the balance owed does not
-- support, and nothing would catch it.
ALTER TABLE "cashbook_obligations"
  ADD CONSTRAINT "obligations_total_is_principal_plus_interest"
  CHECK ("total_amount" = "principal_amount" + "interest_amount");

ALTER TABLE "cashbook_obligations"
  ADD CONSTRAINT "obligations_amounts_nonneg"
  CHECK ("principal_amount" >= 0 AND "interest_amount" >= 0);

-- A rate, where one was given, is a percentage.
ALTER TABLE "cashbook_obligations"
  ADD CONSTRAINT "obligations_interest_rate_range"
  CHECK ("interest_rate" IS NULL OR ("interest_rate" >= 0 AND "interest_rate" <= 1000));
