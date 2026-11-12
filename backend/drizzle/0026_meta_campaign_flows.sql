-- Campanha da Meta ligada a um fluxo (leads dos anúncios dela começam nesse fluxo)
CREATE TABLE IF NOT EXISTS "meta_campaign_flows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "act_id" text NOT NULL,
  "campaign_id" text NOT NULL,
  "flow_id" uuid NOT NULL REFERENCES "flows"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meta_campaign_flows_uq" ON "meta_campaign_flows" ("account_id", "campaign_id");
