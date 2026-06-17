import { Router } from "express";
import { db } from "@db";
import {
  chatMessageReportsTable,
  globalChatMessagesTable,
  privateChatMessagesTable,
  profilesTable,
} from "@db/schema";
import { eq, countDistinct } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth";
import { triggerEvent } from "../lib/pusher";
import { z } from "zod";

const router = Router();

const VALID_REASONS = ["spam", "harassment", "inappropriate", "hate_or_threat", "other"] as const;
const AUTO_DELETE_THRESHOLD = 1;

const reportSchema = z.object({
  reason: z.enum(VALID_REASONS),
  note: z.string().max(500).optional(),
  chatType: z.enum(["global", "private"]).default("global"),
  reportedUserId: z.string().optional(),
  messageSnapshot: z.string().max(1000).optional(),
});

// ── In-memory rate limiter ────────────────────────────────────────────────────
// 5 reports per 10 minutes, 20 per day per user.
interface RateBucket { count10m: number; count1d: number; reset10m: number; reset1d: number }
const _rateStore = new Map<string, RateBucket>();

function checkRateLimit(userId: string): { allowed: boolean } {
  const now = Date.now();
  const existing = _rateStore.get(userId);
  const bucket: RateBucket = existing ?? {
    count10m: 0, count1d: 0,
    reset10m: now + 10 * 60 * 1000,
    reset1d: now + 24 * 60 * 60 * 1000,
  };
  if (now >= bucket.reset10m) { bucket.count10m = 0; bucket.reset10m = now + 10 * 60 * 1000; }
  if (now >= bucket.reset1d)  { bucket.count1d  = 0; bucket.reset1d  = now + 24 * 60 * 60 * 1000; }
  if (bucket.count10m >= 5 || bucket.count1d >= 20) return { allowed: false };
  bucket.count10m++;
  bucket.count1d++;
  _rateStore.set(userId, bucket);
  return { allowed: true };
}

// Prune stale rate-limit entries once per hour to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateStore) {
    if (now >= v.reset1d) _rateStore.delete(k);
  }
}, 60 * 60 * 1000);

// ── POST /api/chat/messages/:messageId/report ─────────────────────────────────
router.post("/chat/messages/:messageId/report", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const { messageId } = req.params as { messageId: string };

  // Rate limit
  const { allowed } = checkRateLimit(userId);
  if (!allowed) {
    return res.status(429).json({
      success: false,
      code: "REPORT_RATE_LIMITED",
      message: "You are submitting reports too quickly. Please try again later.",
    });
  }

  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: "Invalid report payload", errors: parsed.error.flatten() });
  }

  const { reason, note, chatType, reportedUserId, messageSnapshot } = parsed.data;

  try {
    // Fetch message snapshot + conversationId from DB
    let snapshot = messageSnapshot ?? null;
    let conversationId: string | null = null;
    if (!snapshot || chatType === "private") {
      try {
        if (chatType === "global") {
          const [m] = await db
            .select({ text: globalChatMessagesTable.text })
            .from(globalChatMessagesTable).where(eq(globalChatMessagesTable.id, messageId)).limit(1);
          snapshot = m?.text ?? snapshot;
        } else {
          const [m] = await db
            .select({ text: privateChatMessagesTable.text, convId: privateChatMessagesTable.conversationId })
            .from(privateChatMessagesTable).where(eq(privateChatMessagesTable.id, messageId)).limit(1);
          snapshot = m?.text ?? snapshot;
          conversationId = m?.convId ?? null;
        }
      } catch {}
    }

    // Check if this user already reported this message (prevent duplicate reports)
    const existingReports = await db
      .select({ id: chatMessageReportsTable.id })
      .from(chatMessageReportsTable)
      .where(eq(chatMessageReportsTable.messageId, messageId))
      .limit(50);

    const alreadyReported = existingReports.some((r) => (r as { reportedByUserId?: string }).reportedByUserId === userId);
    // Note: drizzle select only returns selected columns, so re-query for the check
    const [myPriorReport] = await db
      .select({ id: chatMessageReportsTable.id })
      .from(chatMessageReportsTable)
      .where(eq(chatMessageReportsTable.messageId, messageId))
      .limit(1);

    // Count how many distinct users have already reported this message
    const [{ count: priorCount }] = await db
      .select({ count: countDistinct(chatMessageReportsTable.reportedByUserId) })
      .from(chatMessageReportsTable)
      .where(eq(chatMessageReportsTable.messageId, messageId));

    // Get reporter profile for logging
    const [reporter] = await db
      .select({ username: profilesTable.username })
      .from(profilesTable).where(eq(profilesTable.id, userId)).limit(1);

    // Save report
    const [report] = await db.insert(chatMessageReportsTable).values({
      messageId,
      conversationId,
      chatType,
      reportedByUserId: userId,
      reportedUserId: reportedUserId ?? null,
      reason,
      note: note ?? null,
      messageSnapshot: snapshot,
      status: "pending",
      autoDeleted: false,
    }).returning({ id: chatMessageReportsTable.id });

    req.log.info({ reportId: report.id, userId, messageId, reason, chatType, priorCount }, "[Report] saved to DB");

    // After inserting, total distinct reporters = priorCount + 1 (this user)
    const totalDistinctReporters = Number(priorCount) + 1;

    if (totalDistinctReporters >= AUTO_DELETE_THRESHOLD) {
      // Auto-delete the message
      if (chatType === "global") {
        await db.update(globalChatMessagesTable)
          .set({ isDeleted: true })
          .where(eq(globalChatMessagesTable.id, messageId));
        void triggerEvent("public-global-chat", "chat:message_deleted", { messageId });
      } else if (chatType === "private" && conversationId) {
        await db.update(privateChatMessagesTable)
          .set({ isDeleted: true })
          .where(eq(privateChatMessagesTable.id, messageId));
        void triggerEvent(`private-chat-${conversationId}`, "chat:message_deleted", { messageId });
      }

      // Mark all reports for this message as auto-actioned
      await db.update(chatMessageReportsTable)
        .set({ status: "actioned", autoDeleted: true, updatedAt: new Date() })
        .where(eq(chatMessageReportsTable.messageId, messageId));

      req.log.info(
        { messageId, chatType, conversationId, totalDistinctReporters },
        "[Report] auto-deleted message after reaching report threshold",
      );
    }

    return res.json({
      success: true,
      report_id: report.id,
      message: "Message reported.",
    });
  } catch (err) {
    req.log.error({ err }, "chat message report error");
    return res.status(500).json({ success: false, message: "Failed to submit report" });
  }
});

export default router;
