-- Converza Members: aula em link (vídeo, Drive, página) em vez de PDF
ALTER TABLE "member_lessons" ADD COLUMN IF NOT EXISTS "link_url" text;
