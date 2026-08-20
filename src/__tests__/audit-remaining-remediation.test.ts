import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { planCoinClawback } from "../lib/storeNotificationsService.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("remaining audit remediation", () => {
  it("holds production Unlimited days behind an authenticated verification decision", () => {
    const config = read("src/lib/config.ts");
    const compose = read("docker-compose.coolify.yml");
    const jobs = read("src/lib/unlimitedChallengeJobs.ts");
    const admin = read("src/routes/admin.ts");

    expect(config).toContain('UNLIMITED_VERIFICATION_MODE: z.enum(["manual", "client_source"])');
    expect(config).toContain('isProduction ? "manual" : "client_source"');
    expect(config).toContain('UNLIMITED_VERIFICATION_MODE=manual is required');
    expect(compose).toContain('UNLIMITED_VERIFICATION_MODE: ${UNLIMITED_VERIFICATION_MODE:-manual}');
    expect(jobs).toContain('config.unlimitedGoal.verificationMode === "manual"');
    expect(jobs).toContain('status: "pending_verification"');
    expect(jobs).toContain("resolveUnlimitedDayVerification");
    expect(admin).toContain('/admin/unlimited-challenges/:challengeId/days/:dayId/verification-resolve');
    expect(admin).toContain("authoritativeSteps");
  });

  it("uses one transactional sponsored settlement owner", () => {
    const sponsored = read("src/routes/sponsoredEvents.ts");
    const races = read("src/routes/races.ts");
    const finalizer = sponsored.slice(
      sponsored.indexOf("async function finalizeSponsoredEvents"),
      sponsored.indexOf("// This job owns no timer"),
    );

    expect(finalizer).toContain('await autoCompleteRace(room.id, "sponsored_duration_expired")');
    expect(finalizer).not.toContain('status: "completed"');
    expect(finalizer).not.toContain("createPendingSponsoredGiftCardAwards");
    expect(races).toContain("sponsored-consolation:${raceId}:${result.userId}");
    expect(races).toContain("SPONSORED_EVENT_CONSOLATION_COINS");
    expect(races).toContain('"sponsored_event.completed"');
    expect(races).toContain('type: "sponsored_event_winner"');
  });

  it("claws back what remains and records debt instead of violating the non-negative invariant", () => {
    expect(planCoinClawback(1_000, 1_500)).toEqual({ debitCoins: 1_000, debtCoins: 0 });
    expect(planCoinClawback(1_000, 250)).toEqual({ debitCoins: 250, debtCoins: 750 });
    expect(planCoinClawback(1_000, 0)).toEqual({ debitCoins: 0, debtCoins: 1_000 });

    const service = read("src/lib/storeNotificationsService.ts");
    expect(service).toContain("clawbackDebtCoins");
    expect(service).toContain('accountStatus: sql`case when');
    expect(service).toContain("paidRaceEnabled: false");
    expect(service).toContain("withdrawalsEnabled: false");
  });

  it("enforces restricted account state centrally and on JWT-only session bootstrap", () => {
    const middleware = read("src/middleware/requireAuth.ts");
    const auth = read("src/routes/auth.ts");
    const sessions = read("src/lib/sessionService.ts");

    expect(middleware).toContain("getAccountStatusForAuthGate");
    expect(middleware).toContain('accountStatus !== "active"');
    expect(middleware).toContain('code: "ACCOUNT_RESTRICTED"');
    expect(auth).toContain('router.post("/auth/session/register", requireJwtOnly, requireActiveAccount');
    expect(auth).toContain('profile.accountStatus !== "active"');
    expect(sessions).toContain('const ACCOUNT_GATE_PREFIX = "account:gate:"');
  });

  it("keeps inactive race participants on the listen-only voice path", () => {
    const entitlements = read("src/routes/entitlements.ts");
    expect(entitlements).toContain("const isActiveParticipant = !!participant");
    expect(entitlements).toContain("} else if (!participant) {");
    expect(entitlements).toContain("inactive participant listen-only token issued");
  });
});
