import { db } from "@db";
import { auditLogsTable } from "@db/schema";
import { logger } from "./logger";

export async function writeAuditLog(entry: {
  actorUserId?: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      actorUserId: entry.actorUserId ?? null,
      actorType: entry.actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      reason: entry.reason ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    logger.error({ err, entry }, "[AuditLog] insert failed");
  }
}
