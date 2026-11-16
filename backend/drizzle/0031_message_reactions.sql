-- Reações às mensagens no Chats ao vivo (do cliente e da equipe)
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "reactions" jsonb DEFAULT '{}'::jsonb NOT NULL;
