-- expected_by_mode is a list (ShiftWalletCount[]) once a shift closes and
-- computes its breakdown. It defaulted to the JSON object '{}', which is not
-- an array and is not iterable — the client iterates this column with
-- `for...of` and `.map()` for every OPEN shift (which has no breakdown yet
-- and so still carries the default), and crashed on it.
--
-- Two parts: change the column default going forward, and backfill any
-- existing rows that still carry the old object default so the fix does not
-- depend on a shift having been created after this migration ran.

ALTER TABLE "ticket_shifts"
  ALTER COLUMN "expected_by_mode" SET DEFAULT '[]'::jsonb;

UPDATE "ticket_shifts"
  SET "expected_by_mode" = '[]'::jsonb
  WHERE "expected_by_mode" = '{}'::jsonb;
