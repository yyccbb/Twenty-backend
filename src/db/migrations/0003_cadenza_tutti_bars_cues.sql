-- Spec update 2026-10-27: events become Cadenzas or Tuttis, a slot is now a bar, a reminder is now a cue.
-- Renames keep existing data. Hand-written because drizzle-kit can't generate renames non-interactively.

-- Events: `kind` replaces `rewardable`. Every old event was timed, so events that were started (or were
-- rewardable) become Cadenzas; planned or cancelled non-rewardable events become Tuttis.
CREATE TYPE "public"."event_kind" AS ENUM('cadenza', 'tutti');--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "kind" "event_kind" DEFAULT 'cadenza' NOT NULL;--> statement-breakpoint
UPDATE "events" SET "kind" = 'tutti' WHERE NOT "rewardable" AND "status" IN ('planned', 'cancelled');--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "rewardable";--> statement-breakpoint
ALTER TABLE "events" RENAME COLUMN "duration_slots" TO "duration_bars";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tutti_status" CHECK ("events"."kind" = 'cadenza' OR "events"."status" IN ('planned', 'cancelled'));--> statement-breakpoint

ALTER TABLE "event_records" RENAME COLUMN "late_slots" TO "late_bars";--> statement-breakpoint
ALTER TABLE "event_records" RENAME COLUMN "early_slots" TO "early_bars";--> statement-breakpoint
ALTER TABLE "event_records" RENAME COLUMN "extended_slots" TO "extended_bars";--> statement-breakpoint
ALTER TABLE "event_changes" RENAME COLUMN "delta_slots" TO "delta_bars";--> statement-breakpoint

ALTER TABLE "reward_rules" RENAME COLUMN "tokens_per_slot" TO "tokens_per_bar";--> statement-breakpoint
ALTER TABLE "reward_rules" RENAME COLUMN "early_slot_rate" TO "early_bar_rate";--> statement-breakpoint
ALTER TABLE "reward_rules" RENAME COLUMN "extended_slot_rate" TO "extended_bar_rate";--> statement-breakpoint
ALTER TABLE "reward_rules" RENAME COLUMN "auto_finish_deduction_slots" TO "auto_finish_deduction_bars";--> statement-breakpoint

-- Stored AI breakdown items are sized in bars too.
UPDATE "ai_breakdowns"
SET "result" = jsonb_set("result", '{items}', (
  SELECT COALESCE(jsonb_agg((item - 'duration_slots') || jsonb_build_object('duration_bars', item -> 'duration_slots') ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements("result" -> 'items') WITH ORDINALITY AS t(item, ord)
))
WHERE "result" ? 'items';--> statement-breakpoint

-- Reminders become cues.
ALTER TABLE "reminders" RENAME TO "cues";--> statement-breakpoint
ALTER TABLE "cues" RENAME CONSTRAINT "reminders_pkey" TO "cues_pkey";--> statement-breakpoint
ALTER TABLE "cues" RENAME CONSTRAINT "reminders_user_id_users_id_fk" TO "cues_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "reminders_user_idx" RENAME TO "cues_user_idx";--> statement-breakpoint
ALTER INDEX "reminders_series_idx" RENAME TO "cues_series_idx";--> statement-breakpoint
ALTER TABLE "reminder_occurrences" RENAME TO "cue_occurrences";--> statement-breakpoint
ALTER TABLE "cue_occurrences" RENAME COLUMN "reminder_id" TO "cue_id";--> statement-breakpoint
ALTER TABLE "cue_occurrences" RENAME COLUMN "detached_reminder_id" TO "detached_cue_id";--> statement-breakpoint
ALTER TABLE "cue_occurrences" RENAME CONSTRAINT "reminder_occurrences_reminder_id_original_at_pk" TO "cue_occurrences_cue_id_original_at_pk";--> statement-breakpoint
ALTER TABLE "cue_occurrences" RENAME CONSTRAINT "reminder_occurrences_reminder_id_reminders_id_fk" TO "cue_occurrences_cue_id_cues_id_fk";--> statement-breakpoint
ALTER INDEX "reminder_occurrences_new_at_idx" RENAME TO "cue_occurrences_new_at_idx";
