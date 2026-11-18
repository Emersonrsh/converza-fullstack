-- Não lidas: conversa cuja última mensagem (fora as notas internas) já foi uma resposta enviada deixa de contar
UPDATE "conversations" c SET "unread_count" = 0
WHERE c."unread_count" > 0 AND EXISTS (
  SELECT 1 FROM (
    SELECT m."direction", m."status" FROM "messages" m
    WHERE m."conversation_id" = c."id" AND m."type"::text <> 'note'
    ORDER BY m."created_at" DESC LIMIT 1
  ) last WHERE last."direction" = 'out' AND last."status" <> 'failed'
);
