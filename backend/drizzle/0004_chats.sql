ALTER TYPE "public"."message_type" ADD VALUE 'note';--> statement-breakpoint
ALTER TYPE "public"."message_type" ADD VALUE 'location';--> statement-breakpoint
ALTER TYPE "public"."message_type" ADD VALUE 'sticker';--> statement-breakpoint
ALTER TYPE "public"."message_type" ADD VALUE 'contacts';--> statement-breakpoint
ALTER TYPE "public"."message_type" ADD VALUE 'unsupported';--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"shortcut" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "wa_media_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quick_replies_account_shortcut_uq" ON "quick_replies" USING btree ("account_id","shortcut");--> statement-breakpoint
CREATE INDEX "conversations_account_last_idx" ON "conversations" USING btree ("account_id","last_message_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");