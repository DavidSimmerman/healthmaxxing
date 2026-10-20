ALTER TABLE "settings" ADD COLUMN "tracking_start_date" text;--> statement-breakpoint
-- One-time: David restarts careful logging on 2026-10-21 after a long break. Editable on /settings.
UPDATE "settings" SET "tracking_start_date" = '2026-10-21' WHERE "id" = 1;