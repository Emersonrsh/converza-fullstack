ALTER TABLE "webhook_events" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "webhook_events_dedupe_idx" ON "webhook_events" USING btree ("webhook_id","dedupe_key");