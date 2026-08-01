-- AlterTable
ALTER TABLE "account_transactions" ADD COLUMN     "transaction_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: cashbook-linked rows inherit the entry's business date; everything
-- else (DIRECT wallet transactions, opening balances) falls back to created_at,
-- which for those rows was already the business date.
UPDATE "account_transactions" at
SET "transaction_date" = e."entry_date"
FROM "entries" e
WHERE at."source_id" = e."id"
  AND at."source_type" = 'CASHBOOK_ENTRY';

UPDATE "account_transactions"
SET "transaction_date" = "created_at"
WHERE "source_type" <> 'CASHBOOK_ENTRY';

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "is_reversal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reverses_transaction_id" UUID;

-- CreateIndex
CREATE INDEX "account_transactions_account_id_transaction_date_idx" ON "account_transactions"("account_id", "transaction_date");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transactions_reverses_transaction_id_key" ON "inventory_transactions"("reverses_transaction_id");

-- CreateIndex
CREATE INDEX "inventory_transactions_reference_type_reference_id_is_rever_idx" ON "inventory_transactions"("reference_type", "reference_id", "is_reversal");

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_reverses_transaction_id_fkey" FOREIGN KEY ("reverses_transaction_id") REFERENCES "inventory_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

