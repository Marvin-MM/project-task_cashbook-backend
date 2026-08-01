-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "resource_id" UUID,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_records_user_id_idx" ON "idempotency_records"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_workspace_id_endpoint_key_key" ON "idempotency_records"("workspace_id", "endpoint", "key");

