-- link curto da área de membros (converza.pro/e/<código>): o curso fica no próprio link
ALTER TABLE "member_tokens" ADD COLUMN IF NOT EXISTS "course_id" uuid;
CREATE INDEX IF NOT EXISTS "member_tokens_hash_idx" ON "member_tokens" ("token_hash");
