CREATE TABLE "vital_samples" (
	"metric" text NOT NULL,
	"at" timestamp NOT NULL,
	"value" real NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "vital_samples_metric_source_at_pk" PRIMARY KEY("metric","source","at")
);
--> statement-breakpoint
ALTER TABLE "workouts" ADD COLUMN "detail" jsonb;--> statement-breakpoint
CREATE INDEX "vital_samples_at_idx" ON "vital_samples" USING btree ("at");