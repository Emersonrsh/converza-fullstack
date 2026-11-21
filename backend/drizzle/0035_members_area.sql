-- Converza Members: área de membros de cada empresa (cursos em PDF)
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "members_slug" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_members_slug_idx" ON "accounts" ("members_slug") WHERE "members_slug" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_courses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "cover_key" text,
  "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "published" boolean DEFAULT false NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_courses_account_idx" ON "member_courses" ("account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_modules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "course_id" uuid NOT NULL REFERENCES "member_courses"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "cover_key" text,
  "sort" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_modules_course_idx" ON "member_modules" ("course_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_lessons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "course_id" uuid NOT NULL REFERENCES "member_courses"("id") ON DELETE CASCADE,
  "module_id" uuid NOT NULL REFERENCES "member_modules"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "file_key" text,
  "file_name" text,
  "file_size" integer,
  "sort" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_lessons_module_idx" ON "member_lessons" ("module_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "email" text,
  "phone" text,
  "name" text,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
  "password_hash" text,
  "password_changed_at" timestamp with time zone,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_users_email_idx" ON "member_users" ("account_id", lower("email")) WHERE "email" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_users_phone_idx" ON "member_users" ("account_id", "phone") WHERE "phone" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_access" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "member_id" uuid NOT NULL REFERENCES "member_users"("id") ON DELETE CASCADE,
  "course_id" uuid NOT NULL REFERENCES "member_courses"("id") ON DELETE CASCADE,
  "source" text DEFAULT 'sale' NOT NULL,
  "sale_id" uuid REFERENCES "sales"("id") ON DELETE SET NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_access_unique_idx" ON "member_access" ("member_id", "course_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_progress" (
  "member_id" uuid NOT NULL REFERENCES "member_users"("id") ON DELETE CASCADE,
  "lesson_id" uuid NOT NULL REFERENCES "member_lessons"("id") ON DELETE CASCADE,
  "completed_at" timestamp with time zone,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("member_id", "lesson_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "member_id" uuid NOT NULL REFERENCES "member_users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_tokens_hash_idx" ON "member_tokens" ("token_hash");
