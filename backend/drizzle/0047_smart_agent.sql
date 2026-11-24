-- Automatização inteligente: agente da conta, escondido da aba Agentes de IA
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'custom' NOT NULL;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "support_department_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "agents_one_smart_per_account" ON "agents" ("account_id") WHERE "kind" = 'smart';
