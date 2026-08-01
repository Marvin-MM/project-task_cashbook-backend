-- Attendance core: policy, sites, schedules, presence and the daily rollup.
--
-- The design decision worth restating here: attendance_days is DERIVED and has
-- a single writer. It exists because absence cannot be computed from rows that
-- exist — "who was missing on Tuesday" needs a day x member grid resolved
-- against schedules, holidays and leave, which is not a GROUP BY over sessions.

-- ─── 1. Enums ───────────────────────────────────────────

CREATE TYPE "PresenceStatus" AS ENUM ('AVAILABLE', 'WORKING', 'BUSY', 'BREAK', 'LUNCH', 'MEETING');
CREATE TYPE "GeofenceEnforcement" AS ENUM ('OFF', 'WARN', 'ENFORCE');
CREATE TYPE "AttendanceDayStatus" AS ENUM
  ('PRESENT', 'PARTIAL', 'ABSENT', 'ON_LEAVE', 'HOLIDAY', 'NON_WORKING');

-- ─── 2. Who is expected at all ──────────────────────────

ALTER TABLE "workspace_members"
  ADD COLUMN "employment_start_date" DATE,
  ADD COLUMN "employment_end_date" DATE,
  ADD COLUMN "attendance_tracked" BOOLEAN NOT NULL DEFAULT true;

-- ─── 3. Policy ──────────────────────────────────────────

CREATE TABLE "attendance_settings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "day_boundary_minutes" INTEGER NOT NULL DEFAULT 0,
    "geofence_enforcement" "GeofenceEnforcement" NOT NULL DEFAULT 'WARN',
    "allow_task_site_clock_in" BOOLEAN NOT NULL DEFAULT true,
    "overtime_tracking_enabled" BOOLEAN NOT NULL DEFAULT false,
    "billable_tracking_enabled" BOOLEAN NOT NULL DEFAULT true,
    "wrap_up_reminder_minutes" INTEGER NOT NULL DEFAULT 30,
    "early_clock_out_requires_reason" BOOLEAN NOT NULL DEFAULT true,
    "allow_clock_in_while_on_leave" BOOLEAN NOT NULL DEFAULT false,
    "flags_enabled" BOOLEAN NOT NULL DEFAULT true,
    "presence_visible_to_all_members" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attendance_settings_workspace_id_key"
  ON "attendance_settings" ("workspace_id");

ALTER TABLE "attendance_settings"
  ADD CONSTRAINT "attendance_settings_day_boundary_range"
    CHECK ("day_boundary_minutes" >= 0 AND "day_boundary_minutes" < 1440),
  ADD CONSTRAINT "attendance_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing workspace gets the defaults.
INSERT INTO "attendance_settings" ("id", "workspace_id", "updated_at")
SELECT gen_random_uuid(), w.id, NOW() FROM "workspaces" w;

-- ─── 4. Sites ───────────────────────────────────────────

CREATE TABLE "attendance_sites" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radius_meters" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_sites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attendance_sites_workspace_id_is_active_idx"
  ON "attendance_sites" ("workspace_id", "is_active");
CREATE UNIQUE INDEX "attendance_sites_task_id_key" ON "attendance_sites" ("task_id");

-- At most one primary site per workspace, among the active ones.
CREATE UNIQUE INDEX "attendance_sites_one_primary"
  ON "attendance_sites" ("workspace_id") WHERE "is_primary" AND "is_active";

ALTER TABLE "attendance_sites"
  ADD CONSTRAINT "attendance_sites_radius_sane"
    CHECK ("radius_meters" BETWEEN 25 AND 100000),
  ADD CONSTRAINT "attendance_sites_coords_valid"
    CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "attendance_sites_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_sites_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the single workspace geofence over as the primary site.
INSERT INTO "attendance_sites"
  ("id", "workspace_id", "name", "latitude", "longitude", "radius_meters", "is_primary", "updated_at")
SELECT gen_random_uuid(), w.id,
       COALESCE(w."attendance_location_name", 'Main location'),
       w."attendance_latitude", w."attendance_longitude", w."attendance_radius_meters",
       true, NOW()
FROM "workspaces" w
WHERE w."attendance_latitude" IS NOT NULL
  AND w."attendance_longitude" IS NOT NULL
  AND w."attendance_radius_meters" IS NOT NULL;

-- ─── 5. Schedules ───────────────────────────────────────

CREATE TABLE "work_schedules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "name" TEXT NOT NULL DEFAULT 'Standard hours',
    "working_days" INTEGER[] NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "crosses_midnight" BOOLEAN NOT NULL DEFAULT false,
    "grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "early_out_grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "break_paid" BOOLEAN NOT NULL DEFAULT false,
    "expected_minutes_per_day" INTEGER NOT NULL,
    "clock_in_window_start" TEXT,
    "clock_in_window_end" TEXT,
    "clock_out_window_start" TEXT,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "work_schedules_workspace_id_user_id_effective_from_idx"
  ON "work_schedules" ("workspace_id", "user_id", "effective_from");

-- One CURRENT org default, and one CURRENT override per member. Partial because
-- superseded rows (effective_to set) are history and must be allowed to pile up,
-- and because Postgres treats NULL user_id values as distinct in a plain unique.
CREATE UNIQUE INDEX "work_schedules_one_current_default"
  ON "work_schedules" ("workspace_id")
  WHERE "user_id" IS NULL AND "effective_to" IS NULL;
CREATE UNIQUE INDEX "work_schedules_one_current_override"
  ON "work_schedules" ("workspace_id", "user_id")
  WHERE "user_id" IS NOT NULL AND "effective_to" IS NULL;

ALTER TABLE "work_schedules"
  ADD CONSTRAINT "work_schedules_days_valid"
    CHECK ("working_days" <@ ARRAY[1,2,3,4,5,6,7]),
  ADD CONSTRAINT "work_schedules_range_valid"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  ADD CONSTRAINT "work_schedules_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "work_schedules_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A default schedule per workspace, carrying over any clock-in window that was
-- configured on the workspace itself.
INSERT INTO "work_schedules"
  ("id", "workspace_id", "working_days", "start_time", "end_time",
   "expected_minutes_per_day", "clock_in_window_start", "clock_in_window_end",
   "clock_out_window_start", "effective_from", "updated_at")
SELECT gen_random_uuid(), w.id, ARRAY[1,2,3,4,5], '09:00', '17:00', 480,
       w."attendance_clock_in_start", w."attendance_clock_in_end",
       w."attendance_clock_out_start", CURRENT_DATE, NOW()
FROM "workspaces" w;

-- ─── 6. Holidays ────────────────────────────────────────

CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "holidays_workspace_id_date_key" ON "holidays" ("workspace_id", "date");

ALTER TABLE "holidays"
  ADD CONSTRAINT "holidays_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 7. Presence intervals ──────────────────────────────

CREATE TABLE "work_session_presence" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "PresenceStatus" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "minutes" INTEGER,
    "note" TEXT,

    CONSTRAINT "work_session_presence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "work_session_presence_session_id_started_at_idx"
  ON "work_session_presence" ("session_id", "started_at");
CREATE INDEX "work_session_presence_workspace_id_user_id_started_at_idx"
  ON "work_session_presence" ("workspace_id", "user_id", "started_at");

-- One open interval per session. This is what makes two concurrent presence
-- changes converge instead of producing overlapping intervals.
CREATE UNIQUE INDEX "presence_one_open_per_session"
  ON "work_session_presence" ("session_id") WHERE "ended_at" IS NULL;

ALTER TABLE "work_session_presence"
  ADD CONSTRAINT "work_session_presence_ordered"
    CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
  ADD CONSTRAINT "work_session_presence_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "work_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 8. Session columns ─────────────────────────────────

ALTER TABLE "work_sessions"
  ADD COLUMN "presence_status" "PresenceStatus",
  ADD COLUMN "presence_changed_at" TIMESTAMP(3),
  ADD COLUMN "schedule_id" UUID,
  ADD COLUMN "scheduled_start_utc" TIMESTAMP(3),
  ADD COLUMN "scheduled_end_utc" TIMESTAMP(3),
  ADD COLUMN "scheduled_minutes" INTEGER,
  ADD COLUMN "grace_minutes_applied" INTEGER,
  ADD COLUMN "break_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "worked_minutes" INTEGER,
  ADD COLUMN "raw_overtime_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "counted_overtime_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "clock_in_site_id" UUID,
  ADD COLUMN "clock_out_site_id" UUID,
  ADD COLUMN "clock_in_task_id" UUID,
  ADD COLUMN "clock_in_distance_meters" DOUBLE PRECISION,
  ADD COLUMN "clock_out_distance_meters" DOUBLE PRECISION;

-- Closed sessions carry their elapsed time as worked time until the rollup
-- recomputes them; there were no break intervals before this migration.
UPDATE "work_sessions" SET "worked_minutes" = "total_minutes" WHERE "clock_out" IS NOT NULL;

-- Presence exists exactly while the session is open. Makes "presence must clear
-- on clock-out" structurally true rather than a rule the service remembers.
ALTER TABLE "work_sessions"
  ADD CONSTRAINT "work_sessions_presence_matches_state"
    CHECK (("clock_out" IS NULL) = ("presence_status" IS NOT NULL));

ALTER TABLE "work_sessions"
  ADD CONSTRAINT "work_sessions_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "work_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "work_sessions_clock_in_site_id_fkey"
    FOREIGN KEY ("clock_in_site_id") REFERENCES "attendance_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "work_sessions_clock_out_site_id_fkey"
    FOREIGN KEY ("clock_out_site_id") REFERENCES "attendance_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "work_sessions_clock_in_task_id_fkey"
    FOREIGN KEY ("clock_in_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing OPEN sessions predate presence, so give them the entry state rather
-- than failing the new CHECK.
UPDATE "work_sessions" SET "presence_status" = 'AVAILABLE', "presence_changed_at" = "clock_in"
WHERE "clock_out" IS NULL;

INSERT INTO "work_session_presence" ("id", "session_id", "workspace_id", "user_id", "status", "started_at")
SELECT gen_random_uuid(), ws.id, ws."workspace_id", ws."user_id", 'AVAILABLE', ws."clock_in"
FROM "work_sessions" ws WHERE ws."clock_out" IS NULL;

-- ─── 9. Daily rollup ────────────────────────────────────

CREATE TABLE "attendance_days" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "AttendanceDayStatus" NOT NULL,
    "expected_minutes" INTEGER NOT NULL DEFAULT 0,
    "worked_minutes" INTEGER NOT NULL DEFAULT 0,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "raw_overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "counted_overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "billable_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_out_minutes" INTEGER NOT NULL DEFAULT 0,
    "first_clock_in" TIMESTAMP(3),
    "last_clock_out" TIMESTAMP(3),
    "session_count" INTEGER NOT NULL DEFAULT 0,
    "schedule_id" UUID,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attendance_days_workspace_id_user_id_business_date_key"
  ON "attendance_days" ("workspace_id", "user_id", "business_date");
CREATE INDEX "attendance_days_workspace_id_business_date_status_idx"
  ON "attendance_days" ("workspace_id", "business_date", "status");

ALTER TABLE "attendance_days"
  -- Counted overtime is always a subset of what was measured.
  ADD CONSTRAINT "attendance_days_counted_ot_within_raw"
    CHECK ("counted_overtime_minutes" <= "raw_overtime_minutes"),
  ADD CONSTRAINT "attendance_days_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_days_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
