CREATE TABLE "sync_status" (
	"source" text PRIMARY KEY NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "date_label" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "daily_report_prompt" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "weekly_report_prompt" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "monthly_report_prompt" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chats_report_per_day_uq" ON "chats" USING btree ("kind","date_label") WHERE "chats"."kind" <> 'chat';