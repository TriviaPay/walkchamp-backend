import { evaluateUserTitles } from "../lib/titleEvaluation";
import { sendPushToUser } from "./push";

/**
 * Fire-and-forget achievement evaluation + push notification.
 * Call after any event that could unlock new titles (step sync, race finish,
 * group join, coins earned). Never throws — safe to call without .catch().
 */
export async function evaluateAndNotify(userId: string): Promise<void> {
  try {
    const newlyUnlocked = await evaluateUserTitles(userId);
    for (const t of newlyUnlocked) {
      void sendPushToUser(
        userId,
        "🏆 New Title Unlocked!",
        t.title,
        { type: "title_unlocked", code: t.code },
      ).catch(() => {});
    }
  } catch {
    // fire-and-forget — never propagate errors to callers
  }
}
