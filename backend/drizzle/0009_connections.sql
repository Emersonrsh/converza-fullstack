ALTER TABLE "connections" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "verified_name" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "name_status" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "quality_rating" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "messaging_limit" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "phone_status" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "throughput" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "code_verification" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "coexistence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_subscribed" boolean;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "pin" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "sync_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "history_progress" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "via" text;--> statement-breakpoint
UPDATE "connections" c SET "last_inbound_at" = x.at
FROM (SELECT v."connection_id", max(m."created_at") AS at FROM "messages" m JOIN "conversations" v ON v."id" = m."conversation_id"
      WHERE m."direction" = 'in' AND v."connection_id" IS NOT NULL GROUP BY v."connection_id") x
WHERE x."connection_id" = c."id";
