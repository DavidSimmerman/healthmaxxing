CREATE TABLE "activity_days" (
	"date" text PRIMARY KEY NOT NULL,
	"active_kcal" real,
	"basal_kcal" real,
	"steps" integer,
	"exercise_min" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "body_comp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hk_uuid" text NOT NULL,
	"measured_at" timestamp NOT NULL,
	"weight_kg" real NOT NULL,
	"body_fat_pct" real,
	"lean_mass_kg" real,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "body_comp_hk_uuid_unique" UNIQUE("hk_uuid")
);
--> statement-breakpoint
CREATE INDEX "body_comp_measured_at_idx" ON "body_comp" USING btree ("measured_at");