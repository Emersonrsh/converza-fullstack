-- Arquivos dos fluxos/respostas rápidas gravados em pedaços de 1 MB (um arquivo grande de uma vez derrubava o Postgres pequeno).
ALTER TABLE "stored_files" ALTER COLUMN "data" DROP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stored_file_chunks" (
  "file_id" uuid NOT NULL REFERENCES "stored_files"("id") ON DELETE CASCADE,
  "idx" integer NOT NULL,
  "data" bytea NOT NULL,
  CONSTRAINT "stored_file_chunks_pk" PRIMARY KEY ("file_id", "idx")
);
