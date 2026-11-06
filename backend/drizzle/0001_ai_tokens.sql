ALTER TABLE "subscriptions" ADD COLUMN "ai_tokens_allowance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "ai_tokens_balance" integer DEFAULT 0 NOT NULL;