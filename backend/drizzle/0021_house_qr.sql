ALTER TABLE "subscriptions" ADD COLUMN "house" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "provider" text DEFAULT 'cloud' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "web_state" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wa_web_auth" (
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key_id" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_web_auth_connection_id_kind_key_id_pk" PRIMARY KEY("connection_id","kind","key_id")
);--> statement-breakpoint
ALTER TABLE "wa_web_auth" ADD CONSTRAINT "wa_web_auth_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wa_web_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"mime" text NOT NULL,
	"file_name" text,
	"size" integer NOT NULL,
	"data" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "wa_web_media" ADD CONSTRAINT "wa_web_media_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_web_media_created_idx" ON "wa_web_media" USING btree ("created_at");
