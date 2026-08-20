import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import {
  devIapPurchasesEnabled,
  resetGoogleTokenCacheForTests,
  verifyStorePurchase,
} from "../lib/iapVerification.js";

// Production Mic Pass purchases used to be rejected outright (IAP_VERIFICATION_NOT_CONFIGURED
// for every platform). These tests pin the real behavior: the store — not the request body —
// decides the product, the ownership and the purchase state.

const BUNDLE_ID = "com.globalwalkerleague.app";
const PACKAGE_NAME = "com.globalwalkerleague.app";

const ec = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const rsa = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const IAP_ENV_KEYS = [
  "APPLE_IAP_ISSUER_ID", "APPLE_IAP_KEY_ID", "APPLE_IAP_PRIVATE_KEY", "APPLE_BUNDLE_ID",
  "APPLE_IAP_ALLOW_SANDBOX", "GOOGLE_PLAY_PACKAGE_NAME", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
  "GOOGLE_PLAY_CLIENT_EMAIL", "GOOGLE_PLAY_PRIVATE_KEY", "GOOGLE_PLAY_ALLOW_TEST_PURCHASES",
  "ENABLE_DEV_IAP_PURCHASES",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of IAP_ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of IAP_ENV_KEYS) delete process.env[key];
  resetGoogleTokenCacheForTests();
});

afterEach(() => {
  for (const key of IAP_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

function configureApple() {
  process.env.APPLE_IAP_ISSUER_ID = "57246542-96fe-1a63-e053-0824d011072a";
  process.env.APPLE_IAP_KEY_ID = "2X9R4HXF34";
  // Deployment dashboards commonly flatten PEM newlines — the verifier must cope.
  process.env.APPLE_IAP_PRIVATE_KEY = ec.privateKey.replace(/\n/g, "\\n");
  process.env.APPLE_BUNDLE_ID = BUNDLE_ID;
}

function configureGoogle() {
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "play@walkchamp.iam.gserviceaccount.com",
    private_key: rsa.privateKey,
  });
  process.env.GOOGLE_PLAY_PACKAGE_NAME = PACKAGE_NAME;
}

/** Apple returns the transaction as a JWS; only the payload segment is read. */
function appleJws(payload: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "ES256", x5c: [] })}.${seg(payload)}.${Buffer.from("sig").toString("base64url")}`;
}

function appleTransaction(overrides: Record<string, unknown> = {}) {
  return {
    bundleId: BUNDLE_ID,
    productId: "mic_pass_lifetime",
    transactionId: "2000000901234567",
    originalTransactionId: "2000000901234567",
    purchaseDate: 1_754_500_000_000,
    type: "Non-Consumable",
    inAppOwnershipType: "PURCHASED",
    environment: "Production",
    ...overrides,
  };
}

interface StubCall { url: string; init: RequestInit | undefined }

/** Stub fetch with a per-URL responder; records calls so ordering can be asserted. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: StubCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    const { status, body } = handler(href, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }));
  return calls;
}

const micPassInput = {
  platform: "ios" as const,
  productId: "mic_pass_lifetime",
  transactionId: "2000000901234567",
  productType: "non_consumable" as const,
};

describe("dev purchases gate", () => {
  it("is refused when ENABLE_DEV_IAP_PURCHASES is false, even outside production", async () => {
    process.env.ENABLE_DEV_IAP_PURCHASES = "false";
    expect(devIapPurchasesEnabled()).toBe(false);

    const result = await verifyStorePurchase({
      platform: "dev",
      productId: "mic_pass_lifetime",
      transactionId: "dev-1",
      productType: "non_consumable",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DEV_PURCHASES_DISABLED");
      expect(result.status).toBe(403);
    }
  });

  it("unlocks for QA when the flag is on, and never touches a store", async () => {
    process.env.ENABLE_DEV_IAP_PURCHASES = "true";
    const calls = stubFetch(() => ({ status: 500, body: {} }));

    const result = await verifyStorePurchase({
      platform: "dev",
      productId: "mic_pass_lifetime",
      transactionId: "dev-1",
      productType: "non_consumable",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.purchase.environment).toBe("dev");
    expect(calls).toHaveLength(0);
  });
});

describe("Apple App Store verification", () => {
  it("reports NOT_CONFIGURED (503) when the App Store key is missing", async () => {
    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("IAP_VERIFICATION_NOT_CONFIGURED");
      expect(result.status).toBe(503);
    }
  });

  it("verifies a real production transaction and signs a valid ES256 App Store JWT", async () => {
    configureApple();
    const calls = stubFetch(() => ({ status: 200, body: { signedTransactionInfo: appleJws(appleTransaction()) } }));

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.purchase.provider).toBe("apple");
      expect(result.purchase.productId).toBe("mic_pass_lifetime");
      expect(result.purchase.transactionId).toBe("2000000901234567");
      expect(result.purchase.environment).toBe("production");
      expect(result.purchase.purchasedAt?.toISOString()).toBe(new Date(1_754_500_000_000).toISOString());
    }

    expect(calls[0].url).toBe("https://api.storekit.itunes.apple.com/inApps/v1/transactions/2000000901234567");

    // Apple rejects a malformed auth token outright, so prove the JWT is really ES256-signed
    // with the configured key and carries the claims Apple requires.
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    const [h, p, s] = auth.replace("Bearer ", "").split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toMatchObject({ alg: "ES256", kid: "2X9R4HXF34" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({
      iss: "57246542-96fe-1a63-e053-0824d011072a",
      aud: "appstoreconnect-v1",
      bid: BUNDLE_ID,
    });
    const signatureValid = cryptoVerify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    );
    expect(signatureValid).toBe(true);
  });

  it("falls back to the sandbox host so TestFlight and App Review purchases unlock", async () => {
    configureApple();
    const calls = stubFetch((url) =>
      url.startsWith("https://api.storekit-sandbox")
        ? { status: 200, body: { signedTransactionInfo: appleJws(appleTransaction({ environment: "Sandbox" })) } }
        : { status: 404, body: {} },
    );

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.purchase.environment).toBe("sandbox");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("api.storekit-sandbox.itunes.apple.com");
  });

  it("refuses a sandbox receipt when APPLE_IAP_ALLOW_SANDBOX=false", async () => {
    configureApple();
    process.env.APPLE_IAP_ALLOW_SANDBOX = "false";
    const calls = stubFetch(() => ({ status: 404, body: {} }));

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_RECEIPT_INVALID");
    expect(calls).toHaveLength(1); // sandbox host never tried
  });

  it("refuses a sandbox receipt in production when APPLE_IAP_ALLOW_SANDBOX is unset (F-02)", async () => {
    // Sandbox purchases mint real coins if accepted, so production must be opt-in, not opt-out.
    configureApple();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const calls = stubFetch(() => ({ status: 404, body: {} }));
      const result = await verifyStorePurchase(micPassInput);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("IAP_RECEIPT_INVALID");
      expect(calls).toHaveLength(1); // sandbox host never tried
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });

  it("retries in sandbox when production 401s, so a not-yet-live app still verifies", async () => {
    // Observed in production 2026-08-07: the same In-App Purchase key that sandbox accepts
    // (404 "Transaction id not found") is 401'd by the production host until the app ships.
    // Treating that 401 as terminal would fail every TestFlight and App Review purchase.
    configureApple();
    const calls = stubFetch((url) =>
      url.startsWith("https://api.storekit-sandbox")
        ? { status: 200, body: { signedTransactionInfo: appleJws(appleTransaction({ environment: "Sandbox" })) } }
        : { status: 401, body: "" },
    );

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.purchase.environment).toBe("sandbox");
    expect(calls).toHaveLength(2);
  });

  it("still reports NOT_CONFIGURED when sandbox rejects the key as well", async () => {
    configureApple();
    const calls = stubFetch(() => ({ status: 401, body: "" }));

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_VERIFICATION_NOT_CONFIGURED");
    expect(calls).toHaveLength(2);
  });

  it("rejects a receipt whose product is not the one the client claimed", async () => {
    configureApple();
    stubFetch(() => ({
      status: 200,
      body: { signedTransactionInfo: appleJws(appleTransaction({ productId: "coins_100" })) },
    }));

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_PRODUCT_MISMATCH");
  });

  it("rejects a receipt from another app bundle", async () => {
    configureApple();
    stubFetch(() => ({
      status: 200,
      body: { signedTransactionInfo: appleJws(appleTransaction({ bundleId: "com.someone.else" })) },
    }));

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_RECEIPT_INVALID");
  });

  it("rejects a refunded transaction", async () => {
    configureApple();
    stubFetch(() => ({
      status: 200,
      body: { signedTransactionInfo: appleJws(appleTransaction({ revocationDate: 1_754_600_000_000 })) },
    }));

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_PURCHASE_REVOKED");
  });

  it("treats a rejected API key as a server misconfiguration, not a bad receipt", async () => {
    configureApple();
    stubFetch(() => ({ status: 401, body: {} }));

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_VERIFICATION_NOT_CONFIGURED");
  });

  it("treats an Apple outage as retryable rather than blaming the buyer", async () => {
    configureApple();
    stubFetch(() => ({ status: 503, body: {} }));

    const result = await verifyStorePurchase(micPassInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("IAP_VERIFICATION_UNAVAILABLE");
      expect(result.status).toBe(503);
    }
  });
});

describe("Google Play verification", () => {
  const androidInput = {
    platform: "android" as const,
    productId: "mic_pass_lifetime",
    transactionId: "GPA.3311-0000-0000-00000",
    purchaseToken: "opaque-play-token",
    packageName: PACKAGE_NAME,
    productType: "non_consumable" as const,
  };

  function googleHandler(purchase: Record<string, unknown>, purchaseStatus = 200) {
    return (url: string) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return { status: 200, body: { access_token: "ya29.stub", expires_in: 3599 } };
      }
      if (url.endsWith(":acknowledge")) return { status: 200, body: {} };
      return { status: purchaseStatus, body: purchase };
    };
  }

  it("reports NOT_CONFIGURED (503) when the service account is missing", async () => {
    const result = await verifyStorePurchase(androidInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_VERIFICATION_NOT_CONFIGURED");
  });

  it("verifies a purchased token, signs an RS256 assertion, and acknowledges the non-consumable", async () => {
    configureGoogle();
    const calls = stubFetch(googleHandler({
      purchaseState: 0,
      consumptionState: 0,
      acknowledgementState: 0,
      orderId: "GPA.3311-0000-0000-00000",
      purchaseTimeMillis: "1754500000000",
      purchaseType: undefined,
    }));

    const result = await verifyStorePurchase(androidInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.purchase.provider).toBe("google");
      expect(result.purchase.transactionId).toBe("GPA.3311-0000-0000-00000");
      expect(result.purchase.purchaseToken).toBe("opaque-play-token");
      expect(result.purchase.environment).toBe("production");
    }

    const assertion = new URLSearchParams(String(calls[0].init?.body)).get("assertion")!;
    const [h, p, s] = assertion.split(".");
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({
      iss: "play@walkchamp.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
    });
    expect(cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), rsa.publicKey, Buffer.from(s, "base64url"))).toBe(true);

    // Play auto-refunds an unacknowledged non-consumable after 3 days.
    expect(calls.some((c) => c.url.endsWith(":acknowledge"))).toBe(true);
  });

  it("leaves consumables unacknowledged so the client's consume call still settles them", async () => {
    configureGoogle();
    const calls = stubFetch(googleHandler({
      purchaseState: 0,
      acknowledgementState: 0,
      orderId: "GPA.1111-0000-0000-00000",
      purchaseTimeMillis: "1754500000000",
    }));

    const result = await verifyStorePurchase({
      ...androidInput,
      productId: "coins_500",
      productType: "consumable",
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.url.endsWith(":acknowledge"))).toBe(false);
  });

  it("holds a pending payment instead of granting it", async () => {
    configureGoogle();
    stubFetch(googleHandler({ purchaseState: 2, orderId: "GPA.pending" }));

    const result = await verifyStorePurchase(androidInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_PURCHASE_NOT_COMPLETED");
  });

  it("rejects a cancelled purchase", async () => {
    configureGoogle();
    stubFetch(googleHandler({ purchaseState: 1, orderId: "GPA.cancelled" }));

    const result = await verifyStorePurchase(androidInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_PURCHASE_REVOKED");
  });

  it("rejects a token Play does not recognise for this product", async () => {
    configureGoogle();
    stubFetch(googleHandler({ error: { code: 404 } }, 404));

    const result = await verifyStorePurchase(androidInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_RECEIPT_INVALID");
  });

  it("rejects a purchase claimed for a different package", async () => {
    configureGoogle();
    const calls = stubFetch(googleHandler({ purchaseState: 0 }));

    const result = await verifyStorePurchase({ ...androidInput, packageName: "com.attacker.app" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_RECEIPT_INVALID");
    expect(calls).toHaveLength(0); // never even asks Play
  });

  it("requires a purchase token", async () => {
    configureGoogle();
    stubFetch(googleHandler({ purchaseState: 0 }));

    const result = await verifyStorePurchase({ ...androidInput, purchaseToken: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_RECEIPT_INVALID");
  });

  it("refuses a license-tester purchase when GOOGLE_PLAY_ALLOW_TEST_PURCHASES=false", async () => {
    configureGoogle();
    process.env.GOOGLE_PLAY_ALLOW_TEST_PURCHASES = "false";
    stubFetch(googleHandler({ purchaseState: 0, purchaseType: 0, orderId: "GPA.test" }));

    const result = await verifyStorePurchase(androidInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IAP_RECEIPT_INVALID");
  });

  it("refuses a license-tester purchase in production when GOOGLE_PLAY_ALLOW_TEST_PURCHASES is unset (F-02)", async () => {
    configureGoogle();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      stubFetch(googleHandler({ purchaseState: 0, purchaseType: 0, orderId: "GPA.test" }));
      const result = await verifyStorePurchase(androidInput);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("IAP_RECEIPT_INVALID");
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });

  it("accepts a license-tester purchase outside production by default and marks it sandbox", async () => {
    configureGoogle();
    stubFetch(googleHandler({ purchaseState: 0, purchaseType: 0, orderId: "GPA.test", purchaseTimeMillis: "1754500000000" }));

    const result = await verifyStorePurchase(androidInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.purchase.environment).toBe("sandbox");
  });
});

describe("POST /api/purchases/verify wiring", () => {
  const route = readFileSync("src/routes/entitlements.ts", "utf8");
  const verifyRoute = route.slice(
    route.indexOf('router.post("/purchases/verify"'),
    route.indexOf('router.post("/purchases/restore"'),
  );

  it("no longer blanket-rejects every purchase in production", () => {
    expect(verifyRoute).not.toContain('process.env.NODE_ENV === "production"');
  });

  it("verifies with the store before any grant path is reached", () => {
    const verifyAt = verifyRoute.indexOf("await verifyStorePurchase(");
    expect(verifyAt).toBeGreaterThan(-1);
    for (const grant of ["recordCoinLedgerEntry(", "insert(userEntitlementsTable)", "insert(userPurchasesTable)"]) {
      expect(verifyRoute.indexOf(grant)).toBeGreaterThan(verifyAt);
    }
  });

  it("persists the store's transaction identity, never the client's claim", () => {
    // The unique indexes on user_purchases are the replay guard; keying them off a
    // client-chosen id would let a caller pick a fresh id and slip past them.
    expect(verifyRoute).toContain("transactionId:   verifiedTransactionId");
    expect(verifyRoute).toContain("purchaseToken:   verifiedPurchaseToken");
    expect(verifyRoute).toContain("idempotencyKey: `iap:${userId}:${verifiedTransactionId}`");
    expect(verifyRoute).not.toContain("transactionId:   transaction_id");
    expect(verifyRoute).not.toContain("eq(userPurchasesTable.transactionId, transaction_id)");
  });

  it("refuses a verified purchase that already belongs to another account", () => {
    expect(verifyRoute).toContain("PURCHASE_ALREADY_CLAIMED");
    expect(verifyRoute).toContain("existing && existing.userId !== userId");
  });
});
