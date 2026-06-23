CREATE TABLE "fitbit_auth" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"refresh_token" text NOT NULL,
	"scope" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
