import { type SQL, sql } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { writeAuditLog } from "./auditLog.js";
import { logger } from "./logger.js";
import { setOperationalLock, WALLET_LEDGER_ANOMALY_LOCK } from "./operationalLocks.js";

export type WalletLedgerReconciliationSummary = {
  succeededDepositsMissingCredit: number;
  duplicateDepositCredits: number;
  duplicateIdempotencyKeys: number;
  missingIdempotencyKeys: number;
  invalidSignedAmounts: number;
  inconsistentBalanceSnapshots: number;
  negativeWalletBalances: number;
};

function countFromRow(row: Record<string, unknown> | undefined, key = "issue_count"): number {
  const value = row?.[key] ?? row?.count;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  return 0;
}

async function countIssue(query: SQL): Promise<number> {
  const result = await db.execute(query);
  return countFromRow(result.rows[0] as Record<string, unknown> | undefined);
}

async function markMissingCreditDepositsRequiresReview(): Promise<number> {
  const result = await db.execute(sql`
    update deposit_transactions d
    set status = 'requires_review',
        failure_reason = 'ledger_reconciliation_missing_deposit_credit',
        updated_at = now()
    where d.status = 'succeeded'
      and not exists (
        select 1
        from wallet_transactions wt
        where wt.deposit_transaction_id = d.id
          and wt.transaction_type = 'deposit_credit'
          and wt.status = 'completed'
      )
  `);
  return Number(result.rowCount ?? 0);
}

export async function runWalletLedgerReconciliationTick(): Promise<WalletLedgerReconciliationSummary> {
  const summary: WalletLedgerReconciliationSummary = {
    succeededDepositsMissingCredit: await countIssue(sql`
      select count(*) as issue_count
      from deposit_transactions d
      where d.status = 'succeeded'
        and not exists (
          select 1
          from wallet_transactions wt
          where wt.deposit_transaction_id = d.id
            and wt.transaction_type = 'deposit_credit'
            and wt.status = 'completed'
        )
    `),
    duplicateDepositCredits: await countIssue(sql`
      select count(*) as issue_count
      from (
        select deposit_transaction_id
        from wallet_transactions
        where deposit_transaction_id is not null
          and transaction_type = 'deposit_credit'
        group by deposit_transaction_id
        having count(*) > 1
      ) duplicates
    `),
    duplicateIdempotencyKeys: await countIssue(sql`
      select count(*) as issue_count
      from (
        select idempotency_key
        from wallet_transactions
        where idempotency_key is not null
        group by idempotency_key
        having count(*) > 1
      ) duplicates
    `),
    missingIdempotencyKeys: await countIssue(sql`
      select count(*) as issue_count
      from wallet_transactions
      where transaction_type in (
        'deposit_credit',
        'deposit_refund_debit',
        'chargeback_debit',
        'race_entry_wallet_debit',
        'race_prize_paid'
      )
        and idempotency_key is null
    `),
    invalidSignedAmounts: await countIssue(sql`
      select count(*) as issue_count
      from wallet_transactions
      where (
        transaction_type in ('deposit_credit', 'race_prize_paid')
        and amount_cents <= 0
      ) or (
        transaction_type in ('race_entry_wallet_debit', 'deposit_refund_debit', 'chargeback_debit')
        and amount_cents >= 0
      )
    `),
    inconsistentBalanceSnapshots: await countIssue(sql`
      select count(*) as issue_count
      from wallet_transactions
      where balance_before_cents is not null
        and balance_after_cents is not null
        and balance_after_cents <> balance_before_cents + amount_cents
    `),
    negativeWalletBalances: await countIssue(sql`
      select count(*) as issue_count
      from wallets
      where available_balance_cents < 0
         or pending_balance_cents < 0
         or withdrawable_balance_cents < 0
    `),
  };

  const anomalyCount = Object.values(summary).reduce((sum, count) => sum + count, 0);
  const markedDepositsRequiresReview = summary.succeededDepositsMissingCredit > 0
    ? await markMissingCreditDepositsRequiresReview()
    : 0;
  const logPayload = { ...summary, anomalyCount, markedDepositsRequiresReview };
  if (anomalyCount > 0) {
    logger.warn(logPayload, "[WalletLedgerReconciliation] anomalies detected");
    await setOperationalLock({
      key: WALLET_LEDGER_ANOMALY_LOCK,
      locked: true,
      reason: "wallet_ledger_reconciliation_anomalies",
      metadata: logPayload,
    });
  } else {
    logger.info(logPayload, "[WalletLedgerReconciliation] completed");
    await setOperationalLock({
      key: WALLET_LEDGER_ANOMALY_LOCK,
      locked: false,
      reason: "wallet_ledger_reconciliation_clear",
      metadata: logPayload,
    });
  }

  await writeAuditLog({
    actorType: "system",
    action: "wallet.ledger_reconciliation",
    entityType: "wallet_ledger",
    reason: anomalyCount > 0 ? "scheduled_reconciliation_anomalies" : "scheduled_reconciliation_ok",
    metadata: logPayload,
  });

  return summary;
}
