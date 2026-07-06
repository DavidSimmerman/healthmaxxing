CREATE TABLE "vacations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from" text NOT NULL,
	"to" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
