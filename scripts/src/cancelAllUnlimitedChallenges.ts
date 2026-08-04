/**
 * One-shot: cancel every open Unlimited Challenge and refund entry contributions.
 *
 * Usage (from Backend/):
 *   pnpm exec tsx ./scripts/src/cancelAllUnlimitedChallenges.ts
 */
import fs from "node:fs";
import path from "node:path";

function loadDotEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key || process.env[key]) continue;
    let value = line.slice(idx + 1);
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvFile(path.resolve(process.cwd(), ".env"));
  process.env.FEATURE_UNLIMITED_GOAL ??= "true";

  const { cancelAllOpenUnlimitedChallenges } = await import(
    "../../src/lib/unlimitedChallengeService.js"
  );
  const { logger } = await import("../../src/lib/logger.js");

  const reason = process.argv[2]?.trim() || "platform_cancelled_all_existing";
  const result = await cancelAllOpenUnlimitedChallenges({ reason, actorUserId: null });
  logger.info(result, "[script] cancelAllOpenUnlimitedChallenges done");
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        cancelled: result.cancelled,
        skippedTerminal: result.skippedTerminal,
        challenges: result.results.map((r) => ({
          id: r.challengeId,
          ok: r.ok,
          alreadyTerminal: r.alreadyTerminal ?? false,
          refunded: r.refundedUserIds.length,
          failed: r.failedRefundUserIds.length,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
