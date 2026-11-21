-- Converza Members: módulo de bônus (aparece numa fileira própria, depois dos módulos do curso)
ALTER TABLE "member_modules" ADD COLUMN IF NOT EXISTS "is_bonus" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "member_modules" SET "is_bonus" = true WHERE "title" ~* 'b[ôo]nus';
