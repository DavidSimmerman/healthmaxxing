CREATE TABLE "dexcom_auth" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"refresh_token" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glucose_readings" (
	"at" timestamp with time zone PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"mgdl" real NOT NULL,
	"trend" text
);
--> statement-breakpoint
CREATE INDEX "glucose_readings_date_idx" ON "glucose_readings" USING btree ("date");