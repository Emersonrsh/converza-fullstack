-- Disparos antigos (só texto, sem fluxo) não rodam no motor novo: ficam no histórico e nunca são reenviados.
UPDATE "campaigns" SET
  "status" = CASE WHEN "status" = 'sending' AND "sent_count" >= "total_count" AND "total_count" > 0 THEN 'done'::campaign_status ELSE 'canceled'::campaign_status END,
  "started_at" = coalesce("started_at", "created_at"),
  "finished_at" = coalesce("finished_at", now()),
  "updated_at" = now()
WHERE "flow_id" IS NULL AND "status" IN ('draft', 'scheduled', 'sending');
--> statement-breakpoint
UPDATE "campaigns" SET "started_at" = coalesce("started_at", "created_at"), "finished_at" = coalesce("finished_at", "created_at")
WHERE "flow_id" IS NULL AND "status" IN ('done', 'canceled');
