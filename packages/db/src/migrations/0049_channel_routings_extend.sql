-- Task 8: Add config column and channel check constraint to channel_routings
ALTER TABLE "channel_routings" ADD COLUMN IF NOT EXISTS "config" jsonb;
--> statement-breakpoint
ALTER TABLE "channel_routings" ADD CONSTRAINT "channel_routings_channel_check"
  CHECK (channel IN ('telegram', 'discord', 'slack'));
