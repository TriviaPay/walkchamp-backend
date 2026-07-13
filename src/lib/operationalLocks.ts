import { eq } from "drizzle-orm";
import { db } from "../../db/src/index.js";
import { operationalLocksTable } from "../../db/src/schema/index.js";

export const WALLET_LEDGER_ANOMALY_LOCK = "wallet_ledger_anomaly";

export async function setOperationalLock(input: {
  key: string;
  locked: boolean;
  reason: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(operationalLocksTable)
    .values({
      key: input.key,
      locked: input.locked,
      reason: input.reason,
      metadata: input.metadata ?? null,
      lockedAt: input.locked ? now : null,
      resolvedAt: input.locked ? null : now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: operationalLocksTable.key,
      set: {
        locked: input.locked,
        reason: input.reason,
        metadata: input.metadata ?? null,
        lockedAt: input.locked ? now : null,
        resolvedAt: input.locked ? null : now,
        updatedAt: now,
      },
    });
}

export async function getOperationalLock(key: string) {
  const [lock] = await db
    .select()
    .from(operationalLocksTable)
    .where(eq(operationalLocksTable.key, key))
    .limit(1);
  return lock ?? null;
}

export async function assertOperationalLockOpen(key: string, message: string): Promise<void> {
  const lock = await getOperationalLock(key);
  if (lock?.locked) {
    const err = new Error(message);
    err.name = "OPERATIONAL_LOCK_ACTIVE";
    throw err;
  }
}
