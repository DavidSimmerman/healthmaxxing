CREATE TABLE "pump_glucose" (
	"at" timestamp with time zone PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"mgdl" real NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pump_glucose_date_idx" ON "pump_glucose" USING btree ("date");