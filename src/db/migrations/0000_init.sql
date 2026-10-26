CREATE TYPE "public"."breakdown_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."event_change_kind" AS ENUM('extend', 'cascade_shift', 'early_start');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('planned', 'in_progress', 'done', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."finish_kind" AS ENUM('on_time', 'shortened', 'auto', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'achieved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('event_reward', 'badge_redeem', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('done', 'skipped', 'snoozed', 'moved', 'cancelled');--> statement-breakpoint
CREATE TABLE "ai_breakdowns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"goal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "breakdown_status" DEFAULT 'queued' NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"tokens_used" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cost" integer NOT NULL,
	"image_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "badges_code_unique" UNIQUE("code"),
	CONSTRAINT "badges_cost_non_negative" CHECK ("badges"."cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "event_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "event_change_kind" NOT NULL,
	"delta_slots" integer NOT NULL,
	"caused_by_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_records" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"start_tapped_at" timestamp with time zone,
	"finish_tapped_at" timestamp with time zone,
	"recorded_start" timestamp with time zone,
	"recorded_end" timestamp with time zone,
	"late_slots" integer DEFAULT 0 NOT NULL,
	"early_slots" integer DEFAULT 0 NOT NULL,
	"extended_slots" integer DEFAULT 0 NOT NULL,
	"finish_kind" "finish_kind",
	"tokens_awarded" integer,
	"original_planned_start" timestamp with time zone NOT NULL,
	"original_planned_end" timestamp with time zone NOT NULL,
	"rules_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"goal_id" uuid,
	"breakdown_item_id" uuid,
	"planned_start" timestamp with time zone NOT NULL,
	"duration_slots" integer NOT NULL,
	"rewardable" boolean DEFAULT true NOT NULL,
	"status" "event_status" DEFAULT 'planned' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_duration_positive" CHECK ("events"."duration_slots" >= 1),
	CONSTRAINT "events_start_on_grid" CHECK ((extract(epoch from "events"."planned_start")::bigint % 1200) = 0)
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"target_date" date,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reminder_occurrences" (
	"reminder_id" uuid NOT NULL,
	"original_at" timestamp with time zone NOT NULL,
	"status" "occurrence_status" NOT NULL,
	"new_at" timestamp with time zone,
	"detached_reminder_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_occurrences_reminder_id_original_at_pk" PRIMARY KEY("reminder_id","original_at")
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"dtstart" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"rrule" text,
	"until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_rules" (
	"version" integer PRIMARY KEY NOT NULL,
	"tokens_per_slot" integer NOT NULL,
	"early_slot_rate" numeric(5, 4) NOT NULL,
	"extended_slot_rate" numeric(5, 4) NOT NULL,
	"auto_finish_deduction_slots" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_rules_even_value" CHECK ("reward_rules"."tokens_per_slot" > 0 AND "reward_rules"."tokens_per_slot" % 2 = 0)
);
--> statement-breakpoint
CREATE TABLE "token_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"ref_id" uuid,
	"rules_version" integer,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_badges" (
	"user_id" uuid NOT NULL,
	"badge_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_badges_user_id_badge_id_pk" PRIMARY KEY("user_id","badge_id")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"planning_prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"day_end_local_time" time DEFAULT '00:00' NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"apple_sub" text,
	"display_name" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"token_balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_apple_sub_unique" UNIQUE("apple_sub")
);
--> statement-breakpoint
ALTER TABLE "ai_breakdowns" ADD CONSTRAINT "ai_breakdowns_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_breakdowns" ADD CONSTRAINT "ai_breakdowns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_changes" ADD CONSTRAINT "event_changes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_records" ADD CONSTRAINT "event_records_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_ledger_entry_id_token_ledger_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."token_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_breakdowns_user_created_idx" ON "ai_breakdowns" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "event_changes_event_idx" ON "event_changes" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_user_planned_start_idx" ON "events" USING btree ("user_id","planned_start");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status","planned_start");--> statement-breakpoint
CREATE INDEX "goals_user_idx" ON "goals" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reminder_occurrences_new_at_idx" ON "reminder_occurrences" USING btree ("new_at");--> statement-breakpoint
CREATE INDEX "reminders_user_idx" ON "reminders" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "reminders_series_idx" ON "reminders" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "token_ledger_idempotency_key_uq" ON "token_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "token_ledger_user_created_idx" ON "token_ledger" USING btree ("user_id","created_at");