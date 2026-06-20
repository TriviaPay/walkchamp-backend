/**
 * apply-db-indexes.ts
 * Applies missing production DB indexes via Drizzle's db.execute() with raw SQL.
 * Uses CREATE INDEX CONCURRENTLY IF NOT EXISTS — safe to re-run against a live DB
 * without locking tables. Each statement is issued independently (no transaction).
 *
 * Run: pnpm run apply-db-indexes
 */

import { db } from "@db";
import { sql } from "drizzle-orm";

const INDEXES: Array<{ name: string; ddl: string }> = [
  // ── Race participants ──────────────────────────────────────────────────────
  {
    name: "idx_race_participants_room_user",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_race_participants_room_user ON race_participants(race_room_id, user_id)",
  },
  {
    name: "idx_race_participants_room_status",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_race_participants_room_status ON race_participants(race_room_id, status)",
  },

  // ── Race progress / results ────────────────────────────────────────────────
  {
    name: "idx_race_progress_room_user_ts",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_race_progress_room_user_ts ON race_progress(race_room_id, user_id, recorded_at DESC)",
  },
  {
    name: "idx_race_results_room_rank",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_race_results_room_rank ON race_results(race_room_id, rank ASC)",
  },
  {
    name: "idx_race_step_sync_logs_race_user",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_race_step_sync_logs_race_user ON race_step_sync_logs(race_id, user_id)",
  },

  // ── Scheduled room registrations ───────────────────────────────────────────
  {
    name: "idx_scheduled_reg_room_user",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scheduled_reg_room_user ON scheduled_room_registrations(race_room_id, user_id)",
  },
  {
    name: "idx_scheduled_reg_user_status",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scheduled_reg_user_status ON scheduled_room_registrations(user_id, status)",
  },

  // ── Room invites ───────────────────────────────────────────────────────────
  {
    name: "idx_room_invites_invitee",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_room_invites_invitee ON room_invites(invitee_id)",
  },
  {
    name: "idx_room_invites_room",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_room_invites_room ON room_invites(race_room_id)",
  },

  // ── Wallet transactions ────────────────────────────────────────────────────
  {
    name: "idx_wallet_tx_user_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_user_created ON wallet_transactions(user_id, created_at DESC)",
  },
  {
    name: "idx_wallet_tx_wallet_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_wallet_created ON wallet_transactions(wallet_id, created_at DESC)",
  },

  // ── Payments ───────────────────────────────────────────────────────────────
  {
    name: "idx_payments_user_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at DESC)",
  },
  {
    name: "idx_payments_room",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_room ON payments(race_room_id)",
  },

  // ── Deposits ───────────────────────────────────────────────────────────────
  {
    name: "idx_deposit_tx_user_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deposit_tx_user_created ON deposit_transactions(user_id, created_at DESC)",
  },

  // ── Coin transactions ──────────────────────────────────────────────────────
  {
    name: "idx_coin_tx_user_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_coin_tx_user_created ON coin_transactions(user_id, created_at DESC)",
  },

  // ── Friends / social ───────────────────────────────────────────────────────
  {
    name: "idx_friend_requests_sender",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_friend_requests_sender ON friend_requests(sender_id)",
  },

  // ── Chat ──────────────────────────────────────────────────────────────────
  {
    name: "idx_global_chat_not_deleted_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_global_chat_not_deleted_created ON global_chat_messages(created_at DESC) WHERE is_deleted = false",
  },
  {
    name: "idx_private_chat_conv_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_private_chat_conv_created ON private_chat_messages(conversation_id, created_at DESC) WHERE is_deleted = false",
  },
  {
    name: "idx_conversations_user1_user2",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_user1_user2 ON conversations(user1_id, user2_id)",
  },

  // ── Notifications ──────────────────────────────────────────────────────────
  {
    name: "idx_notifications_user_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)",
  },
  {
    name: "idx_notification_devices_user",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_devices_user ON notification_devices(user_id)",
  },

  // ── Groups ────────────────────────────────────────────────────────────────
  {
    name: "idx_group_members_group_user",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_group_user ON walking_group_members(group_id, user_id)",
  },
  // ── Steps ─────────────────────────────────────────────────────────────────
  {
    name: "idx_step_daily_user_date",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_step_daily_user_date ON step_daily_totals(user_id, date DESC)",
  },
  {
    name: "idx_step_sessions_user_started",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_step_sessions_user_started ON step_sessions(user_id, started_at DESC)",
  },

  // ── User entitlements ─────────────────────────────────────────────────────
  {
    name: "idx_user_entitlements_user",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_entitlements_user ON user_entitlements(user_id)",
  },
  {
    name: "idx_user_purchases_user",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_purchases_user ON user_purchases(user_id)",
  },

  // ── Withdrawals ───────────────────────────────────────────────────────────
  {
    name: "idx_withdrawals_user_created",
    ddl: "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_withdrawals_user_created ON withdrawals(user_id, created_at DESC)",
  },
];

async function run() {
  let passed = 0;
  let failed = 0;

  for (const idx of INDEXES) {
    try {
      await db.execute(sql.raw(idx.ddl));
      console.log(`✓  ${idx.name}`);
      passed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗  ${idx.name}: ${msg}`);
      failed++;
    }
  }

  console.log(`\nDone — ${passed} succeeded, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
