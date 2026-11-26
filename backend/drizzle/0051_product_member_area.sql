-- endereço próprio da área de membros por produto
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "members_slug" text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "members_course_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "products_members_slug_unique" ON "products" ("members_slug");
