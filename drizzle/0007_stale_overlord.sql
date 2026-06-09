ALTER TABLE "foods" ADD COLUMN "overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "source_macros" jsonb;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "source_checked_at" timestamp;--> statement-breakpoint
-- Backfill: existing rows predate source-tracking, so there's no baseline to
-- tell a hand-corrected value from a merely stale one — and a row corrected via
-- an older prepFood path can still read source = 'off'. Mark them ALL as
-- overrides: the first scan then records a baseline WITHOUT overwriting, and only
-- a genuine later source change prompts. New rows get an accurate flag (OFF
-- inserts = not overridden; curated/manual entries = overridden).
UPDATE "foods" SET "overridden" = true;