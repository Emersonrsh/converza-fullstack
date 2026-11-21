-- Converza Members: módulo bloqueado (até a empresa liberar, ou N dias depois do acesso do aluno)
ALTER TABLE "member_modules" ADD COLUMN IF NOT EXISTS "locked" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "member_modules" ADD COLUMN IF NOT EXISTS "unlock_after_days" integer;
