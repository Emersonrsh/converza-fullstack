-- produto: moeda e faixa de preço (o "price" continua sendo o valor padrão)
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'BRL' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "min_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "max_price" numeric(12, 2);
