CREATE TABLE "ad_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"platform" text DEFAULT 'meta' NOT NULL,
	"campaign_name" text,
	"campaign_id" text,
	"ad_account_id" text,
	"origin" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "referred_by" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ctwa_clid" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cost" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "webhook_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "currency" text DEFAULT 'BRL' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "cost" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "origin" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "invoice_url" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "invoice_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_spend_account_date_idx" ON "ad_spend" USING btree ("account_id","date");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_referred_by_accounts_id_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_first_connection_id_connections_id_fk" FOREIGN KEY ("first_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_account_created_idx" ON "contacts" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_account_created_idx" ON "sales" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_account_external_uq" ON "sales" USING btree ("account_id","external_id") WHERE external_id is not null;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_referral_code_unique" UNIQUE("referral_code");--> statement-breakpoint
-- conexão por onde cada lead chegou primeiro
UPDATE "contacts" c SET "first_connection_id" = (
  SELECT v."connection_id" FROM "conversations" v
  WHERE v."contact_id" = c."id" AND v."connection_id" IS NOT NULL
  ORDER BY v."created_at" ASC LIMIT 1
) WHERE c."first_connection_id" IS NULL;--> statement-breakpoint
-- dados do cliente e do produto nas vendas antigas
UPDATE "sales" s SET "customer_name" = c."name", "customer_phone" = c."phone"
FROM "contacts" c WHERE s."contact_id" = c."id" AND s."customer_name" IS NULL;--> statement-breakpoint
UPDATE "sales" s SET "product_name" = p."name", "cost" = p."cost"
FROM "products" p WHERE s."product_id" = p."id" AND s."product_name" IS NULL;--> statement-breakpoint
UPDATE "sales" s SET "connection_id" = (
  SELECT v."connection_id" FROM "conversations" v
  WHERE v."contact_id" = s."contact_id" AND v."connection_id" IS NOT NULL
  ORDER BY v."last_message_at" DESC LIMIT 1
) WHERE s."connection_id" IS NULL AND s."contact_id" IS NOT NULL;--> statement-breakpoint
-- estado (UF) pelo DDD do telefone
WITH ddd_uf(ddd, uf) AS (VALUES ('11','SP'),('12','SP'),('13','SP'),('14','SP'),('15','SP'),('16','SP'),('17','SP'),('18','SP'),('19','SP'),('21','RJ'),('22','RJ'),('24','RJ'),('27','ES'),('28','ES'),('31','MG'),('32','MG'),('33','MG'),('34','MG'),('35','MG'),('37','MG'),('38','MG'),('41','PR'),('42','PR'),('43','PR'),('44','PR'),('45','PR'),('46','PR'),('47','SC'),('48','SC'),('49','SC'),('51','RS'),('53','RS'),('54','RS'),('55','RS'),('61','DF'),('62','GO'),('64','GO'),('63','TO'),('65','MT'),('66','MT'),('67','MS'),('68','AC'),('69','RO'),('71','BA'),('73','BA'),('74','BA'),('75','BA'),('77','BA'),('79','SE'),('81','PE'),('87','PE'),('82','AL'),('83','PB'),('84','RN'),('85','CE'),('88','CE'),('86','PI'),('89','PI'),('91','PA'),('93','PA'),('94','PA'),('92','AM'),('97','AM'),('95','RR'),('96','AP'),('98','MA'),('99','MA')),
src AS (
  SELECT s."id", regexp_replace(coalesce(s."customer_phone", ''), '[^0-9]', '', 'g') AS d
  FROM "sales" s WHERE s."state" IS NULL
),
dd AS (
  SELECT "id", CASE
    WHEN d ~ '^55[0-9]{10,11}$' THEN substring(d from 3 for 2)
    WHEN d ~ '^[0-9]{10,11}$' THEN substring(d from 1 for 2)
  END AS ddd FROM src
)
UPDATE "sales" SET "state" = ddd_uf.uf FROM dd JOIN ddd_uf ON ddd_uf.ddd = dd.ddd WHERE "sales"."id" = dd."id";
