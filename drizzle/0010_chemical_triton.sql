CREATE TABLE "daily_metrics" (
	"date" text NOT NULL,
	"metric" text NOT NULL,
	"value" real NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_metrics_date_metric_pk" PRIMARY KEY("date","metric")
);
--> statement-breakpoint
CREATE TABLE "workouts" (
	"hk_uuid" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"kcal" real,
	"avg_hr" real,
	"max_hr" real,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workouts_started_at_idx" ON "workouts" USING btree ("started_at");