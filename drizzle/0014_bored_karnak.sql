CREATE TABLE "sleep_stages" (
	"date" text PRIMARY KEY NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"segments" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
