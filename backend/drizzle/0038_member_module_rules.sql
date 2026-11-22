-- Converza Members: módulo liberado ou bloqueado para um aluno específico, e regras "venda aprovada libera módulo"
CREATE TABLE IF NOT EXISTS "member_module_overrides" (
  "member_id" uuid NOT NULL REFERENCES "member_users"("id") ON DELETE CASCADE,
  "module_id" uuid NOT NULL REFERENCES "member_modules"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "state" text NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "sale_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("member_id", "module_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_unlock_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "module_id" uuid NOT NULL REFERENCES "member_modules"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_unlock_rules_uq" ON "member_unlock_rules" ("module_id", "product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_unlock_rules_product_idx" ON "member_unlock_rules" ("account_id", "product_id");
