CREATE TABLE "insulin_events" (
	"at" timestamp with time zone NOT NULL,
	"date" text NOT NULL,
	"kind" text NOT NULL,
	"units" real NOT NULL,
	"bolus_type" text,
	"carbs" real,
	"bg" real,
	"requested" real,
	CONSTRAINT "insulin_events_at_kind_pk" PRIMARY KEY("at","kind")
);
--> statement-breakpoint
CREATE TABLE "pump_glucose" (
	"at" timestamp with time zone PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"mgdl" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_auth" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"username" text NOT NULL,
	"secret" text NOT NULL,
	"region" text DEFAULT 'US' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workouts" ADD COLUMN "distance_km" real;--> statement-breakpoint
CREATE INDEX "insulin_events_date_idx" ON "insulin_events" USING btree ("date");--> statement-breakpoint
CREATE INDEX "pump_glucose_date_idx" ON "pump_glucose" USING btree ("date");