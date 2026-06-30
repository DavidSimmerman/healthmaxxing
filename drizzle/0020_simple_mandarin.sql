ALTER TABLE "daily_log" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Scheduled meals are now just pending daily_log rows. Carry any existing
-- planned_meals over (logged_at = their scheduled time, pending=true) before dropping.
INSERT INTO "daily_log" ("food_id", "servings", "amount", "unit", "logged_at", "pending", "calories", "protein_g", "carbs_g", "fat_g")
SELECT "food_id", "servings", "amount", "unit", "scheduled_at", true, "calories", "protein_g", "carbs_g", "fat_g"
FROM "planned_meals";--> statement-breakpoint
DROP TABLE "planned_meals" CASCADE;
