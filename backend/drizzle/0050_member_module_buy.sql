-- Converza Members: comprar o módulo bloqueado pela área de membros
ALTER TABLE "member_modules" ADD COLUMN IF NOT EXISTS "buy_price" numeric(12, 2);
ALTER TABLE "member_modules" ADD COLUMN IF NOT EXISTS "buy_url" text;
