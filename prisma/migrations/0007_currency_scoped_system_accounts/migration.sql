-- DropIndex
DROP INDEX "ledger_accounts_workspace_id_system_key_key";

-- CreateIndex
CREATE INDEX "ledger_accounts_workspace_id_currency_idx" ON "ledger_accounts"("workspace_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_workspace_id_system_key_currency_key" ON "ledger_accounts"("workspace_id", "system_key", "currency");

