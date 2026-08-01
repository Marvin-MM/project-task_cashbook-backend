-- People operations: leave, overtime, attendance flags and work reports.
--
-- The load-bearing constraint here is leave_days' unique on
-- (workspace, user, date). Materialising approved leave one row per day turns
-- "is this person expected today" from half-day range arithmetic into an
-- indexed join, AND makes double-booking impossible even when two approvals
-- land at the same instant — which an overlap check in a service cannot do.

-- ─── 1. Enums ───────────────────────────────────────────

CREATE TYPE "LeaveDayPortion" AS ENUM ('FULL', 'FIRST_HALF', 'SECOND_HALF');
CREATE TYPE "AttendanceFlagType" AS ENUM
  ('LATE_IN', 'EARLY_OUT', 'MISSED_CLOCK_OUT', 'ABSENT', 'OUT_OF_GEOFENCE');
CREATE TYPE "AttendanceFlagStatus" AS ENUM ('ACTIVE', 'WAIVED');
CREATE TYPE "OvertimeRequestType" AS ENUM ('PLANNED', 'RETROACTIVE');
CREATE TYPE "WorkReportPeriod" AS ENUM ('DAILY', 'MONTHLY');

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LEAVE_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LEAVE_DECIDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'OVERTIME_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'OVERTIME_DECIDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WORK_REPORT_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WORK_REPORT_DECIDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTENDANCE_WRAP_UP';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SESSION_AUTO_CLOSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTENDANCE_FLAG_RAISED';

ALTER TYPE "NotificationEntityType" ADD VALUE IF NOT EXISTS 'LEAVE_REQUEST';
ALTER TYPE "NotificationEntityType" ADD VALUE IF NOT EXISTS 'OVERTIME_REQUEST';
ALTER TYPE "NotificationEntityType" ADD VALUE IF NOT EXISTS 'WORK_REPORT';
ALTER TYPE "NotificationEntityType" ADD VALUE IF NOT EXISTS 'WORK_SESSION';
ALTER TYPE "NotificationEntityType" ADD VALUE IF NOT EXISTS 'ATTENDANCE_FLAG';

-- ─── 2. Leave types ─────────────────────────────────────

CREATE TABLE "leave_types" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "allow_half_day" BOOLEAN NOT NULL DEFAULT true,
    "max_days_per_year" INTEGER,
    "color_hex" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_types_workspace_id_code_key" ON "leave_types" ("workspace_id", "code");
CREATE UNIQUE INDEX "leave_types_workspace_id_name_key" ON "leave_types" ("workspace_id", "name");

ALTER TABLE "leave_types"
  ADD CONSTRAINT "leave_types_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every workspace starts with the usual set, so nobody has to configure leave
-- before they can request it.
INSERT INTO "leave_types" ("id", "workspace_id", "name", "code", "is_paid", "sort_order")
SELECT gen_random_uuid(), w.id, t.name, t.code, t.is_paid, t.sort_order
FROM "workspaces" w
CROSS JOIN (VALUES
    ('Annual leave',       'ANNUAL',       true,  1),
    ('Sick leave',         'SICK',         true,  2),
    ('Unpaid leave',       'UNPAID',       false, 3),
    ('Maternity leave',    'MATERNITY',    true,  4),
    ('Paternity leave',    'PATERNITY',    true,  5),
    ('Compassionate leave','COMPASSIONATE',true,  6)
) AS t(name, code, is_paid, sort_order);

-- ─── 3. Leave requests and days ─────────────────────────

CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "start_portion" "LeaveDayPortion" NOT NULL DEFAULT 'FULL',
    "end_portion" "LeaveDayPortion" NOT NULL DEFAULT 'FULL',
    "total_days" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewer_id" UUID,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leave_requests_workspace_id_status_idx" ON "leave_requests" ("workspace_id", "status");
CREATE INDEX "leave_requests_workspace_id_user_id_start_date_idx"
  ON "leave_requests" ("workspace_id", "user_id", "start_date");

ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_range_valid" CHECK ("end_date" >= "start_date"),
  ADD CONSTRAINT "leave_requests_days_positive" CHECK ("total_days" > 0),
  ADD CONSTRAINT "leave_requests_decided_consistently"
    CHECK (("status" IN ('APPROVED','REJECTED')) = ("reviewed_at" IS NOT NULL)),
  ADD CONSTRAINT "leave_requests_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_requests_leave_type_id_fkey"
    FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_requests_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "leave_days" (
    "id" UUID NOT NULL,
    "leave_request_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "portion" "LeaveDayPortion" NOT NULL DEFAULT 'FULL',

    CONSTRAINT "leave_days_pkey" PRIMARY KEY ("id")
);

-- THE double-booking backstop. One approved day off per person per date,
-- whatever two concurrent approvals try to do.
CREATE UNIQUE INDEX "leave_days_workspace_id_user_id_date_key"
  ON "leave_days" ("workspace_id", "user_id", "date");
CREATE INDEX "leave_days_workspace_id_date_idx" ON "leave_days" ("workspace_id", "date");

ALTER TABLE "leave_days"
  ADD CONSTRAINT "leave_days_leave_request_id_fkey"
    FOREIGN KEY ("leave_request_id") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 4. Overtime requests ───────────────────────────────

CREATE TABLE "overtime_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "type" "OvertimeRequestType" NOT NULL DEFAULT 'PLANNED',
    "requested_minutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approved_minutes" INTEGER,
    "reviewer_id" UUID,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overtime_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "overtime_requests_workspace_id_status_idx"
  ON "overtime_requests" ("workspace_id", "status");
CREATE INDEX "overtime_requests_workspace_id_user_id_business_date_idx"
  ON "overtime_requests" ("workspace_id", "user_id", "business_date");

-- One live request per person per day; decided ones are history.
CREATE UNIQUE INDEX "overtime_requests_one_pending"
  ON "overtime_requests" ("workspace_id", "user_id", "business_date")
  WHERE "status" = 'PENDING';

ALTER TABLE "overtime_requests"
  ADD CONSTRAINT "overtime_requests_minutes_positive" CHECK ("requested_minutes" > 0),
  -- An approver may grant part of a request, never more than was asked for.
  ADD CONSTRAINT "overtime_requests_approved_within_requested"
    CHECK ("approved_minutes" IS NULL OR "approved_minutes" <= "requested_minutes"),
  ADD CONSTRAINT "overtime_requests_decided_consistently"
    CHECK (("status" IN ('APPROVED','REJECTED')) = ("reviewed_at" IS NOT NULL)),
  ADD CONSTRAINT "overtime_requests_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "overtime_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "overtime_requests_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 5. Attendance flags ────────────────────────────────

CREATE TABLE "attendance_flags" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "type" "AttendanceFlagType" NOT NULL,
    "minutes" INTEGER,
    "session_id" UUID,
    "status" "AttendanceFlagStatus" NOT NULL DEFAULT 'ACTIVE',
    "detail" JSONB,
    "waived_by_id" UUID,
    "waived_at" TIMESTAMP(3),
    "waiver_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_flags_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attendance_flags_workspace_id_business_date_status_idx"
  ON "attendance_flags" ("workspace_id", "business_date", "status");
CREATE INDEX "attendance_flags_workspace_id_user_id_business_date_idx"
  ON "attendance_flags" ("workspace_id", "user_id", "business_date");

-- Idempotency, split by scope: a day-level flag (ABSENT, LATE_IN) happens once
-- per day, while a session-level one can happen twice if somebody worked two
-- shifts and forgot to clock out of both.
CREATE UNIQUE INDEX "attendance_flags_day_scoped"
  ON "attendance_flags" ("workspace_id", "user_id", "business_date", "type")
  WHERE "session_id" IS NULL;
CREATE UNIQUE INDEX "attendance_flags_session_scoped"
  ON "attendance_flags" ("session_id", "type") WHERE "session_id" IS NOT NULL;

ALTER TABLE "attendance_flags"
  -- A waiver is a decision on the record: both the who and the why, or neither.
  ADD CONSTRAINT "attendance_flags_waived_consistently"
    CHECK (("status" = 'WAIVED') = ("waived_at" IS NOT NULL AND "waiver_reason" IS NOT NULL)),
  ADD CONSTRAINT "attendance_flags_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_flags_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_flags_waived_by_id_fkey"
    FOREIGN KEY ("waived_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 6. Work reports ────────────────────────────────────

CREATE TABLE "work_reports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "period" "WorkReportPeriod" NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "summary" TEXT NOT NULL,
    "blockers" TEXT,
    "next_steps" TEXT,
    "metrics" JSONB,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewer_id" UUID,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "auto_approved" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_reports_pkey" PRIMARY KEY ("id")
);

-- One report per person per period. Resubmitting updates rather than stacking
-- up near-duplicates in the reviewer's queue.
CREATE UNIQUE INDEX "work_reports_workspace_id_user_id_period_period_start_key"
  ON "work_reports" ("workspace_id", "user_id", "period", "period_start");
CREATE INDEX "work_reports_workspace_id_status_idx" ON "work_reports" ("workspace_id", "status");

ALTER TABLE "work_reports"
  ADD CONSTRAINT "work_reports_range_valid" CHECK ("period_end" >= "period_start"),
  ADD CONSTRAINT "work_reports_decided_consistently"
    CHECK (("status" IN ('APPROVED','REJECTED')) = ("reviewed_at" IS NOT NULL)),
  ADD CONSTRAINT "work_reports_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "work_reports_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "work_reports_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
