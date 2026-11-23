-- Arquivos fora do banco: anexos (respostas rápidas e fluxos) e mídia do QR Code passam a ficar no R2.
ALTER TABLE "stored_files" ADD COLUMN IF NOT EXISTS "storage_key" text;--> statement-breakpoint
ALTER TABLE "wa_web_media" ADD COLUMN IF NOT EXISTS "storage_key" text;--> statement-breakpoint
ALTER TABLE "wa_web_media" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "object_trash" (
  "key" text PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- qualquer apagamento (inclusive em cascata, ao excluir empresa ou conexão) manda o arquivo para a lixeira do R2
CREATE OR REPLACE FUNCTION trash_object_key() RETURNS trigger AS $$
BEGIN
  IF OLD.storage_key IS NOT NULL THEN
    INSERT INTO object_trash ("key") VALUES (OLD.storage_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS stored_files_trash_object ON "stored_files";--> statement-breakpoint
CREATE TRIGGER stored_files_trash_object AFTER DELETE ON "stored_files" FOR EACH ROW EXECUTE FUNCTION trash_object_key();--> statement-breakpoint
DROP TRIGGER IF EXISTS wa_web_media_trash_object ON "wa_web_media";--> statement-breakpoint
CREATE TRIGGER wa_web_media_trash_object AFTER DELETE ON "wa_web_media" FOR EACH ROW EXECUTE FUNCTION trash_object_key();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stored_files_unmigrated_idx" ON "stored_files" ("created_at") WHERE "storage_key" IS NULL;
