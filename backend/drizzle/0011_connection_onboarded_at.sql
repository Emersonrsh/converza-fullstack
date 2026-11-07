ALTER TABLE "connections" ADD COLUMN "onboarded_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "connections" SET "onboarded_at" = "created_at";
