CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"gateway" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"number" serial NOT NULL,
	"gateway" text NOT NULL,
	"gateway_payment_id" text,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"due_date" date,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refund_amount" numeric(12, 2),
	"invoice_url" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "number" serial NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "instances" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pending_instances" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "gateway" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "gateway_customer_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "gateway_subscription_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_country" text DEFAULT 'BR' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_name" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "ai_tokens_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_token_purchase_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_account_idx" ON "invoices" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_gateway_payment_uq" ON "invoices" USING btree ("gateway","gateway_payment_id") WHERE gateway_payment_id is not null;--> statement-breakpoint
-- cobrança por instância: os planos antigos viram instâncias (Starter 1, Growth 3, Scale 10)
UPDATE "subscriptions" SET "instances" = CASE WHEN "status" <> 'active' THEN 0 WHEN "plan" = 'growth' THEN 3 WHEN "plan" = 'scale' THEN 10 ELSE 1 END,
  "started_at" = CASE WHEN "status" = 'active' THEN coalesce("current_period_end" - interval '1 month', now()) ELSE NULL END;
--> statement-breakpoint
-- números curtos: contas a partir de 10001 e faturas a partir de 1001
UPDATE "accounts" SET "number" = "number" + 10000;
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('accounts', 'number'), greatest(10000, (SELECT coalesce(max("number"), 10000) FROM "accounts")));
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('invoices', 'number'), 1000, true);
--> statement-breakpoint
-- ativações antigas (sem pagamento de verdade): continuam até o fim do período (no mínimo 7 dias) e não renovam sozinhas
UPDATE "subscriptions" SET "cancel_at_period_end" = true,
  "current_period_end" = greatest(coalesce("current_period_end", now()), now() + interval '7 days')
  WHERE "status" = 'active' AND "gateway" IS NULL;
