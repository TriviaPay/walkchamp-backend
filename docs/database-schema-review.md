# Database Schema Review

Date: 2026-07-05

Scope:
- Drizzle schema in `db/src/schema`
- Current live `public` schema metadata from the configured Neon/Postgres database
- Runtime references in `src`
- Refund tables are intentionally left out of cleanup decisions per follow-up direction.

## Summary

The live database currently has 68 public tables. The current Drizzle schema exports 71 tables.

The schema is not wildly redundant overall. Most tables support a real domain boundary: profiles, races, wallets, coins, groups, chat, notifications, achievements, and operational hardening.

The main issues are:

1. Webhook/event tables are split by feature and should probably be consolidated.
2. Two live repair/audit tables exist in production but are not represented in Drizzle.
3. Many ID columns are plain `text` or `uuid` without foreign keys.
4. Several tables store derived counters or snapshots that are useful but need reconciliation rules.
5. Some zero-row tables are valid future/audit tables, but a few look stale or not fully wired.

## Schema Drift

Tables in Drizzle schema but not live, intentionally excluded from cleanup recommendations:

- `refunds`
- `refund_items`
- `refund_attempts`
- `refund_batches`
- `provider_webhook_events`

Tables live but not in Drizzle schema:

- `race_participants_repair_audit` with 58 rows
- `scheduled_registrations_repair_audit` with 9 rows

Recommendation: do not drop the repair audit tables until their history has been archived or intentionally modeled. Either add them to Drizzle as audit tables or move them to an archive schema.

## Strong Consolidation Candidates

### Provider webhook/event tables

Current tables, excluding refund-specific tables:

- `payment_events`
- `deposit_webhook_events`

These have the same core shape: provider, provider event id, event type, payload/reference, processing status, attempts/errors, received/processed timestamps.

Recommendation: combine new non-refund webhook work into one generic provider webhook table with nullable domain columns such as `payment_id`, `deposit_transaction_id`, and `domain`. Migrate `payment_events` and `deposit_webhook_events` later if the app stabilizes around the generic table.

### User preference tables

Current tables:

- `user_preferences`
- `user_notification_preferences`

These are not strictly redundant because one handles walking/product preferences and the other notification channel preferences. Combining is optional.

Recommendation: keep separate for now. Combine only if the frontend always fetches and updates them together.

### Daily/non-daily coin reward dedupe

Current tables:

- `daily_coin_rewards`
- `coin_reward_grants`
- `ad_reward_claims`

These are not redundant with `coin_transactions`; they enforce reward idempotency. However, they are similar enough that future reward systems could use one `reward_claims` table.

Recommendation: keep for now. Consider a unified `reward_claims` table only during a deliberate reward-service refactor.

### Group invites vs group join requests

Current tables:

- `walking_group_invites`
- `walking_group_join_requests`

These are inverse workflows: admin/member invites someone, and user asks to join. Not redundant.

Recommendation: keep separate.

## Tables To Keep

These are core or clearly justified:

| Table | Live rows | Importance |
| --- | ---: | --- |
| `profiles` | 8 | Canonical user profile and compliance/account state. |
| `wallets` | 8 | Current cash wallet balance per user. |
| `wallet_transactions` | 89 | Cash wallet ledger. Keep separate from balances. |
| `coin_balances` | 8 | Current coin balance per user. |
| `coin_transactions` | 396 | Coin ledger. Keep separate from balances. |
| `race_rooms` | 617 | Race/challenge header and lifecycle. |
| `race_participants` | 956 | Race membership, progress, completion, prize assignment. |
| `race_results` | 512 | Finalized race results. Keep as historical snapshot. |
| `race_step_sync_logs` | 1230 | Anti-cheat/audit log for progress submissions. |
| `scheduled_room_registrations` | 37 | Pre-start registration lifecycle. |
| `room_invites` | 60 | Race invitation lifecycle. |
| `step_daily_totals` | 66 | Daily aggregate used by profiles, groups, leaderboard, rewards. |
| `step_sessions` | 9532 | Raw/session walking history. |
| `achievement_definitions` | 108 | Achievement catalog. |
| `user_achievements` | 864 | Per-user progress/unlock state. |
| `user_titles` | 314 | Title ownership/equipped state. |
| `walking_groups` | 12 | Group header. |
| `walking_group_members` | 14 | Membership/roles. |
| `walking_group_daily_steps` | 74 | Per-user group daily contribution. |
| `notifications` | 51 | In-app notification inbox. |
| `push_notification_logs` | 459 | Push send audit/debugging. |
| `global_chat_messages` | 31 | Global chat. |
| `live_race_comments` | 284 | Race-specific live comments. |
| `live_race_reactions` | 176 | Race-specific reaction events. |
| `friend_requests` | 9 | Pending/resolved friend request lifecycle. |
| `friends` | 4 | Accepted friend graph. |
| `deposit_transactions` | 27 | Deposit/order/payment lifecycle. |
| `deposit_webhook_events` | 10 | Deposit webhook idempotency. Keep until generic webhook migration. |
| `feature_flags` | 3 | Runtime feature gating. |
| `friend_activity_events` | 4 | Friend activity notification dedupe/history. |
| `race_track_themes` | 34 | Theme catalog. |
| `user_track_themes` | 14 | User theme ownership/equipped state. |
| `user_entitlements` | 4 | Effective access rights. |
| `user_purchases` | 4 | Raw purchase records. Keep separate from entitlements. |
| `user_preferences` | 8 | Walking/product preferences. |
| `user_presence` | 8 | Current heartbeat/presence state. |
| `voice_sessions` | 180 | LiveKit voice session audit/access tracking. |

## Conditional Keep

These have low or zero rows, but the table shape is still justified if the feature is active or planned.

| Table | Live rows | Recommendation |
| --- | ---: | --- |
| `payments` | 0 | Keep if Stripe/cash race entry remains planned. Otherwise remove payment routes and related tables together. |
| `payment_events` | 0 | Keep only until webhook events are consolidated. |
| `promo_codes` | 0 | Keep if promo code feature is planned. |
| `promo_redemptions` | 0 | Keep if promo codes are kept. |
| `withdrawals` | 0 | Keep if real-money withdrawal is planned. Important compliance object. |
| `cash_challenge_consents` | 0 | Keep if cash challenges are enabled or planned. |
| `notification_devices` | 0 | Keep if push notifications are active; row count can be zero before device registration. |
| `user_notification_preferences` | 2 | Keep unless merged into `user_preferences`. |
| `live_activity_tokens` | 0 | Keep if iOS Live Activities are planned/active. |
| `outbox_events` | 0 | Keep if background dispatch is intended. |
| `notification_delivery` | 0 | Keep if idempotent notification delivery is being wired. Otherwise redundant with logs/inbox. |
| `race_finalization_locks` | 0 | Keep if finalization uses DB locking. |
| `finalization_attempts` | 0 | Keep if finalization retry/audit flow is being wired. |
| `audit_logs` | 0 | Keep for admin/security audit, but start writing to it consistently. |
| `blocked_users` | 0 | Keep for safety/social moderation. |
| `chat_message_reports` | 3 | Keep for moderation. |
| `chat_reactions` | 11 | Keep if reactions are productized. |
| `conversations` | 0 | Keep if private messages are active/planned. |
| `private_chat_messages` | 0 | Keep with `conversations`. |
| `spectate_sessions` | 0 | Keep if spectating coin rewards are active/planned. |
| `ad_reward_claims` | 0 | Keep if ad rewards are active/planned. |
| `user_step_sources` | 0 | Keep if device/HealthKit setup state is needed. |
| `walking_group_invites` | 4 | Keep. |
| `walking_group_join_requests` | 0 | Keep if public groups allow join requests. |
| `walking_group_daily_results` | 0 | Keep only if a scheduled job writes daily summaries. |

## Cleanup Or Revisit

| Table | Live rows | Issue |
| --- | ---: | --- |
| `race_progress` | 0 | Looks redundant with `race_participants.current_steps` and `race_step_sync_logs`. Either wire it as historical progress snapshots or drop it. |
| `restricted_regions` | 0 | Schema exists but runtime usage appears absent. Wire enforcement or remove until needed. |
| `race_participants_repair_audit` | 58 | Live-only audit table. Keep/archive, but add schema ownership. |
| `scheduled_registrations_repair_audit` | 9 | Live-only audit table. Keep/archive, but add schema ownership. |
| refund tables | not live | Intentionally out of scope for this review. |

## Column-Level Findings

### Add foreign keys where feasible

Only 22 live foreign keys exist. Many important columns are not constrained:

- `coin_balances.user_id`, `coin_transactions.user_id`, `daily_coin_rewards.user_id`
- `step_daily_totals.user_id`, `step_sessions.user_id`, `user_step_sources.user_id`
- `notifications.user_id`, `notification_devices.user_id`, `push_notification_logs.user_id`
- `friends.user_id`, `friends.friend_id`, `friend_requests.sender_id`, `friend_requests.recipient_id`, `blocked_users.*`
- `walking_group_*` `group_id` and `user_id` columns
- `race_results.race_room_id`, `race_results.user_id`
- `race_step_sync_logs.race_id`, `race_step_sync_logs.user_id`
- `payments.race_room_id`, `race_participants.payment_id`, `wallet_transactions.payment_id`

Recommendation: add FKs for canonical state tables first. For append-only logs, either add FKs with `on delete set null/restrict` or document why the log intentionally avoids FK coupling.

### Normalize ID types

Some race references are `uuid`, others are `text`:

- `race_rooms.id` is `uuid`
- `race_participants.race_room_id` is `uuid`
- `race_results.race_room_id` is `text`
- `live_race_comments.race_room_id` is `text`
- `spectate_sessions.race_room_id` is `text`
- `voice_sessions.race_id` is `text`

Recommendation: migrate race references to `uuid` where they point at `race_rooms.id`.

### Derived/snapshot columns need ownership rules

Examples:

- `profiles.wallet_balance` duplicates wallet state and should likely be removed or ignored.
- `profiles.total_steps`, `current_streak`, `current_rank`, `level` are derived profile counters.
- `race_rooms.current_players`, `registered_count`, `spectator_count`, prize pool columns are derived from participants/registrations/sessions/payments.
- `coin_balances.current_balance`, `lifetime_earned`, `lifetime_spent` duplicate the coin ledger by design.
- `wallets.available_balance_cents`, `pending_balance_cents`, `withdrawable_balance_cents`, `total_earned_cents` duplicate the wallet ledger by design.

Recommendation: keep balance/counter snapshots for performance, but define one writer and a reconciliation query/job for each.

### Avoid free-form status columns on core workflows

Many tables use `text` status fields. That is acceptable for early product development, but risky for money/race workflows.

Recommendation: use enums or check constraints for:

- `deposit_transactions.status`
- `refunds.status`
- `refund_items.status`
- `walking_groups.status`
- `walking_group_members.status`
- `walking_group_invites.status`
- `walking_group_join_requests.status`
- `race_results.status`
- `outbox_events.status`

### Reduce profile width over time

`profiles` has 40 live columns. It currently mixes identity, profile display, compliance, feature flags, stats, Stripe customer id, and derived counters.

Recommendation: do not split immediately, but over time move these to purpose-specific tables:

- compliance/account gates: `kyc_status`, `paid_race_enabled`, `withdrawals_enabled`, `fraud_score`
- derived stats: `total_steps`, `current_streak`, `current_rank`, `level`
- provider billing identity: `stripe_customer_id`

## Recommended Action Plan

1. Add Drizzle ownership for the two live repair audit tables or archive them.
2. Replace non-refund webhook-event duplication with a generic provider webhook table for new work.
3. Fix race ID type drift by migrating text race references to uuid.
4. Add FKs to canonical tables first: coins, steps, groups, notifications, race results.
5. Decide whether `race_progress` is needed. If not, drop it after confirming no clients depend on it.
6. Document/reconcile every derived balance/counter column.
