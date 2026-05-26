CREATE TABLE "daily_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"food_id" uuid NOT NULL,
	"servings" real DEFAULT 1 NOT NULL,
	"logged_at" timestamp DEFAULT now() NOT NULL,
	"calories" real NOT NULL,
	"protein_g" real NOT NULL,
	"carbs_g" real NOT NULL,
	"fat_g" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"barcode" text,
	"serving_size" text,
	"serving_grams" real,
	"calories" real NOT NULL,
	"protein_g" real NOT NULL,
	"carbs_g" real NOT NULL,
	"fat_g" real NOT NULL,
	"source" text NOT NULL,
	"source_payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "foods_barcode_unique" UNIQUE("barcode")
);
--> statement-breakpoint
CREATE TABLE "pending_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"barcode" text,
	"image_path" text,
	"text" text,
	"servings" real DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_food_id" uuid,
	"resolver_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "quick_adds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"food_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"calorie_target" integer DEFAULT 2100 NOT NULL,
	"protein_target_g" integer DEFAULT 180 NOT NULL,
	"carbs_target_g" integer DEFAULT 220 NOT NULL,
	"fat_target_g" integer DEFAULT 70 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_log" ADD CONSTRAINT "daily_log_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_items" ADD CONSTRAINT "pending_items_resolved_food_id_foods_id_fk" FOREIGN KEY ("resolved_food_id") REFERENCES "public"."foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_adds" ADD CONSTRAINT "quick_adds_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_log_logged_at_idx" ON "daily_log" USING btree ("logged_at");--> statement-breakpoint
CREATE INDEX "foods_barcode_idx" ON "foods" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "foods_name_idx" ON "foods" USING btree ("name");--> statement-breakpoint
CREATE INDEX "pending_status_idx" ON "pending_items" USING btree ("status");