-- Limite de anexos (respostas rápidas e fluxos) por empresa, em MB. Vazio = padrão de 200 MB.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "attachments_limit_mb" integer;
--> statement-breakpoint
-- McLovin Business: 500 MB (pedido do dono da plataforma)
UPDATE "accounts" SET "attachments_limit_mb" = 500 WHERE lower("name") LIKE '%mclovin%';
--> statement-breakpoint
-- Hash do arquivo como foi enviado (antes da compressão): o mesmo arquivo enviado de novo reaproveita o já guardado
ALTER TABLE "stored_files" ADD COLUMN IF NOT EXISTS "source_sha256" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stored_files_dedupe_idx" ON "stored_files" ("account_id", "purpose", "source_sha256");
