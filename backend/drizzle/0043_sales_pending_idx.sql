-- verificação periódica das cobranças pendentes (InfinitePay/XPag): consulta só as pendentes
CREATE INDEX IF NOT EXISTS "sales_pending_created_idx" ON "sales" ("created_at") WHERE "status" = 'pending';
