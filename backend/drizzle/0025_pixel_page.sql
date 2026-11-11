-- Página do Facebook do pixel (anúncios de clique para o WhatsApp em conexões sem WABA)
ALTER TABLE "pixels" ADD COLUMN IF NOT EXISTS "page_id" text;
