-- Attendance: real time zones, persisted business dates, and the uniqueness
-- backstops the code only claimed to have.
--
-- THE ORDER OF THIS FILE IS LOAD-BEARING. Steps 5 and 6 must run before step 8:
-- the previous clock-in guard was a read-then-write race with no index behind
-- it, so a production database may already hold two open sessions for one user.
-- CREATE UNIQUE INDEX would simply fail on that data.
--
-- Prisma wraps each migration in a transaction, so CREATE INDEX CONCURRENTLY is
-- not available here. At attendance-table scale the blocking build is fine.

-- ─── 1. Enum ────────────────────────────────────────────

CREATE TYPE "WorkSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'AUTO_CLOSED', 'ADMIN_CLOSED');

-- ─── 2. Workspace: time zone and window policy ──────────

-- Africa/Kampala rather than UTC. Every existing value of the attendance
-- windows was compared against the SERVER's zone, so none of them is
-- trustworthy anyway; UGX/Kampala is the actual user base, and Kampala has no
-- DST, so the default configuration is also the one with the fewest ways to be
-- wrong. Admins are prompted to confirm in settings after deploy.
ALTER TABLE "workspaces"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Africa/Kampala',
  ADD COLUMN "enforce_clock_windows" BOOLEAN NOT NULL DEFAULT false;

-- Preserve what we are about to drop, so support can answer "where did my
-- setting go" rather than guessing.
INSERT INTO "audit_logs" ("id", "workspace_id", "action", "resource", "resource_id", "details", "created_at")
SELECT gen_random_uuid(), w.id, 'WORKSPACE_ATTENDANCE_SETTINGS_UPDATED', 'workspace', w.id::text,
       jsonb_build_object(
         'migration', '0008_attendance_timezone_core',
         'note', 'attendance_clock_out_end removed: a closed clock-out window made sessions impossible to close',
         'removedClockOutEnd', w."attendance_clock_out_end"),
       NOW()
FROM "workspaces" w
WHERE w."attendance_clock_out_end" IS NOT NULL;

-- The clock-out upper bound is deleted and has no successor. It is the source
-- of the trap this migration exists to close: once it passed, the session could
-- never be closed, and because the one-open-session rule is global that stuck
-- session locked the person out of EVERY organisation they belong to.
ALTER TABLE "workspaces" DROP COLUMN "attendance_clock_out_end";

-- ─── 3. Work sessions: new columns ──────────────────────

ALTER TABLE "work_sessions"
  ADD COLUMN "business_date" DATE,
  ADD COLUMN "status" "WorkSessionStatus" NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "clock_in_within_geofence" BOOLEAN,
  ADD COLUMN "clock_out_within_geofence" BOOLEAN,
  ADD COLUMN "auto_closed_at" TIMESTAMP(3),
  ADD COLUMN "closed_by_id" UUID,
  ADD COLUMN "closure_reason" TEXT,
  ADD COLUMN "early_out_reason" TEXT;

-- adjusted_by_id has been a bare uuid column with no constraint since it was
-- introduced, so it could point at a user that never existed.
ALTER TABLE "work_sessions"
  ADD CONSTRAINT "work_sessions_adjusted_by_id_fkey"
    FOREIGN KEY ("adjusted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "work_sessions_closed_by_id_fkey"
    FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 4. Time entries: new columns ───────────────────────

ALTER TABLE "time_entries"
  ADD COLUMN "business_date" DATE,
  ADD COLUMN "created_by_id" UUID;

-- Every entry that exists today was self-logged; there was no way to log for
-- someone else.
UPDATE "time_entries" SET "created_by_id" = "user_id" WHERE "created_by_id" IS NULL;

-- ─── 5. Close duplicate open rows ───────────────────────
-- Must precede the unique indexes. Keep the newest open session per user and
-- close the rest at their own clock-in, so no minutes are invented.

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY "user_id" ORDER BY "clock_in" DESC) AS rn
  FROM "work_sessions"
  WHERE "clock_out" IS NULL
)
UPDATE "work_sessions" ws
SET "clock_out" = ws."clock_in",
    "total_minutes" = 0,
    "status" = 'ADMIN_CLOSED',
    "closure_reason" = 'MIGRATION_DUPLICATE_OPEN'
FROM ranked r
WHERE r.id = ws.id AND r.rn > 1;

WITH ranked AS (
  SELECT id, row_number() OVER (
           PARTITION BY "user_id", "workspace_id" ORDER BY "start_time" DESC) AS rn
  FROM "time_entries"
  WHERE "end_time" IS NULL AND "source" = 'TIMER'
)
UPDATE "time_entries" te
SET "end_time" = te."start_time",
    "duration_minutes" = 0
FROM ranked r
WHERE r.id = te.id AND r.rn > 1;

-- ─── 6. Close stale open sessions ───────────────────────
-- Anything open more than 36h is a forgotten tap, not a shift. Credit 8h rather
-- than the elapsed time so nobody is handed a multi-day day, and record the
-- reason so the invented number is visible rather than silent.

UPDATE "work_sessions"
SET "clock_out" = "clock_in" + INTERVAL '8 hours',
    "total_minutes" = 480,
    "status" = 'AUTO_CLOSED',
    "auto_closed_at" = NOW(),
    "closure_reason" = 'MIGRATION_STALE_OPEN'
WHERE "clock_out" IS NULL
  AND "clock_in" < NOW() - INTERVAL '36 hours';

-- Sessions still legitimately open keep status OPEN (the column default).
UPDATE "work_sessions" SET "status" = 'CLOSED'
WHERE "clock_out" IS NOT NULL AND "status" = 'OPEN';

-- ─── 7. Backfill business dates ─────────────────────────
-- Columns are TIMESTAMP WITHOUT TIME ZONE holding UTC, hence the double
-- conversion: label the value as UTC, then read it in the workspace's zone.
-- day_boundary_minutes is 0 for every workspace at migration time, so the
-- simple form is correct here.

UPDATE "work_sessions" ws
SET "business_date" = (("ws"."clock_in" AT TIME ZONE 'UTC') AT TIME ZONE w."timezone")::date
FROM "workspaces" w
WHERE w.id = ws."workspace_id";

UPDATE "time_entries" te
SET "business_date" = (("te"."start_time" AT TIME ZONE 'UTC') AT TIME ZONE w."timezone")::date
FROM "workspaces" w
WHERE w.id = te."workspace_id";

-- Orphans (workspace deleted out from under the row) get the UTC reading rather
-- than blocking the NOT NULL below.
UPDATE "work_sessions" SET "business_date" = ("clock_in")::date WHERE "business_date" IS NULL;
UPDATE "time_entries"  SET "business_date" = ("start_time")::date WHERE "business_date" IS NULL;
UPDATE "time_entries"  SET "created_by_id" = "user_id" WHERE "created_by_id" IS NULL;

ALTER TABLE "work_sessions" ALTER COLUMN "business_date" SET NOT NULL;
ALTER TABLE "time_entries"  ALTER COLUMN "business_date" SET NOT NULL;
ALTER TABLE "time_entries"  ALTER COLUMN "created_by_id" SET NOT NULL;

ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 8. The uniqueness backstops ────────────────────────

-- THE cross-org guard. Until now this was a findFirst + an in-transaction
-- re-check under READ COMMITTED, which does not serialize anything — two
-- concurrent clock-ins could both pass. The P2002 handlers in clockIn and
-- startTimer were unreachable code because this index did not exist.
CREATE UNIQUE INDEX "work_sessions_one_open_per_user"
  ON "work_sessions" ("user_id") WHERE "clock_out" IS NULL;

CREATE UNIQUE INDEX "time_entries_one_open_timer"
  ON "time_entries" ("user_id", "workspace_id")
  WHERE "end_time" IS NULL AND "source" = 'TIMER';

-- Read model for "who is clocked in right now", which the client polls.
CREATE INDEX "work_sessions_open_by_workspace"
  ON "work_sessions" ("workspace_id", "clock_in" DESC) WHERE "clock_out" IS NULL;

CREATE INDEX "work_sessions_workspace_id_business_date_idx"
  ON "work_sessions" ("workspace_id", "business_date");
CREATE INDEX "work_sessions_workspace_id_user_id_business_date_idx"
  ON "work_sessions" ("workspace_id", "user_id", "business_date");
CREATE INDEX "time_entries_workspace_id_user_id_business_date_idx"
  ON "time_entries" ("workspace_id", "user_id", "business_date");
CREATE INDEX "time_entries_workspace_id_project_id_business_date_idx"
  ON "time_entries" ("workspace_id", "project_id", "business_date");

-- ─── 9. State invariants ────────────────────────────────
-- These make the session state machine structurally enforced rather than
-- merely conventional: no code path, script or psql session can leave a row
-- half-closed.

ALTER TABLE "work_sessions"
  ADD CONSTRAINT "work_sessions_open_state"
    CHECK (("clock_out" IS NULL) = ("status" = 'OPEN')),
  ADD CONSTRAINT "work_sessions_closed_has_minutes"
    CHECK ("clock_out" IS NULL OR "total_minutes" IS NOT NULL),
  ADD CONSTRAINT "work_sessions_ordered"
    CHECK ("clock_out" IS NULL OR "clock_out" >= "clock_in");
