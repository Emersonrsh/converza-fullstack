-- Converza Members: módulos liberados conforme o valor pago
ALTER TABLE "member_pending_unlocks" ADD COLUMN IF NOT EXISTS "min_amount" numeric(12, 2);
