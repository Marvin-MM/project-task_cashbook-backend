-- Ticketing: staff tags, per-org feature unlocking, and the gate desk.
--
-- The money side is deliberately absent from these tables. Every ticket sale
-- posts one ordinary cashbook entry through EntriesService, which posts the
-- journal, moves the wallet and updates the cached balances exactly as a
-- hand-typed entry does. What lives here is what an entry cannot say: which
-- tiers were sold, at what price, under which offer, by whom, on which night.
--
-- The CHECK constraints at the foot are not decoration. Prisma cannot express
-- them, and each one closes a way the desk could otherwise record something
-- arithmetically impossible.

-- CreateEnum
CREATE TYPE "StaffTag" AS ENUM ('BAR', 'RESTAURANT', 'KITCHEN', 'TICKETING', 'MAINTENANCE', 'SOCIAL_MEDIA', 'SUPERVISOR', 'SECURITY', 'OTHER');

-- CreateEnum
CREATE TYPE "FeatureKey" AS ENUM ('TICKETING');

-- CreateEnum
CREATE TYPE "PatronClass" AS ENUM ('ADULT', 'MINOR', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketDiscountType" AS ENUM ('GUARDIAN_COMP', 'MEMBERSHIP', 'GROUP', 'MANUAL');

-- CreateEnum
CREATE TYPE "DiscountValueType" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "TicketDayStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketSaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('ISSUED', 'VOIDED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SUSPENDED', 'CANCELLED');

-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN     "staff_tag" "StaffTag";

-- CreateTable
CREATE TABLE "workspace_features" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "feature" "FeatureKey" NOT NULL,
    "enabled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabled_by_id" UUID NOT NULL,

    CONSTRAINT "workspace_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_settings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cashbook_id" UUID,
    "revenue_category_id" UUID,
    "default_payment_mode_id" UUID,
    "day_start_minutes" INTEGER NOT NULL DEFAULT 0,
    "allow_self_void" BOOLEAN NOT NULL DEFAULT true,
    "is_configured" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "day_of_week" INTEGER,
    "specific_date" DATE,
    "capacity" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_types" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "patron_class" "PatronClass" NOT NULL DEFAULT 'ADULT',
    "price" DECIMAL(20,4) NOT NULL,
    "category_id" UUID,
    "capacity" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_discount_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "session_id" UUID,
    "name" TEXT NOT NULL,
    "type" "TicketDiscountType" NOT NULL,
    "value_type" "DiscountValueType" NOT NULL,
    "value" DECIMAL(20,4) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "membership_tier_id" UUID,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_discount_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_days" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "TicketDayStatus" NOT NULL DEFAULT 'OPEN',
    "capacity" INTEGER,
    "next_serial" INTEGER NOT NULL DEFAULT 1,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by_id" UUID NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by_id" UUID,
    "closing_notes" TEXT,

    CONSTRAINT "ticket_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_shifts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "ticket_day_id" UUID NOT NULL,
    "attendant_id" UUID NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "opening_float" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "expected_by_mode" JSONB NOT NULL DEFAULT '{}',
    "expected_cash" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "counted_cash" DECIMAL(20,4),
    "variance" DECIMAL(20,4),
    "status" "TicketShiftStatus" NOT NULL DEFAULT 'OPEN',
    "closed_by_id" UUID,
    "notes" TEXT,

    CONSTRAINT "ticket_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_sales" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "ticket_day_id" UUID NOT NULL,
    "shift_id" UUID,
    "entry_id" UUID,
    "account_id" UUID NOT NULL,
    "payment_mode_id" UUID,
    "membership_id" UUID,
    "gross_amount" DECIMAL(20,4) NOT NULL,
    "discount_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(20,4) NOT NULL,
    "ticket_count" INTEGER NOT NULL,
    "status" "TicketSaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "sold_by_id" UUID NOT NULL,
    "sold_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMP(3),
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ticket_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_sale_lines" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "ticket_type_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "line_gross" DECIMAL(20,4) NOT NULL,
    "line_discount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "line_net" DECIMAL(20,4) NOT NULL,

    CONSTRAINT "ticket_sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "ticket_day_id" UUID NOT NULL,
    "ticket_type_id" UUID NOT NULL,
    "serial_no" TEXT NOT NULL,
    "patron_class" "PatronClass" NOT NULL,
    "gross_price" DECIMAL(20,4) NOT NULL,
    "discount_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "net_price" DECIMAL(20,4) NOT NULL,
    "applied_rule_id" UUID,
    "status" "TicketStatus" NOT NULL DEFAULT 'ISSUED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_tiers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discount_value_type" "DiscountValueType" NOT NULL DEFAULT 'PERCENT',
    "discount_value" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "applies_to_ticket_type_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "max_uses_per_day" INTEGER,
    "validity_months" INTEGER,
    "price" DECIMAL(20,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "tier_id" UUID NOT NULL,
    "member_no" TEXT NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "issued_by_id" UUID NOT NULL,
    "entry_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_usages" (
    "id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "ticket_day_id" UUID NOT NULL,
    "ticket_count" INTEGER NOT NULL DEFAULT 1,
    "discount_amount" DECIMAL(20,4) NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_features_workspace_id_idx" ON "workspace_features"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_features_workspace_id_feature_key" ON "workspace_features"("workspace_id", "feature");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_settings_workspace_id_key" ON "ticket_settings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_settings_cashbook_id_key" ON "ticket_settings"("cashbook_id");

-- CreateIndex
CREATE INDEX "ticket_sessions_workspace_id_day_of_week_idx" ON "ticket_sessions"("workspace_id", "day_of_week");

-- CreateIndex
CREATE INDEX "ticket_sessions_workspace_id_specific_date_idx" ON "ticket_sessions"("workspace_id", "specific_date");

-- CreateIndex
CREATE INDEX "ticket_types_workspace_id_idx" ON "ticket_types"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_types_session_id_name_key" ON "ticket_types"("session_id", "name");

-- CreateIndex
CREATE INDEX "ticket_discount_rules_workspace_id_is_active_idx" ON "ticket_discount_rules"("workspace_id", "is_active");

-- CreateIndex
CREATE INDEX "ticket_discount_rules_session_id_idx" ON "ticket_discount_rules"("session_id");

-- CreateIndex
CREATE INDEX "ticket_days_workspace_id_business_date_idx" ON "ticket_days"("workspace_id", "business_date");

-- CreateIndex
CREATE INDEX "ticket_days_workspace_id_status_idx" ON "ticket_days"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_days_workspace_id_business_date_session_id_key" ON "ticket_days"("workspace_id", "business_date", "session_id");

-- CreateIndex
CREATE INDEX "ticket_shifts_workspace_id_status_idx" ON "ticket_shifts"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "ticket_shifts_ticket_day_id_idx" ON "ticket_shifts"("ticket_day_id");

-- CreateIndex
CREATE INDEX "ticket_shifts_attendant_id_idx" ON "ticket_shifts"("attendant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_sales_entry_id_key" ON "ticket_sales"("entry_id");

-- CreateIndex
CREATE INDEX "ticket_sales_workspace_id_sold_at_idx" ON "ticket_sales"("workspace_id", "sold_at");

-- CreateIndex
CREATE INDEX "ticket_sales_ticket_day_id_status_idx" ON "ticket_sales"("ticket_day_id", "status");

-- CreateIndex
CREATE INDEX "ticket_sales_sold_by_id_idx" ON "ticket_sales"("sold_by_id");

-- CreateIndex
CREATE INDEX "ticket_sales_shift_id_idx" ON "ticket_sales"("shift_id");

-- CreateIndex
CREATE INDEX "ticket_sale_lines_sale_id_idx" ON "ticket_sale_lines"("sale_id");

-- CreateIndex
CREATE INDEX "tickets_ticket_day_id_status_idx" ON "tickets"("ticket_day_id", "status");

-- CreateIndex
CREATE INDEX "tickets_sale_id_idx" ON "tickets"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_workspace_id_serial_no_key" ON "tickets"("workspace_id", "serial_no");

-- CreateIndex
CREATE INDEX "membership_tiers_workspace_id_is_active_idx" ON "membership_tiers"("workspace_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "membership_tiers_workspace_id_name_key" ON "membership_tiers"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_entry_id_key" ON "memberships"("entry_id");

-- CreateIndex
CREATE INDEX "memberships_workspace_id_status_idx" ON "memberships"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "memberships_contact_id_idx" ON "memberships"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspace_id_member_no_key" ON "memberships"("workspace_id", "member_no");

-- CreateIndex
CREATE INDEX "membership_usages_membership_id_ticket_day_id_idx" ON "membership_usages"("membership_id", "ticket_day_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_usages_sale_id_membership_id_key" ON "membership_usages"("sale_id", "membership_id");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_staff_tag_idx" ON "workspace_members"("workspace_id", "staff_tag");

-- AddForeignKey
ALTER TABLE "workspace_features" ADD CONSTRAINT "workspace_features_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_features" ADD CONSTRAINT "workspace_features_enabled_by_id_fkey" FOREIGN KEY ("enabled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_settings" ADD CONSTRAINT "ticket_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_settings" ADD CONSTRAINT "ticket_settings_cashbook_id_fkey" FOREIGN KEY ("cashbook_id") REFERENCES "cashbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_settings" ADD CONSTRAINT "ticket_settings_revenue_category_id_fkey" FOREIGN KEY ("revenue_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_settings" ADD CONSTRAINT "ticket_settings_default_payment_mode_id_fkey" FOREIGN KEY ("default_payment_mode_id") REFERENCES "payment_modes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sessions" ADD CONSTRAINT "ticket_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ticket_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_discount_rules" ADD CONSTRAINT "ticket_discount_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_discount_rules" ADD CONSTRAINT "ticket_discount_rules_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ticket_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_discount_rules" ADD CONSTRAINT "ticket_discount_rules_membership_tier_id_fkey" FOREIGN KEY ("membership_tier_id") REFERENCES "membership_tiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_days" ADD CONSTRAINT "ticket_days_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_days" ADD CONSTRAINT "ticket_days_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ticket_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_days" ADD CONSTRAINT "ticket_days_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_days" ADD CONSTRAINT "ticket_days_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_shifts" ADD CONSTRAINT "ticket_shifts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_shifts" ADD CONSTRAINT "ticket_shifts_ticket_day_id_fkey" FOREIGN KEY ("ticket_day_id") REFERENCES "ticket_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_shifts" ADD CONSTRAINT "ticket_shifts_attendant_id_fkey" FOREIGN KEY ("attendant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_shifts" ADD CONSTRAINT "ticket_shifts_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_ticket_day_id_fkey" FOREIGN KEY ("ticket_day_id") REFERENCES "ticket_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "ticket_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_payment_mode_id_fkey" FOREIGN KEY ("payment_mode_id") REFERENCES "payment_modes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_sold_by_id_fkey" FOREIGN KEY ("sold_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sales" ADD CONSTRAINT "ticket_sales_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sale_lines" ADD CONSTRAINT "ticket_sale_lines_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "ticket_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sale_lines" ADD CONSTRAINT "ticket_sale_lines_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "ticket_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_day_id_fkey" FOREIGN KEY ("ticket_day_id") REFERENCES "ticket_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_applied_rule_id_fkey" FOREIGN KEY ("applied_rule_id") REFERENCES "ticket_discount_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "membership_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_usages" ADD CONSTRAINT "membership_usages_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_usages" ADD CONSTRAINT "membership_usages_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "ticket_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_usages" ADD CONSTRAINT "membership_usages_ticket_day_id_fkey" FOREIGN KEY ("ticket_day_id") REFERENCES "ticket_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Constraints Prisma cannot express ────────────────────────────────

-- A session is either a weekly pattern or a one-off date, never both and never
-- neither. Without this, a row with both set would match twice on the day the
-- two coincide and the desk would not know which price is running.
ALTER TABLE "ticket_sessions"
  ADD CONSTRAINT "ticket_sessions_day_xor_date"
  CHECK (num_nonnulls("day_of_week", "specific_date") = 1);

ALTER TABLE "ticket_sessions"
  ADD CONSTRAINT "ticket_sessions_day_of_week_range"
  CHECK ("day_of_week" IS NULL OR ("day_of_week" BETWEEN 0 AND 6));

-- One weekly session per weekday, and one override per date. Partial, because
-- an archived session must not block its replacement.
CREATE UNIQUE INDEX "ticket_sessions_active_weekday_key"
  ON "ticket_sessions" ("workspace_id", "day_of_week")
  WHERE "is_active" AND "day_of_week" IS NOT NULL;

CREATE UNIQUE INDEX "ticket_sessions_active_date_key"
  ON "ticket_sessions" ("workspace_id", "specific_date")
  WHERE "is_active" AND "specific_date" IS NOT NULL;

-- The business-day cutover is a wall-clock time, so it lives inside one day.
ALTER TABLE "ticket_settings"
  ADD CONSTRAINT "ticket_settings_day_start_range"
  CHECK ("day_start_minutes" BETWEEN 0 AND 1439);

-- Serials are handed out from here under the day's row lock; it only ever counts up.
ALTER TABLE "ticket_days"
  ADD CONSTRAINT "ticket_days_next_serial_positive"
  CHECK ("next_serial" >= 1);

-- An attendant runs at most one open drawer at a time. Two would make
-- "expected cash for this shift" meaningless.
CREATE UNIQUE INDEX "ticket_shifts_one_open_per_attendant"
  ON "ticket_shifts" ("ticket_day_id", "attendant_id")
  WHERE "status" = 'OPEN';

-- Sale arithmetic. net = gross - discount, and nothing is negative. A sale that
-- violated this would post an entry for an amount its own lines do not justify.
ALTER TABLE "ticket_sales"
  ADD CONSTRAINT "ticket_sales_amounts_nonneg"
  CHECK ("gross_amount" >= 0 AND "discount_amount" >= 0 AND "net_amount" >= 0);

ALTER TABLE "ticket_sales"
  ADD CONSTRAINT "ticket_sales_net_balances"
  CHECK ("net_amount" = "gross_amount" - "discount_amount");

ALTER TABLE "ticket_sales"
  ADD CONSTRAINT "ticket_sales_ticket_count_positive"
  CHECK ("ticket_count" >= 1);

-- A voided sale must say when and why; a completed one must claim neither.
ALTER TABLE "ticket_sales"
  ADD CONSTRAINT "ticket_sales_void_fields_consistent"
  CHECK (
    ("status" = 'VOIDED'    AND "voided_at" IS NOT NULL AND "void_reason" IS NOT NULL)
    OR
    ("status" = 'COMPLETED' AND "voided_at" IS NULL     AND "void_reason" IS NULL)
  );

ALTER TABLE "ticket_sale_lines"
  ADD CONSTRAINT "ticket_sale_lines_quantity_positive"
  CHECK ("quantity" >= 1);

ALTER TABLE "ticket_sale_lines"
  ADD CONSTRAINT "ticket_sale_lines_amounts_consistent"
  CHECK (
    "unit_price" >= 0 AND "line_gross" >= 0 AND "line_discount" >= 0 AND "line_net" >= 0
    AND "line_net" = "line_gross" - "line_discount"
  );

-- Per-head arithmetic, including the comped head: gross 20000, discount 20000,
-- net 0 is legal; net 0 with discount 0 and gross 20000 is not.
ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_amounts_consistent"
  CHECK (
    "gross_price" >= 0 AND "discount_amount" >= 0 AND "net_price" >= 0
    AND "net_price" = "gross_price" - "discount_amount"
  );

-- Percent offers are a percentage.
ALTER TABLE "ticket_discount_rules"
  ADD CONSTRAINT "ticket_discount_rules_value_range"
  CHECK (
    "value" >= 0
    AND ("value_type" <> 'PERCENT' OR "value" <= 100)
  );

ALTER TABLE "membership_tiers"
  ADD CONSTRAINT "membership_tiers_discount_range"
  CHECK (
    "discount_value" >= 0
    AND ("discount_value_type" <> 'PERCENT' OR "discount_value" <= 100)
  );

ALTER TABLE "membership_tiers"
  ADD CONSTRAINT "membership_tiers_limits_positive"
  CHECK (
    ("max_uses_per_day" IS NULL OR "max_uses_per_day" >= 1)
    AND ("validity_months" IS NULL OR "validity_months" >= 1)
    AND ("price" IS NULL OR "price" >= 0)
  );

-- A membership that expires must expire after it starts.
ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_validity_ordered"
  CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from");

-- Capacities, where set, admit somebody.
ALTER TABLE "ticket_sessions"
  ADD CONSTRAINT "ticket_sessions_capacity_positive"
  CHECK ("capacity" IS NULL OR "capacity" >= 1);

ALTER TABLE "ticket_types"
  ADD CONSTRAINT "ticket_types_capacity_positive"
  CHECK ("capacity" IS NULL OR "capacity" >= 1);

ALTER TABLE "ticket_types"
  ADD CONSTRAINT "ticket_types_price_nonneg"
  CHECK ("price" >= 0);
