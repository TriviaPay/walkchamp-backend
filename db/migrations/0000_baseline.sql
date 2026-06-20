CREATE TYPE "public"."account_status" AS ENUM('active', 'pending_verification', 'suspended', 'banned', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('not_required', 'required', 'pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."wallet_transaction_status" AS ENUM('pending', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."wallet_transaction_type" AS ENUM('race_entry_payment', 'race_entry_wallet_debit', 'race_entry_refund', 'race_prize_pending', 'race_prize_approved', 'race_prize_paid', 'withdrawal_requested', 'withdrawal_approved', 'withdrawal_rejected', 'promo_discount', 'referral_credit', 'sponsored_reward', 'manual_adjustment');--> statement-breakpoint
CREATE TYPE "public"."entry_type" AS ENUM('free', 'paid_1', 'paid_3', 'paid_5', 'paid_usd', 'coins_battle');--> statement-breakpoint
CREATE TYPE "public"."participant_status" AS ENUM('joined', 'active', 'completed', 'disqualified', 'left', 'forfeited');--> statement-breakpoint
CREATE TYPE "public"."race_status" AS ENUM('open', 'full', 'in_progress', 'completed', 'cancelled', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."race_type" AS ENUM('quick', 'endurance', 'country_battle', 'friends', 'sponsored');--> statement-breakpoint
CREATE TYPE "public"."room_invite_status" AS ENUM('pending', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."discount_type" AS ENUM('fixed', 'percent');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'requires_payment_method', 'processing', 'succeeded', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_type" AS ENUM('race_entry', 'wallet_topup', 'sponsored_event', 'other');--> statement-breakpoint
CREATE TYPE "public"."payout_method" AS ENUM('paypal', 'bank_transfer', 'upi', 'gift_card');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('pending', 'approved', 'rejected', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."chat_reaction_type" AS ENUM('global', 'private');--> statement-breakpoint
CREATE TYPE "public"."friend_request_direction" AS ENUM('sent', 'received');--> statement-breakpoint
CREATE TYPE "public"."friend_status" AS ENUM('pending', 'accepted', 'rejected', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."presence_status" AS ENUM('online', 'walking', 'racing', 'spectating', 'away', 'offline');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('race_invite', 'friend_request', 'friend_request_accepted', 'race_starting', 'race_started', 'race_completed', 'race_won', 'race_lost', 'reward_pending', 'reward_approved', 'reward_rejected', 'withdrawal_requested', 'withdrawal_approved', 'withdrawal_rejected', 'followed_player_started_race', 'country_battle_update', 'friend_daily_goal_completed');--> statement-breakpoint
CREATE TYPE "public"."push_notification_status" AS ENUM('sent', 'skipped_disabled', 'skipped_no_device', 'failed');--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"username" text NOT NULL,
	"date_of_birth" text,
	"age" integer,
	"country" text,
	"country_code" text,
	"country_flag" text,
	"region" text,
	"phone_number" text,
	"referral_code" text,
	"referred_by" text,
	"auth_provider" text DEFAULT 'email' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"terms_accepted" boolean DEFAULT false NOT NULL,
	"privacy_accepted" boolean DEFAULT false NOT NULL,
	"reward_disclaimer_accepted" boolean DEFAULT false NOT NULL,
	"fair_play_accepted" boolean DEFAULT false NOT NULL,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"is_adult" boolean DEFAULT false NOT NULL,
	"paid_race_enabled" boolean DEFAULT false NOT NULL,
	"withdrawals_enabled" boolean DEFAULT false NOT NULL,
	"kyc_status" "kyc_status" DEFAULT 'not_required' NOT NULL,
	"account_status" "account_status" DEFAULT 'pending_verification' NOT NULL,
	"fraud_score" integer DEFAULT 0 NOT NULL,
	"avatar_color" text DEFAULT '#00E676' NOT NULL,
	"avatar_url" text,
	"bio" text,
	"profile_completed" boolean DEFAULT false NOT NULL,
	"stripe_customer_id" text,
	"wallet_balance" integer DEFAULT 0 NOT NULL,
	"total_steps" integer DEFAULT 0 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"current_rank" integer DEFAULT 9999 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	"last_seen_at" timestamp,
	CONSTRAINT "profiles_email_unique" UNIQUE("email"),
	CONSTRAINT "profiles_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"transaction_type" "wallet_transaction_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" "wallet_transaction_status" DEFAULT 'pending' NOT NULL,
	"description" text NOT NULL,
	"source" text,
	"race_room_id" uuid,
	"challenge_id" uuid,
	"payment_id" uuid,
	"withdrawal_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"available_balance_cents" integer DEFAULT 0 NOT NULL,
	"pending_balance_cents" integer DEFAULT 0 NOT NULL,
	"withdrawable_balance_cents" integer DEFAULT 0 NOT NULL,
	"total_earned_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "race_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_room_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" "participant_status" DEFAULT 'joined' NOT NULL,
	"current_steps" integer DEFAULT 0 NOT NULL,
	"final_steps" integer,
	"rank" integer,
	"prize_amount_cents" integer DEFAULT 0 NOT NULL,
	"payment_id" uuid,
	"finished_goal" boolean DEFAULT false NOT NULL,
	"finished_at" timestamp with time zone,
	"finished_at_ms" bigint,
	"finish_rank" integer,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"race_baseline_steps" integer DEFAULT 0 NOT NULL,
	"latest_device_steps" integer,
	"last_step_sync_at" timestamp,
	"last_step_sequence_id" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" text NOT NULL,
	"title" text NOT NULL,
	"type" "race_type" DEFAULT 'quick' NOT NULL,
	"entry_type" "entry_type" DEFAULT 'free' NOT NULL,
	"entry_amount_cents" integer DEFAULT 0 NOT NULL,
	"target_steps" integer DEFAULT 5000 NOT NULL,
	"max_players" integer DEFAULT 10 NOT NULL,
	"current_players" integer DEFAULT 0 NOT NULL,
	"status" "race_status" DEFAULT 'open' NOT NULL,
	"country_code" text,
	"team_a_country" text,
	"team_a_country_code" text,
	"team_b_country" text,
	"team_b_country_code" text,
	"invite_code" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"prize_pool_cents" integer DEFAULT 0 NOT NULL,
	"winners_pool_cents" integer DEFAULT 0 NOT NULL,
	"platform_fee_cents" integer DEFAULT 0 NOT NULL,
	"coin_entry_amount" integer DEFAULT 0 NOT NULL,
	"coin_prize_pool" integer DEFAULT 0 NOT NULL,
	"coin_winners_pool" integer DEFAULT 0 NOT NULL,
	"coin_platform_fee" integer DEFAULT 0 NOT NULL,
	"rewards_processed" boolean DEFAULT false NOT NULL,
	"spectator_count" integer DEFAULT 0 NOT NULL,
	"goal_type" text DEFAULT 'daily' NOT NULL,
	"track_layout" text DEFAULT 'bg' NOT NULL,
	"reward_split_json" jsonb,
	"winner_count" integer DEFAULT 0 NOT NULL,
	"unawarded_amount_cents" integer DEFAULT 0 NOT NULL,
	"payout_finalized_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"schedule_type" text DEFAULT 'now' NOT NULL,
	"scheduled_start_at" timestamp,
	"challenge_duration_days" integer DEFAULT 0 NOT NULL,
	"challenge_end_at" timestamp,
	"registered_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "race_rooms_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "race_step_sync_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"step_source" text,
	"race_started_at" timestamp,
	"baseline_steps" integer,
	"latest_device_steps" integer,
	"calculated_progress" integer,
	"stored_progress" integer,
	"suspicious" boolean DEFAULT false NOT NULL,
	"reason" text,
	"device_time" timestamp,
	"server_time" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_room_id" uuid NOT NULL,
	"inviter_id" text NOT NULL,
	"invitee_id" text NOT NULL,
	"status" "room_invite_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_room_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_room_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL,
	"activated_at" timestamp,
	"cancelled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid,
	"stripe_event_id" text,
	"event_type" text NOT NULL,
	"raw_payload" jsonb,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_customer_id" text,
	"challenge_id" uuid,
	"race_room_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"payment_type" "payment_type" DEFAULT 'race_entry' NOT NULL,
	"idempotency_key" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payments_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id"),
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"discount_type" "discount_type" NOT NULL,
	"discount_value" integer NOT NULL,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "promo_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promo_code_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"payment_id" uuid,
	"discount_amount_cents" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"payout_method" "payout_method" NOT NULL,
	"payout_details" jsonb NOT NULL,
	"status" "withdrawal_status" DEFAULT 'pending' NOT NULL,
	"admin_notes" text,
	"review_notes" text,
	"reviewed_by" text,
	"reviewed_at" timestamp,
	"suspicious_reason" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	"paid_at" timestamp,
	"rejected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_daily_totals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"distance_meters" integer DEFAULT 0 NOT NULL,
	"calories_burned" integer DEFAULT 0 NOT NULL,
	"active_minutes" integer DEFAULT 0 NOT NULL,
	"goal" integer DEFAULT 10000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"distance_meters" integer DEFAULT 0 NOT NULL,
	"calories_burned" integer DEFAULT 0 NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"is_synced" boolean DEFAULT false NOT NULL,
	"source" text
);
--> statement-breakpoint
CREATE TABLE "user_step_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"source_name" text,
	"permission_status" text DEFAULT 'not_requested' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"setup_completed" boolean DEFAULT false NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_race_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"race_room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"country_flag" text DEFAULT '🏳️' NOT NULL,
	"avatar_color" text DEFAULT '#00E676' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_race_reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"race_room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"race_room_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"rank" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_results" (
	"id" text PRIMARY KEY NOT NULL,
	"race_room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rank" integer NOT NULL,
	"display_rank" integer,
	"steps" integer DEFAULT 0 NOT NULL,
	"prize_cents" integer DEFAULT 0 NOT NULL,
	"prize_coins" integer DEFAULT 0 NOT NULL,
	"is_tied" boolean DEFAULT false NOT NULL,
	"tie_group_id" text,
	"tie_group_size" integer DEFAULT 1 NOT NULL,
	"eligible_for_prize" boolean DEFAULT true NOT NULL,
	"goal_completed_at" timestamp with time zone,
	"goal_completed_at_ms" bigint,
	"status" text DEFAULT 'pending_verification' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message_reports" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"reported_by_user_id" text NOT NULL,
	"reported_user_id" text,
	"reason" text NOT NULL,
	"note" text,
	"message_snapshot" text,
	"message_created_at" timestamp with time zone,
	"conversation_id" text,
	"race_id" text,
	"room_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"auto_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_reactions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"message_type" "chat_reaction_type" NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user1_id" text NOT NULL,
	"user2_id" text NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_chat_messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"country_flag" text DEFAULT '🏳️' NOT NULL,
	"avatar_color" text DEFAULT '#00E676' NOT NULL,
	"text" text NOT NULL,
	"reply_to_id" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_chat_messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"text" text NOT NULL,
	"reply_to_id" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocked_users" (
	"id" text PRIMARY KEY NOT NULL,
	"blocker_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friend_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"sender_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"status" "friend_status" DEFAULT 'pending' NOT NULL,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friends" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"friend_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_presence" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" "presence_status" DEFAULT 'online' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_walk_activity_at" timestamp with time zone,
	"device_id" text
);
--> statement-breakpoint
CREATE TABLE "notification_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"onesignal_player_id" text NOT NULL,
	"platform" text DEFAULT 'unknown' NOT NULL,
	"device_model" text,
	"app_version" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "push_notification_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"notification_type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"onesignal_response" jsonb,
	"status" "push_notification_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"push_notifications_enabled" boolean DEFAULT true NOT NULL,
	"race_updates_enabled" boolean DEFAULT true NOT NULL,
	"invite_updates_enabled" boolean DEFAULT true NOT NULL,
	"reward_updates_enabled" boolean DEFAULT true NOT NULL,
	"chat_updates_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_notification_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "restricted_regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" text NOT NULL,
	"region_code" text,
	"restriction_type" text DEFAULT 'paid_races' NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "achievement_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"difficulty" text NOT NULL,
	"unlock_type" text NOT NULL,
	"target_value" integer,
	"leaderboard_scope" text,
	"time_period" text,
	"icon" text,
	"badge_color" text,
	"xp_reward" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_definitions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"achievement_code" text NOT NULL,
	"progress_value" integer DEFAULT 0 NOT NULL,
	"target_value" integer,
	"unlocked" boolean DEFAULT false NOT NULL,
	"unlocked_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_titles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"achievement_code" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"equipped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coin_balances" (
	"user_id" text PRIMARY KEY NOT NULL,
	"current_balance" integer DEFAULT 0 NOT NULL,
	"lifetime_earned" integer DEFAULT 0 NOT NULL,
	"lifetime_spent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coin_reward_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reward_code" text NOT NULL,
	"source_id" text NOT NULL,
	"coins_awarded" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coin_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"transaction_type" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"reward_code" text,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_coin_rewards" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reward_date" date NOT NULL,
	"reward_code" text NOT NULL,
	"coins_awarded" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_track_themes" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_coins" integer DEFAULT 0 NOT NULL,
	"asset_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spectate_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"race_room_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"reward_granted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_track_themes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"theme_code" text NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purchase_price_coins" integer DEFAULT 0 NOT NULL,
	"is_equipped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"daily_step_goal" integer DEFAULT 10000 NOT NULL,
	"distance_unit" text DEFAULT 'km' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"notify_friends_on_daily_goal" boolean DEFAULT true NOT NULL,
	"receive_friend_activity_notifications" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"entitlement_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'iap' NOT NULL,
	"platform" text,
	"product_id" text,
	"purchase_token" text,
	"transaction_id" text,
	"purchased_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_type" text DEFAULT 'non_consumable' NOT NULL,
	"platform" text NOT NULL,
	"amount" integer,
	"currency" text,
	"payment_provider" text,
	"transaction_id" text,
	"purchase_token" text,
	"status" text DEFAULT 'verified' NOT NULL,
	"raw_receipt_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'livekit' NOT NULL,
	"room_name" text NOT NULL,
	"can_publish_audio" boolean DEFAULT false NOT NULL,
	"connected_at" timestamp,
	"disconnected_at" timestamp,
	"disconnect_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"currency" text NOT NULL,
	"wallet_credit_cents" integer,
	"provider_order_id" text,
	"provider_payment_id" text,
	"provider_signature" text,
	"idempotency_key" text,
	"failure_reason" text,
	"metadata" jsonb,
	"credited_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "deposit_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	CONSTRAINT "deposit_webhook_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "walking_group_daily_results" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"result_date" date NOT NULL,
	"group_total_steps" integer DEFAULT 0 NOT NULL,
	"daily_goal_steps" integer NOT NULL,
	"goal_completed" boolean DEFAULT false NOT NULL,
	"top_user_id" text,
	"rankings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "walking_group_daily_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"step_date" date NOT NULL,
	"daily_steps" integer DEFAULT 0 NOT NULL,
	"verified_steps" integer DEFAULT 0 NOT NULL,
	"calories" numeric,
	"distance_meters" numeric,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "walking_group_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"invited_user_id" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"invite_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "walking_group_join_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"responded_by_user_id" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "walking_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone,
	"invited_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "walking_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"group_name" text NOT NULL,
	"group_type" text NOT NULL,
	"custom_group_type" text,
	"admin_user_id" text NOT NULL,
	"daily_goal_steps" integer DEFAULT 10000 NOT NULL,
	"max_members" integer DEFAULT 10 NOT NULL,
	"privacy" text DEFAULT 'public' NOT NULL,
	"invite_code" text,
	"theme_key" text,
	"group_image_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "walking_groups_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "friend_activity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_date" date NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"step_count" integer DEFAULT 0,
	"goal_steps" integer DEFAULT 0,
	"notified_count" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_challenge_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"challenge_id" uuid NOT NULL,
	"entry_fee_cents" integer NOT NULL,
	"currency_code" text DEFAULT 'USD' NOT NULL,
	"rules_version" text NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cash_challenge_consents_user_challenge_version_uniq" UNIQUE("user_id","challenge_id","rules_version")
);
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_participants" ADD CONSTRAINT "race_participants_race_room_id_race_rooms_id_fk" FOREIGN KEY ("race_room_id") REFERENCES "public"."race_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_participants" ADD CONSTRAINT "race_participants_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD CONSTRAINT "race_rooms_creator_id_profiles_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_invites" ADD CONSTRAINT "room_invites_race_room_id_race_rooms_id_fk" FOREIGN KEY ("race_room_id") REFERENCES "public"."race_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_room_registrations" ADD CONSTRAINT "scheduled_room_registrations_race_room_id_race_rooms_id_fk" FOREIGN KEY ("race_room_id") REFERENCES "public"."race_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievement_code_achievement_definitions_code_fk" FOREIGN KEY ("achievement_code") REFERENCES "public"."achievement_definitions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_titles" ADD CONSTRAINT "user_titles_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_titles" ADD CONSTRAINT "user_titles_achievement_code_achievement_definitions_code_fk" FOREIGN KEY ("achievement_code") REFERENCES "public"."achievement_definitions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "step_daily_totals_user_date_idx" ON "step_daily_totals" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "step_daily_totals_user_idx" ON "step_daily_totals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "step_sessions_user_idx" ON "step_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "step_sessions_started_idx" ON "step_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_step_sources_user_platform_idx" ON "user_step_sources" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "live_race_comments_room_idx" ON "live_race_comments" USING btree ("race_room_id");--> statement-breakpoint
CREATE INDEX "live_race_comments_created_idx" ON "live_race_comments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "live_race_reactions_room_idx" ON "live_race_reactions" USING btree ("race_room_id");--> statement-breakpoint
CREATE INDEX "race_progress_room_idx" ON "race_progress" USING btree ("race_room_id");--> statement-breakpoint
CREATE INDEX "race_progress_participant_idx" ON "race_progress" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "race_results_room_idx" ON "race_results" USING btree ("race_room_id");--> statement-breakpoint
CREATE INDEX "race_results_user_idx" ON "race_results" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "race_results_room_user_uniq" ON "race_results" USING btree ("race_room_id","user_id");--> statement-breakpoint
CREATE INDEX "msg_reports_msg_idx" ON "chat_message_reports" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "msg_reports_reporter_idx" ON "chat_message_reports" USING btree ("reported_by_user_id");--> statement-breakpoint
CREATE INDEX "msg_reports_status_idx" ON "chat_message_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "msg_reports_created_idx" ON "chat_message_reports" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_reactions_msg_user_idx" ON "chat_reactions" USING btree ("message_id","message_type","user_id");--> statement-breakpoint
CREATE INDEX "chat_reactions_msg_idx" ON "chat_reactions" USING btree ("message_id","message_type");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_users_idx" ON "conversations" USING btree ("user1_id","user2_id");--> statement-breakpoint
CREATE INDEX "global_chat_created_idx" ON "global_chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "global_chat_user_idx" ON "global_chat_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "private_chat_conv_idx" ON "private_chat_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "private_chat_created_idx" ON "private_chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_users_pair_idx" ON "blocked_users" USING btree ("blocker_id","blocked_id");--> statement-breakpoint
CREATE INDEX "blocked_users_blocker_idx" ON "blocked_users" USING btree ("blocker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "friend_requests_pair_idx" ON "friend_requests" USING btree ("sender_id","recipient_id");--> statement-breakpoint
CREATE INDEX "friend_requests_recipient_idx" ON "friend_requests" USING btree ("recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "friends_pair_idx" ON "friends" USING btree ("user_id","friend_id");--> statement-breakpoint
CREATE INDEX "friends_user_idx" ON "friends" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_presence_status_idx" ON "user_presence" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_presence_last_seen_idx" ON "user_presence" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "user_presence_last_walk_idx" ON "user_presence" USING btree ("last_walk_activity_at");--> statement-breakpoint
CREATE INDEX "notification_devices_user_idx" ON "notification_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_devices_player_unique_idx" ON "notification_devices" USING btree ("onesignal_player_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id","is_read");--> statement-breakpoint
CREATE INDEX "push_notif_logs_user_idx" ON "push_notification_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "push_notif_logs_created_idx" ON "push_notification_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_notif_prefs_user_idx" ON "user_notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ach_def_difficulty_idx" ON "achievement_definitions" USING btree ("difficulty");--> statement-breakpoint
CREATE INDEX "ach_def_category_idx" ON "achievement_definitions" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "user_achievements_unique" ON "user_achievements" USING btree ("user_id","achievement_code");--> statement-breakpoint
CREATE INDEX "user_achievements_user_idx" ON "user_achievements" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_titles_unique" ON "user_titles" USING btree ("user_id","achievement_code");--> statement-breakpoint
CREATE INDEX "user_titles_user_idx" ON "user_titles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coin_reward_grants_unique" ON "coin_reward_grants" USING btree ("user_id","reward_code","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_coin_rewards_unique" ON "daily_coin_rewards" USING btree ("user_id","reward_date","reward_code");--> statement-breakpoint
CREATE UNIQUE INDEX "user_track_themes_unique" ON "user_track_themes" USING btree ("user_id","theme_code");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_user_id_idx" ON "user_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_entitlements_user_key_unique" ON "user_entitlements" USING btree ("user_id","entitlement_key");--> statement-breakpoint
CREATE UNIQUE INDEX "walking_group_daily_results_unique_idx" ON "walking_group_daily_results" USING btree ("group_id","result_date");--> statement-breakpoint
CREATE INDEX "walking_group_daily_results_group_idx" ON "walking_group_daily_results" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "walking_group_daily_steps_unique_idx" ON "walking_group_daily_steps" USING btree ("group_id","user_id","step_date");--> statement-breakpoint
CREATE INDEX "walking_group_daily_steps_group_date_idx" ON "walking_group_daily_steps" USING btree ("group_id","step_date");--> statement-breakpoint
CREATE INDEX "walking_group_daily_steps_user_idx" ON "walking_group_daily_steps" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "walking_group_invites_user_idx" ON "walking_group_invites" USING btree ("invited_user_id");--> statement-breakpoint
CREATE INDEX "walking_group_invites_group_idx" ON "walking_group_invites" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "walking_group_join_requests_group_idx" ON "walking_group_join_requests" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "walking_group_join_requests_user_idx" ON "walking_group_join_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "walking_group_join_requests_status_idx" ON "walking_group_join_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "walking_group_members_pair_idx" ON "walking_group_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "walking_group_members_user_idx" ON "walking_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "walking_group_members_group_idx" ON "walking_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "walking_groups_admin_idx" ON "walking_groups" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "walking_groups_status_idx" ON "walking_groups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "friend_activity_user_date_idx" ON "friend_activity_events" USING btree ("user_id","event_date");--> statement-breakpoint
CREATE INDEX "friend_activity_event_type_idx" ON "friend_activity_events" USING btree ("event_type");