CREATE TABLE "contact_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid,
	"filename" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"options" text[] DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_exports" ADD CONSTRAINT "contact_exports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_exports" ADD CONSTRAINT "contact_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_fields" ADD CONSTRAINT "contact_fields_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_exports_account_idx" ON "contact_exports" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_fields_account_key_uq" ON "contact_fields" USING btree ("account_id","key");--> statement-breakpoint
-- origem dos contatos que já existiam: anúncio, conversa iniciada pelo cliente ou cadastro manual
UPDATE "contacts" c SET "origin" = CASE
  WHEN c."source_id" IS NOT NULL THEN 'ad'
  WHEN EXISTS (SELECT 1 FROM "conversations" v JOIN "messages" m ON m."conversation_id" = v."id" WHERE v."contact_id" = c."id" AND m."direction" = 'in') THEN 'whatsapp'
  ELSE 'manual' END;
