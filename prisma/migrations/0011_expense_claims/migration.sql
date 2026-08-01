-- Expense claims, and attachments that can belong to something other than a
-- cashbook.
--
-- Approving a claim posts to the ledger, so the interesting constraints here
-- are the ones that make double-posting impossible: entry_id and obligation_id
-- are both UNIQUE, and exactly one of them may be set.

-- ─── 1. Enums ───────────────────────────────────────────

CREATE TYPE "ExpensePaymentSource" AS ENUM ('OWN_MONEY', 'ORG_WALLET');

ALTER TYPE "ContactType" ADD VALUE IF NOT EXISTS 'STAFF';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'EXPENSE_CLAIM_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'EXPENSE_CLAIM_DECIDED';
ALTER TYPE "NotificationEntityType" ADD VALUE IF NOT EXISTS 'EXPENSE_CLAIM';

-- ─── 2. Staff contacts ──────────────────────────────────

-- Accounts payable is tracked against a Contact, and a User is not one. Linking
-- them means a reimbursement finds the same counterparty every time rather than
-- creating a fresh "Jane Doe" per claim.
ALTER TABLE "contacts" ADD COLUMN "user_id" UUID;

CREATE UNIQUE INDEX "contacts_workspace_id_user_id_key"
  ON "contacts" ("workspace_id", "user_id");

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. Expense claims ──────────────────────────────────

CREATE TABLE "task_expense_claims" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID,
    "project_id" UUID,
    "claimant_id" UUID NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "incurred_on" DATE NOT NULL,
    "payment_source" "ExpensePaymentSource" NOT NULL,
    "account_id" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewer_id" UUID,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "cashbook_id" UUID,
    "entry_id" UUID,
    "obligation_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_expense_claims_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_expense_claims_workspace_id_status_idx"
  ON "task_expense_claims" ("workspace_id", "status");
CREATE INDEX "task_expense_claims_claimant_id_idx" ON "task_expense_claims" ("claimant_id");
CREATE INDEX "task_expense_claims_task_id_idx" ON "task_expense_claims" ("task_id");

-- The database backstop against a claim posting twice. Even if the
-- compare-and-swap in the service were bypassed, a second entry or obligation
-- cannot be attached to the same claim.
CREATE UNIQUE INDEX "task_expense_claims_entry_id_key"
  ON "task_expense_claims" ("entry_id");
CREATE UNIQUE INDEX "task_expense_claims_obligation_id_key"
  ON "task_expense_claims" ("obligation_id");

ALTER TABLE "task_expense_claims"
  -- Money out of a wallet has to say which wallet.
  ADD CONSTRAINT "task_expense_claims_wallet_requires_account"
    CHECK ("payment_source" <> 'ORG_WALLET' OR "account_id" IS NOT NULL),
  ADD CONSTRAINT "task_expense_claims_amount_positive"
    CHECK ("amount" > 0),
  ADD CONSTRAINT "task_expense_claims_decided_consistently"
    CHECK (("status" IN ('APPROVED', 'REJECTED')) = ("reviewed_at" IS NOT NULL)),
  -- A claim posts one document, never both: an org-wallet expense is an entry,
  -- an out-of-pocket one is a payable.
  ADD CONSTRAINT "task_expense_claims_one_posting"
    CHECK (num_nonnulls("entry_id", "obligation_id") <= 1),
  -- Approved means posted, and posted means a book was chosen.
  ADD CONSTRAINT "task_expense_claims_approved_is_posted"
    CHECK ("status" <> 'APPROVED'
           OR (num_nonnulls("entry_id", "obligation_id") = 1 AND "cashbook_id" IS NOT NULL));

ALTER TABLE "task_expense_claims"
  ADD CONSTRAINT "task_expense_claims_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_expense_claims_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "task_expense_claims_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "task_expense_claims_claimant_id_fkey"
    FOREIGN KEY ("claimant_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_expense_claims_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- Restrict, not Cascade: deleting a wallet, book, entry or obligation that a
  -- claim points at must be an explicit decision, not a silent cascade through
  -- the audit trail of a money movement.
  ADD CONSTRAINT "task_expense_claims_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "task_expense_claims_cashbook_id_fkey"
    FOREIGN KEY ("cashbook_id") REFERENCES "cashbooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "task_expense_claims_entry_id_fkey"
    FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "task_expense_claims_obligation_id_fkey"
    FOREIGN KEY ("obligation_id") REFERENCES "cashbook_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 4. Polymorphic attachments ─────────────────────────

-- cashbook_id was NOT NULL, which is why nothing outside a cashbook could carry
-- a file. Widening is safe: every existing row has one.
ALTER TABLE "attachments"
  ALTER COLUMN "cashbook_id" DROP NOT NULL,
  ADD COLUMN "task_id" UUID,
  ADD COLUMN "task_report_id" UUID,
  ADD COLUMN "expense_claim_id" UUID;

CREATE INDEX "attachments_task_id_idx" ON "attachments" ("task_id");
CREATE INDEX "attachments_task_report_id_idx" ON "attachments" ("task_report_id");
CREATE INDEX "attachments_expense_claim_id_idx" ON "attachments" ("expense_claim_id");

-- Exactly one owner. Without this the nullable columns are a convention, and a
-- file with no owner is unreachable while a file with two is ambiguous to
-- authorize.
ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_exactly_one_owner"
    CHECK (num_nonnulls("cashbook_id", "task_id", "task_report_id", "expense_claim_id") = 1);

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attachments_task_report_id_fkey"
    FOREIGN KEY ("task_report_id") REFERENCES "task_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attachments_expense_claim_id_fkey"
    FOREIGN KEY ("expense_claim_id") REFERENCES "task_expense_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
