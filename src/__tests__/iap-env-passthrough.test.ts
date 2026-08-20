import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Mic Pass unlock failed in a way no unit test could catch: the code read the right env vars, the
// operator set them in the Coolify UI, and docker compose dropped them on the floor because
// compose only forwards the keys named in the file. Anything iapVerification.ts reads has to be
// listed in the deploy stack, or /api/purchases/verify answers IAP_VERIFICATION_NOT_CONFIGURED.

const read = (p: string) => readFileSync(p, "utf8");

function envVarsReadBy(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\benvBoolean?\(\s*"([A-Z0-9_]+)"/g)) names.add(match[1]);
  for (const match of source.matchAll(/\benv\(\s*"([A-Z0-9_]+)"/g)) names.add(match[1]);
  return [...names];
}

describe("IAP credentials reach the deployed container", () => {
  const compose = read("docker-compose.coolify.yml");
  const iapSource = read("src/lib/iapVerification.ts");

  it("reads the env vars this test knows how to find", () => {
    // Guard the guard: if the helper names change, the assertions below must not silently pass.
    expect(envVarsReadBy(iapSource)).toContain("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
    expect(envVarsReadBy(iapSource)).toContain("APPLE_IAP_ISSUER_ID");
  });

  it("forwards every store credential iapVerification.ts reads", () => {
    const required = envVarsReadBy(iapSource).filter((name) => name !== "ENABLE_DEV_IAP_PURCHASES");
    const missing = required.filter((name) => !compose.includes(`${name}:`));

    expect(missing).toEqual([]);
  });

  it("keeps the store-side test flags off by default in production (F-02)", () => {
    // Sandbox receipt verification is lenient and coins convert to cash-equivalent value, so
    // accepting sandbox/test purchases in production is a coin mint. App Review and TestFlight
    // do buy in sandbox — the operator sets these true in the Coolify UI for the review window.
    expect(compose).toContain("APPLE_IAP_ALLOW_SANDBOX: ${APPLE_IAP_ALLOW_SANDBOX:-false}");
    expect(compose).toContain("GOOGLE_PLAY_ALLOW_TEST_PURCHASES: ${GOOGLE_PLAY_ALLOW_TEST_PURCHASES:-false}");
  });

  it("does not let a missing credential fail the deploy", () => {
    // `:?` would abort the stack; these degrade to IAP_VERIFICATION_NOT_CONFIGURED plus a boot
    // warning instead, which is recoverable without a redeploy of unrelated services.
    for (const name of ["APPLE_IAP_PRIVATE_KEY", "GOOGLE_PLAY_PRIVATE_KEY", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"]) {
      expect(compose).not.toContain(`${name}:?`);
    }
  });

  it("never forwards the dev-purchase escape hatch to this production stack", () => {
    // The stack hardcodes NODE_ENV=production, where devIapPurchasesEnabled() defaults to false.
    // Forwarding the key would make "any client can mint its own Mic Pass" a UI toggle.
    expect(compose).toContain("NODE_ENV: production");
    expect(compose).not.toMatch(/^\s*ENABLE_DEV_IAP_PURCHASES:/m);
  });
});
