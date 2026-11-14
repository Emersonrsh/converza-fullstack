-- Campanha da Meta ligada a um produto (o gasto dela entra no lucro do produto no painel do dia)
CREATE TABLE IF NOT EXISTS "meta_campaign_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "act_id" text NOT NULL,
  "campaign_id" text NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meta_campaign_products_uq" ON "meta_campaign_products" ("account_id", "campaign_id");
--> statement-breakpoint
-- Regras automáticas dos anúncios (pausar, ativar, mudar orçamento) avaliadas de tempos em tempos
CREATE TABLE IF NOT EXISTS "ad_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "act_id" text NOT NULL,
  "level" text NOT NULL,
  "campaign_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "window" text DEFAULT 'today' NOT NULL,
  "action" jsonb NOT NULL,
  "cooldown_hours" integer DEFAULT 24 NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_rules_account_idx" ON "ad_rules" ("account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_rule_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "rule_id" uuid REFERENCES "ad_rules"("id") ON DELETE CASCADE,
  "rule_name" text NOT NULL,
  "object_id" text NOT NULL,
  "object_name" text NOT NULL,
  "level" text NOT NULL,
  "action" text NOT NULL,
  "status" text NOT NULL,
  "detail" text NOT NULL,
  "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_rule_logs_account_idx" ON "ad_rule_logs" ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_rule_logs_rule_obj_idx" ON "ad_rule_logs" ("rule_id", "object_id", "created_at");
