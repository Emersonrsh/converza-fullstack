ALTER TABLE "conversations" ADD COLUMN "ai_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ai_agent_id_agents_id_fk" FOREIGN KEY ("ai_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_node_stats" ADD COLUMN "rr" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flow_distributions" (
	"flow_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"output_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_distributions_flow_id_node_id_contact_id_pk" PRIMARY KEY("flow_id","node_id","contact_id")
);--> statement-breakpoint
ALTER TABLE "flow_distributions" ADD CONSTRAINT "flow_distributions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_distributions" ADD CONSTRAINT "flow_distributions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
