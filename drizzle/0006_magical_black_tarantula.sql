ALTER TABLE "foods" ADD COLUMN "ingredients" jsonb;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "makes_servings" real;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "total_grams" real;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "archived_at" timestamp;