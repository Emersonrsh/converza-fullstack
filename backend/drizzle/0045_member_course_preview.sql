-- imagem da prévia do link (1200×628) de cada curso, separada da capa vertical
ALTER TABLE "member_courses" ADD COLUMN IF NOT EXISTS "preview_key" text;
