-- Task approvals: request to take on work, and report when it is done.
--
-- The lifecycle gains IN_REVIEW between IN_PROGRESS and DONE. That single enum
-- value is what makes two requirements the same mechanism: an assignee submits
-- an end-of-task report (task -> IN_REVIEW) and only an approver can move it to
-- DONE. A member who created their own standalone task goes through exactly the
-- same gate.

-- ─── 1. Enums ───────────────────────────────────────────

-- Placed before DONE so the enum reads in lifecycle order.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'IN_REVIEW' BEFORE 'DONE';

CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');
CREATE TYPE "NotificationEntityType" AS ENUM ('TASK', 'TASK_ASSIGNMENT_REQUEST', 'TASK_REPORT');

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_ASSIGNMENT_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_ASSIGNMENT_DECIDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_REPORT_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_REPORT_DECIDED';

-- ─── 2. Workspace policy ────────────────────────────────

ALTER TABLE "workspaces"
  ADD COLUMN "max_concurrent_open_tasks" INTEGER DEFAULT 1;

-- ─── 3. Notification targeting ──────────────────────────

ALTER TABLE "notifications"
  ADD COLUMN "entity_type" "NotificationEntityType",
  ADD COLUMN "entity_id" UUID,
  ADD COLUMN "group_key" TEXT;

-- Existing rows all point at a task.
UPDATE "notifications" SET "entity_type" = 'TASK', "entity_id" = "task_id"
WHERE "task_id" IS NOT NULL;

-- Deterministic dedupe. group_key is nullable and Postgres treats NULLs as
-- distinct in a unique index, so unkeyed notifications stay unconstrained —
-- only the ones that opt in are collapsed.
CREATE UNIQUE INDEX "notifications_user_id_type_group_key_key"
  ON "notifications" ("user_id", "type", "group_key");

-- ─── 4. Assignment requests ─────────────────────────────

CREATE TABLE "task_assignment_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "message" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewer_id" UUID,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_assignment_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_assignment_requests_workspace_id_status_idx"
  ON "task_assignment_requests" ("workspace_id", "status");
CREATE INDEX "task_assignment_requests_task_id_idx"
  ON "task_assignment_requests" ("task_id");
CREATE INDEX "task_assignment_requests_requester_id_status_idx"
  ON "task_assignment_requests" ("requester_id", "status");

-- One live request per person per task. Decided requests are history and must
-- not block asking again, so the index is partial rather than a plain unique.
CREATE UNIQUE INDEX "task_assignment_requests_one_pending"
  ON "task_assignment_requests" ("task_id", "requester_id")
  WHERE "status" = 'PENDING';

-- A decision is a decision: reviewed_at and status move together or not at all.
ALTER TABLE "task_assignment_requests"
  ADD CONSTRAINT "task_assignment_requests_decided_consistently"
    CHECK (("status" IN ('APPROVED', 'REJECTED')) = ("reviewed_at" IS NOT NULL));

ALTER TABLE "task_assignment_requests"
  ADD CONSTRAINT "task_assignment_requests_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_assignment_requests_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_assignment_requests_requester_id_fkey"
    FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_assignment_requests_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 5. End-of-task reports ─────────────────────────────

CREATE TABLE "task_reports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "blockers" TEXT,
    "minutes_spent" INTEGER,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewer_id" UUID,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_reports_workspace_id_status_idx" ON "task_reports" ("workspace_id", "status");
CREATE INDEX "task_reports_task_id_idx" ON "task_reports" ("task_id");
CREATE INDEX "task_reports_author_id_idx" ON "task_reports" ("author_id");

-- One report under review or already accepted per task. A REJECTED report is
-- history and deliberately does not block a resubmission.
CREATE UNIQUE INDEX "task_reports_one_live_per_task"
  ON "task_reports" ("task_id")
  WHERE "status" IN ('PENDING', 'APPROVED');

ALTER TABLE "task_reports"
  ADD CONSTRAINT "task_reports_decided_consistently"
    CHECK (("status" IN ('APPROVED', 'REJECTED')) = ("reviewed_at" IS NOT NULL));

ALTER TABLE "task_reports"
  ADD CONSTRAINT "task_reports_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_reports_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_reports_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_reports_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
