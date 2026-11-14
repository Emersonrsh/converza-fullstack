-- Aparelhos inscritos para receber notificações (Web Push), por usuário e empresa
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "device" text,
  "prefs" jsonb DEFAULT '{"sales":true}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_uq" ON "push_subscriptions" ("account_id", "endpoint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx" ON "push_subscriptions" ("user_id");
--> statement-breakpoint
-- venda já avisada no celular (uma notificação por venda, mesmo com reenvios do checkout)
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "push_notified_at" timestamp with time zone;
