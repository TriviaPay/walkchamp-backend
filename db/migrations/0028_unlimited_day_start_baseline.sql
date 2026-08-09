-- ══════════════════════════════════════════════════════════════════════════════
-- Unlimited Challenge: per-participant live-display baseline.
--
-- Lets the live board render "steps during this challenge day" instead of "today's total", as
-- verified_steps - start_baseline_steps.
--
-- DISPLAY ONLY. Daily-goal qualification and settlement keep using the full daily verified total
-- (unlimited_challenge_days.verified_steps), so this column can never move money.
--
-- Defaults to 0, which is also the correct value for the normal case: a challenge day's window
-- opens at the participant's local midnight, the same instant their daily step bucket resets, so
-- there are no pre-window steps to subtract. It becomes non-zero only when a day row is activated
-- after its window already opened.
--
-- Additive: NOT NULL is safe because of the default, and existing rows correctly read as 0.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE "unlimited_challenge_days" ADD COLUMN IF NOT EXISTS "start_baseline_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_days" ADD COLUMN IF NOT EXISTS "baseline_captured_at" timestamp with time zone;
