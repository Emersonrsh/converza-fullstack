-- Mensagem de "Venda aprovada" escolhida por cada pessoa em cada empresa (título e texto com variáveis)
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "push_sale_template" jsonb;
