-- ═══════════════════════════════════════════════════════════════════════
-- Re-assert every ledger integrity object from 0004, idempotently.
--
-- WHY THIS EXISTS
--
-- A database built with `prisma db push` has the ledger TABLES but none of
-- this. `db push` diffs schema.prisma against the database and applies DDL;
-- it never executes a migration file. Triggers, functions and CHECK
-- constraints are not expressible in schema.prisma, so a pushed database
-- silently lacks:
--
--   * journal_lines_balanced      — debits must equal credits, per journal
--   * journal_lines_append_only   — history is never edited, only reversed
--   * journal_lines_currency_matches
--   * journal_lines_account_postable
--   * jl_nonneg / jl_one_side / jl_nonzero / je_balanced /
--     je_reversal_consistent
--
-- Baselining such a database — marking 0004 as applied so `migrate deploy`
-- can proceed — would make that omission permanent, because 0004 would never
-- run again. This migration closes that hole.
--
-- On a database that WAS migrated properly, every statement below is a no-op:
-- the functions are CREATE OR REPLACE with identical bodies, the triggers are
-- dropped and recreated identically, and the constraints are skipped because
-- they already exist. So it is safe to run everywhere, and dev, CI and
-- production converge on the same guarantees.
--
-- If adding a CHECK fails here, the migration rolls back and the data really
-- does violate it. Run `npm run preflight:baseline` first: it reports the same
-- violations read-only, before a deploy is in flight.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── Row-level sanity ────────────────────────────────────────────────
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the catalogue check.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('journal_lines',   'jl_nonneg',              '("debit" >= 0 AND "credit" >= 0)'),
      ('journal_lines',   'jl_one_side',            '(NOT ("debit" > 0 AND "credit" > 0))'),
      ('journal_lines',   'jl_nonzero',             '("debit" + "credit" > 0)'),
      ('journal_entries', 'je_balanced',            '("total_debit" = "total_credit")'),
      ('journal_entries', 'je_reversal_consistent',
       '(("status" = ''REVERSING'') = ("reverses_journal_entry_id" IS NOT NULL))')
    ) AS t(tbl, name, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = spec.name
        AND conrelid = format('%I', spec.tbl)::regclass
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK %s',
                     spec.tbl, spec.name, spec.expr);
      RAISE NOTICE 'Added missing constraint %.%', spec.tbl, spec.name;
    END IF;
  END LOOP;
END $$;

-- ─── Debits must equal credits, per journal ──────────────────────────
-- DEFERRABLE INITIALLY DEFERRED so the header and its lines can be inserted
-- incrementally within one transaction; the check runs at COMMIT.
CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE
  v_id uuid;
  d numeric(20,4);
  c numeric(20,4);
  je record;
BEGIN
  v_id := COALESCE(NEW."journal_entry_id", OLD."journal_entry_id");

  SELECT * INTO je FROM "journal_entries" WHERE "id" = v_id;
  IF NOT FOUND THEN
    -- Header removed in the same transaction; nothing to validate.
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
    INTO d, c
    FROM "journal_lines"
   WHERE "journal_entry_id" = v_id;

  IF d <> c OR d <> je."total_debit" OR c <> je."total_credit" THEN
    RAISE EXCEPTION
      'Journal % is unbalanced: lines debit=% credit=%, header debit=% credit=%',
      v_id, d, c, je."total_debit", je."total_credit"
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_balanced ON "journal_lines";
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- ─── The ledger is append-only ───────────────────────────────────────
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION
    'journal_lines is append-only; post a reversing journal instead of % ing it', TG_OP
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_append_only ON "journal_lines";
CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- ─── A line's currency must match its ledger account ─────────────────
CREATE OR REPLACE FUNCTION assert_line_currency_matches() RETURNS trigger AS $$
DECLARE
  la_currency text;
BEGIN
  SELECT "currency" INTO la_currency
    FROM "ledger_accounts" WHERE "id" = NEW."ledger_account_id";

  IF la_currency IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION
      'Journal line currency % does not match ledger account currency %',
      NEW."currency", la_currency
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_currency_matches ON "journal_lines";
CREATE TRIGGER journal_lines_currency_matches
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION assert_line_currency_matches();

-- ─── Only postable accounts may carry lines ──────────────────────────
CREATE OR REPLACE FUNCTION assert_account_postable() RETURNS trigger AS $$
DECLARE
  postable boolean;
BEGIN
  SELECT "is_postable" INTO postable
    FROM "ledger_accounts" WHERE "id" = NEW."ledger_account_id";

  IF NOT postable THEN
    RAISE EXCEPTION 'Ledger account % is a roll-up parent and cannot be posted to',
      NEW."ledger_account_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_account_postable ON "journal_lines";
CREATE TRIGGER journal_lines_account_postable
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION assert_account_postable();
