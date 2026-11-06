CREATE TABLE "flow_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#2f73e0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_node_stats" (
	"flow_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"entries" integer DEFAULT 0 NOT NULL,
	"advances" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "flow_node_stats_flow_id_node_id_pk" PRIMARY KEY("flow_id","node_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "bot_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "share_code" text;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "checkout_url" text;--> statement-breakpoint
ALTER TABLE "flow_folders" ADD CONSTRAINT "flow_folders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_node_stats" ADD CONSTRAINT "flow_node_stats_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_folders_account_idx" ON "flow_folders" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_folder_id_flow_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."flow_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_runs_contact_status_idx" ON "flow_runs" USING btree ("contact_id","status");--> statement-breakpoint
UPDATE "flow_runs" SET "status" = 'error', "finished_at" = now() WHERE "status" = 'running';--> statement-breakpoint
UPDATE "flow_runs" r SET "status" = 'canceled', "finished_at" = now() WHERE r."status" IN ('waiting','waiting_input','waiting_payment') AND EXISTS (SELECT 1 FROM "flow_runs" r2 WHERE r2."flow_id" = r."flow_id" AND r2."contact_id" = r."contact_id" AND r2."status" IN ('waiting','waiting_input','waiting_payment') AND (r2."started_at" > r."started_at" OR (r2."started_at" = r."started_at" AND r2."id" > r."id")));--> statement-breakpoint
CREATE UNIQUE INDEX "flow_runs_active_uq" ON "flow_runs" USING btree ("flow_id","contact_id") WHERE status in ('running','waiting','waiting_input','waiting_payment');--> statement-breakpoint
CREATE INDEX "flows_folder_idx" ON "flows" USING btree ("folder_id");--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_share_code_unique" UNIQUE("share_code");