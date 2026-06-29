CREATE TABLE "planned_meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"food_id" uuid NOT NULL,
	"servings" real DEFAULT 1 NOT NULL,
	"amount" real,
	"unit" text,
	"scheduled_at" timestamp NOT NULL,
	"calories" real NOT NULL,
	"protein_g" real NOT NULL,
	"carbs_g" real NOT NULL,
	"fat_g" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "planned_meals" ADD CONSTRAINT "planned_meals_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planned_meals_scheduled_at_idx" ON "planned_meals" USING btree ("scheduled_at");