-- Migration: add_api_keys_and_book_ref
-- Adds:
--   1. DEVELOPER value to workspace_role enum
--   2. book_ref column to cashbooks (unique short code, nullable until an
--      authorised user explicitly activates integration for the book)
--   3. api_key_scope enum
--   4. api_key_status enum
--   5. api_keys table

-- ─── 1. Extend workspace_role enum ─────────────────────────────────────────────
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'DEVELOPER';

-- ─── 2. Add book_ref to cashbooks ───────────────────────────────────────────────
ALTER TABLE "cashbooks"
    ADD COLUMN IF NOT EXISTS "book_ref" TEXT;

ALTER TABLE "cashbooks"
    ADD CONSTRAINT "cashbooks_book_ref_key" UNIQUE ("book_ref");

-- ─── 3. api_key_scope enum ──────────────────────────────────────────────────────
CREATE TYPE "ApiKeyScope" AS ENUM ('WRITE_ENTRIES', 'READ_ENTRIES');

-- ─── 4. api_key_status enum ─────────────────────────────────────────────────────
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- ─── 5. api_keys table ──────────────────────────────────────────────────────────
CREATE TABLE "api_keys" (
    "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id"     UUID         NOT NULL,
    "name"             TEXT         NOT NULL,
    "key_hash"         TEXT         NOT NULL,
    "key_prefix"       TEXT         NOT NULL,
    "scopes"           "ApiKeyScope"[]       NOT NULL DEFAULT '{}',
    "status"           "ApiKeyStatus"        NOT NULL DEFAULT 'ACTIVE',
    "created_by_id"    UUID         NOT NULL,
    "allowed_book_ids" UUID[]                NOT NULL DEFAULT '{}',
    "allowed_ips"      TEXT[]                NOT NULL DEFAULT '{}',
    "last_used_at"     TIMESTAMPTZ,
    "expires_at"       TIMESTAMPTZ,
    "revoked_at"       TIMESTAMPTZ,
    "revoked_by_id"    UUID,
    "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updated_at"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "api_keys_pkey"               PRIMARY KEY ("id"),
    CONSTRAINT "api_keys_key_hash_key"       UNIQUE ("key_hash"),
    CONSTRAINT "api_keys_workspace_fk"       FOREIGN KEY ("workspace_id")   REFERENCES "workspaces"("id") ON DELETE CASCADE,
    CONSTRAINT "api_keys_created_by_fk"      FOREIGN KEY ("created_by_id")  REFERENCES "users"("id"),
    CONSTRAINT "api_keys_revoked_by_fk"      FOREIGN KEY ("revoked_by_id")  REFERENCES "users"("id")
);

CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys"("workspace_id");
CREATE INDEX "api_keys_key_hash_idx"     ON "api_keys"("key_hash");
CREATE INDEX "api_keys_status_idx"       ON "api_keys"("status");

-- ─── 6. Durable external-entry idempotency / provenance ─────────────────────────
-- NULL values are allowed for normal UI-created entries. PostgreSQL's unique
-- semantics permit multiple NULL rows, while an integration key + external
-- reference can be recorded only once in a cashbook.
ALTER TABLE "entries"
    ADD COLUMN IF NOT EXISTS "integration_api_key_id" UUID,
    ADD COLUMN IF NOT EXISTS "external_ref" TEXT;

CREATE INDEX "entries_integration_api_key_id_idx"
    ON "entries"("integration_api_key_id");

CREATE UNIQUE INDEX "entries_cashbook_integration_external_ref_key"
    ON "entries"("cashbook_id", "integration_api_key_id", "external_ref");
