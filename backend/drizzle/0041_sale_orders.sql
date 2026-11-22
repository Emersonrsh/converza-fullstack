-- Vendas agrupadas em pedidos: compras do mesmo contato no mesmo fluxo (inclui o fluxo de upsell
-- aberto por "ir para fluxo") contam como 1 venda; o faturamento soma todas.
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "flow_id" uuid REFERENCES "flows"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "journey_flow_id" uuid REFERENCES "flows"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "order_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_order_lookup_idx" ON "sales" ("account_id", "contact_id", "journey_flow_id", "created_at");
--> statement-breakpoint
-- histórico: venda feita pelo bloco do fluxo traz a execução no external_id (flow-<run>-…)
UPDATE "sales" s SET "flow_id" = r.flow_id, "journey_flow_id" = coalesce(nullif(r.context->>'journeyFlowId', '')::uuid, r.flow_id)
FROM "flow_runs" r
WHERE s.flow_id IS NULL AND s.external_id ~ '^flow-[0-9a-f-]{36}-' AND r.id = substring(s.external_id from 6 for 36)::uuid;
--> statement-breakpoint
-- demais vendas com contato: o fluxo que o contato estava fazendo (começado até 7 dias antes da venda)
WITH pick AS (
  SELECT s.id AS sale_id, (
    SELECT fr.id FROM "flow_runs" fr
    WHERE fr.contact_id = s.contact_id AND fr.started_at <= s.created_at AND fr.started_at > s.created_at - interval '7 days'
    ORDER BY fr.started_at DESC LIMIT 1
  ) AS run_id
  FROM "sales" s WHERE s.flow_id IS NULL AND s.contact_id IS NOT NULL
)
UPDATE "sales" s SET "flow_id" = r.flow_id, "journey_flow_id" = coalesce(nullif(r.context->>'journeyFlowId', '')::uuid, r.flow_id)
FROM pick JOIN "flow_runs" r ON r.id = pick.run_id
WHERE s.id = pick.sale_id;
--> statement-breakpoint
UPDATE "sales" s SET "order_id" = coalesce((
  SELECT s2.id FROM "sales" s2
  WHERE s2.account_id = s.account_id AND s2.contact_id = s.contact_id AND s2.journey_flow_id = s.journey_flow_id
    AND s2.status = 'approved' AND s2.created_at <= s.created_at AND s2.created_at > s.created_at - interval '7 days'
  ORDER BY s2.created_at ASC, s2.id ASC LIMIT 1
), s.id)
WHERE s.order_id IS NULL;
