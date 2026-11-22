-- Cópia do fluxo antes de cada troca de grafo feita pelo MCP (para desfazer)
CREATE TABLE IF NOT EXISTS "flow_backups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "flow_id" uuid NOT NULL REFERENCES "flows"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "graph" jsonb NOT NULL,
  "source" text DEFAULT 'mcp' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_backups_flow_idx" ON "flow_backups" ("flow_id", "created_at");
