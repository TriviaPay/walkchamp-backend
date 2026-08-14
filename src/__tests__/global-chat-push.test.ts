import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatRoute = readFileSync("src/routes/chat.ts", "utf8");
const pushService = readFileSync("src/lib/pushNotificationService.ts", "utf8");
const pushRoute = readFileSync("src/routes/push.ts", "utf8");

describe("global chat push notifications", () => {
  it("posts to Pusher and then schedules a OneSignal push without blocking the response", () => {
    const globalPost = chatRoute.slice(
      chatRoute.indexOf('router.post("/chat/global"'),
      chatRoute.indexOf("// ── POST /api/chat/global/react"),
    );
    expect(globalPost).toContain('await triggerEvent("public-global-chat", "chat:new_message", payload)');
    expect(globalPost).toContain("void notifyGlobalChatMessageReceived");
    expect(globalPost).toContain("return res.status(201).json({ message: payload })");
  });

  it("keeps private DM notifications on the existing helper", () => {
    expect(chatRoute).toContain("void notifyChatMessageReceived");
  });

  it("targets opted-in active-device users, excludes the sender, and rate-limits recipients", () => {
    expect(pushService).toContain("notificationDevicesTable.active");
    expect(pushService).toContain("ne(notificationDevicesTable.userId, senderUserId)");
    expect(pushService).toContain("pushNotificationsEnabled && p.chatUpdatesEnabled");
    expect(pushService).toContain('const rateLimitKey = "global_chat_message"');
    expect(pushService).toContain("filterRecentlySentRecipients(recipientIds, rateLimitKey, 180_000)");
  });

  it("uses batched OneSignal delivery with the frontend deep link/type and chat icon", () => {
    expect(pushService).toContain("await sendPushToUsers");
    expect(pushService).toContain('type: "global_chat_message"');
    expect(pushService).toContain('deepLink = "walkchamp://chat/global"');
    expect(pushService).toContain('category: "chat"');
    expect(pushService).toContain('androidLargeIcon: "notification_chat"');
    expect(pushRoute).toContain("large_icon: options.androidLargeIcon");
  });
});
