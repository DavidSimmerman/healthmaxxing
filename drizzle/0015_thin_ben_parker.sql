CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"period" text,
	"range_from" text,
	"range_to" text,
	"tag" text
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "notes" text;--> statement-breakpoint
CREATE INDEX "reports_created_at_idx" ON "reports" USING btree ("created_at");