import { Router, type RequestHandler } from "express";
import { db } from "../../db/src/index.js";
import {
  chatMessageReportsTable,
  globalChatMessagesTable,
  privateChatMessagesTable,
} from "../../db/src/schema/index.js";
import { and, eq, countDistinct } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { z } from "zod";
import { requireActiveAccount } from "../middleware/requireActiveAccount.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { config } from "../lib/config.js";
import { createRedisRateLimit, rateLimitByActorOrIp } from "../lib/rateLimit.js";
import { sanitizePlainText } from "../lib/text.js";

const router = Router();
const reportLimiter: RequestHandler = config.features.rateLimitingEnabled
  ? createRedisRateLimit({
      bucket: "chat-report",
      windowMs: 10 * 60 * 1000,
      max: 5,
      failureMode: "closed",
      message: "You are submitting reports too quickly. Please try again later.",
      code: "REPORT_RATE_LIMITED",
      key: rateLimitByActorOrIp,
    })
  : ((_req, _res, next) => next());

const VALID_REASONS = ["spam", "harassment", "inappropriate", "hate_or_threat", "other"] as const;

const reportSchema = z.object({
  reason: z.enum(VALID_REASONS),
  note: z.string().max(500).optional(),
  chatType: z.enum(["global", "private"]).default("global"),
  reportedUserId: z.string().optional(),
  messageSnapshot: z.string().max(1000).optional(),
});

// ── POST /api/chat/messages/:messageId/report ─────────────────────────────────
router.post("/chat/messages/:messageId/report", requireAuth, requireActiveAccount, reportLimiter, async (req, res) => {
  const userId = (req as AuthenticatedRequest).descopeUserId;
  const { messageId } = req.params as { messageId: string };

  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: "Invalid report payload", errors: parsed.error.flatten() });
  }

  const { reason, chatType, reportedUserId } = parsed.data;
  const note = parsed.data.note ? sanitizePlainText(parsed.data.note) : undefined;
  const messageSnapshot = parsed.data.messageSnapshot ? sanitizePlainText(parsed.data.messageSnapshot) : undefined;

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

    const [myPriorReport] = await db
      .select({ id: chatMessageReportsTable.id })
      .from(chatMessageReportsTable)
      .where(and(
        eq(chatMessageReportsTable.messageId, messageId),
        eq(chatMessageReportsTable.reportedByUserId, userId),
      ))
      .limit(1);

    if (myPriorReport) {
      return res.status(409).json({
        success: false,
        code: "REPORT_ALREADY_SUBMITTED",
        message: "You have already reported this message.",
      });
    }

    // Count how many distinct users have already reported this message
    const [{ count: priorCount }] = await db
      .select({ count: countDistinct(chatMessageReportsTable.reportedByUserId) })
      .from(chatMessageReportsTable)
      .where(eq(chatMessageReportsTable.messageId, messageId));

    // Get reporter profile for logging
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
    await writeAuditLog({
      actorUserId: userId,
      actorType: "user",
      action: "chat.report.create",
      entityType: "chat_message",
      entityId: messageId,
      reason,
      metadata: {
        chatType,
        reportedUserId: reportedUserId ?? null,
        priorCount: Number(priorCount),
      },
    });

    return res.json({
      success: true,
      report_id: report.id,
      status: "pending_review",
      message: "Message reported for review.",
    });
  } catch (err) {
    req.log.error({ err }, "chat message report error");
    return res.status(500).json({ success: false, message: "Failed to submit report" });
  }
});

export default router;
