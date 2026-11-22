-- Converza Members: módulos que o bloco de fluxo deixou bloqueados e liberam depois (venda aprovada ou dias)
CREATE TABLE IF NOT EXISTS "member_pending_unlocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "member_id" uuid NOT NULL REFERENCES "member_users"("id") ON DELETE CASCADE,
  "module_id" uuid NOT NULL REFERENCES "member_modules"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "product_id" uuid REFERENCES "products"("id") ON DELETE CASCADE,
  "unlock_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_pending_unlocks_member_idx" ON "member_pending_unlocks" ("member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_pending_unlocks_due_idx" ON "member_pending_unlocks" ("unlock_at") WHERE "kind" = 'time';
