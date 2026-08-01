-- CreateEnum
CREATE TYPE "LedgerAccountClass" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerAccountOrigin" AS ENUM ('SYSTEM', 'WALLET', 'BOOK_CASH', 'USER');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('POSTED', 'REVERSED', 'REVERSING');

-- CreateEnum
CREATE TYPE "JournalSourceType" AS ENUM ('CASHBOOK_ENTRY', 'ACCOUNT_TRANSACTION', 'ACCOUNT_TRANSFER', 'ACCOUNT_OPENING', 'OBLIGATION', 'INVENTORY', 'MANUAL');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "RevenueBasis" AS ENUM ('CASH', 'ACCRUAL');

-- CreateEnum
CREATE TYPE "InventoryValuationMode" AS ENUM ('OFF', 'PERPETUAL');

-- CreateEnum
CREATE TYPE "FiscalPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "ledger_account_id" UUID;

-- AlterTable
ALTER TABLE "cashbook_obligations" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "cashbooks" ADD COLUMN     "cash_ledger_account_id" UUID;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "gl_account_id" UUID;

-- AlterTable
ALTER TABLE "entries" ADD COLUMN     "reversal_reason" TEXT,
ADD COLUMN     "reversed_at" TIMESTAMP(3),
ADD COLUMN     "reversed_by_id" UUID,
ADD COLUMN     "status" "EntryStatus" NOT NULL DEFAULT 'POSTED';

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "inventory_valuation" "InventoryValuationMode" NOT NULL DEFAULT 'OFF',
ADD COLUMN     "revenue_basis" "RevenueBasis" NOT NULL DEFAULT 'CASH';

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "class" "LedgerAccountClass" NOT NULL,
    "normal_balance" "NormalBalance" NOT NULL,
    "origin" "LedgerAccountOrigin" NOT NULL DEFAULT 'USER',
    "system_key" TEXT,
    "parent_id" UUID,
    "currency" TEXT NOT NULL,
    "is_cash_equivalent" BOOLEAN NOT NULL DEFAULT false,
    "is_postable" BOOLEAN NOT NULL DEFAULT true,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cashbook_id" UUID,
    "entry_date" DATE NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "JournalStatus" NOT NULL DEFAULT 'POSTED',
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source_type" "JournalSourceType" NOT NULL,
    "source_id" UUID,
    "posting_key" TEXT NOT NULL,
    "total_debit" DECIMAL(20,4) NOT NULL,
    "total_credit" DECIMAL(20,4) NOT NULL,
    "reverses_journal_entry_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cashbook_id" UUID,
    "entry_date" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "debit" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "memo" TEXT,
    "contact_id" UUID,
    "category_id" UUID,
    "obligation_id" UUID,
    "inventory_item_id" UUID,
    "entry_id" UUID,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "FiscalPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closed_by_id" UUID,
    "closed_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_accounts_workspace_id_class_idx" ON "ledger_accounts"("workspace_id", "class");

-- CreateIndex
CREATE INDEX "ledger_accounts_parent_id_idx" ON "ledger_accounts"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_workspace_id_code_key" ON "ledger_accounts"("workspace_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_workspace_id_system_key_key" ON "ledger_accounts"("workspace_id", "system_key");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reverses_journal_entry_id_key" ON "journal_entries"("reverses_journal_entry_id");

-- CreateIndex
CREATE INDEX "journal_entries_workspace_id_entry_date_idx" ON "journal_entries"("workspace_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_entries_cashbook_id_entry_date_idx" ON "journal_entries"("cashbook_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_entries_source_type_source_id_idx" ON "journal_entries"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "journal_entries_workspace_id_status_idx" ON "journal_entries"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_workspace_id_posting_key_key" ON "journal_entries"("workspace_id", "posting_key");

-- CreateIndex
CREATE INDEX "journal_lines_workspace_id_ledger_account_id_entry_date_idx" ON "journal_lines"("workspace_id", "ledger_account_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_lines_workspace_id_cashbook_id_entry_date_idx" ON "journal_lines"("workspace_id", "cashbook_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_lines_ledger_account_id_obligation_id_idx" ON "journal_lines"("ledger_account_id", "obligation_id");

-- CreateIndex
CREATE INDEX "journal_lines_workspace_id_contact_id_entry_date_idx" ON "journal_lines"("workspace_id", "contact_id", "entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_journal_entry_id_line_number_key" ON "journal_lines"("journal_entry_id", "line_number");

-- CreateIndex
CREATE INDEX "fiscal_periods_workspace_id_status_idx" ON "fiscal_periods"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "fiscal_periods_workspace_id_start_date_end_date_idx" ON "fiscal_periods"("workspace_id", "start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_workspace_id_start_date_key" ON "fiscal_periods"("workspace_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_ledger_account_id_key" ON "accounts"("ledger_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "cashbooks_cash_ledger_account_id_key" ON "cashbooks"("cash_ledger_account_id");

-- CreateIndex
CREATE INDEX "entries_cashbook_id_status_entry_date_idx" ON "entries"("cashbook_id", "status", "entry_date");

-- AddForeignKey
ALTER TABLE "cashbooks" ADD CONSTRAINT "cashbooks_cash_ledger_account_id_fkey" FOREIGN KEY ("cash_ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_cashbook_id_fkey" FOREIGN KEY ("cashbook_id") REFERENCES "cashbooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_journal_entry_id_fkey" FOREIGN KEY ("reverses_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════
-- Ledger invariants that cannot be expressed in schema.prisma.
--
-- These are the backstop: no code path — application, seed script, repair
-- tool, or psql session — can write an unbalanced or mutated ledger.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── Row-level sanity ────────────────────────────────────────────────
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "jl_nonneg"   CHECK ("debit" >= 0 AND "credit" >= 0),
  ADD CONSTRAINT "jl_one_side" CHECK (NOT ("debit" > 0 AND "credit" > 0)),
  ADD CONSTRAINT "jl_nonzero"  CHECK ("debit" + "credit" > 0);

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "je_balanced" CHECK ("total_debit" = "total_credit"),
  ADD CONSTRAINT "je_reversal_consistent" CHECK (
    ("status" = 'REVERSING') = ("reverses_journal_entry_id" IS NOT NULL)
  );

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

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- ─── The ledger is append-only ───────────────────────────────────────
-- Corrections are made by posting a reversing journal, never by editing or
-- deleting history. The GUC escape hatch exists for the test harness's
-- TRUNCATE and for a future documented repair tool.
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

CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- ─── A line's currency must match its ledger account ─────────────────
-- No FX exists in this product; a mismatched line would silently corrupt
-- every per-currency report.
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

CREATE TRIGGER journal_lines_currency_matches
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION assert_line_currency_matches();

-- ─── Only postable accounts may carry lines ──────────────────────────
-- Roll-up parents exist for presentation; posting to one would make the
-- balance sheet double-count.
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

CREATE TRIGGER journal_lines_account_postable
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION assert_account_postable();
