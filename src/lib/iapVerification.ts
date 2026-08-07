import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/**
 * Server-side store receipt verification for in-app purchases (Mic Pass + coin packs).
 *
 * The client is never trusted: it sends only an identifier (Apple transaction id / Google
 * purchase token) and the server asks the store directly over TLS with its own credentials.
 * A forged body cannot produce a grant because the store, not the caller, supplies the
 * product id, ownership and purchase state that this module returns.
 *
 * Env is read at call time (not module load) so a Coolify env change takes effect on
 * redeploy without a code change, and tests can flip a single variable — same convention as
 * cashChallengeFees.inrCashChallengesEnabled().
 */

export type IapPlatform = "ios" | "android" | "dev";

export type IapFailureCode =
  /** Credentials for this platform are missing → operator action required. */
  | "IAP_VERIFICATION_NOT_CONFIGURED"
  /** The store says this receipt/token does not exist or does not belong to this app. */
  | "IAP_RECEIPT_INVALID"
  /** The receipt is real but is for a different product than the client claimed. */
  | "IAP_PRODUCT_MISMATCH"
  /** Pending (e.g. Play "slow card" / parental approval) or cancelled — not payable yet. */
  | "IAP_PURCHASE_NOT_COMPLETED"
  /** Refunded or revoked by the store — must not grant. */
  | "IAP_PURCHASE_REVOKED"
  /** The store was unreachable or returned 5xx — retryable, not the user's fault. */
  | "IAP_VERIFICATION_UNAVAILABLE"
  /** platform:"dev" attempted where ENABLE_DEV_IAP_PURCHASES is not on. */
  | "DEV_PURCHASES_DISABLED";

export interface VerifiedPurchase {
  provider: "apple" | "google" | "dev";
  /** Product id as the STORE reports it — never the client-supplied one. */
  productId: string;
  /** Canonical transaction identity used for replay protection. */
  transactionId: string;
  purchaseToken: string | null;
  originalTransactionId: string | null;
  environment: "production" | "sandbox" | "dev";
  purchasedAt: Date | null;
  raw: Record<string, unknown>;
}

export type IapVerifyResult =
  | { ok: true; purchase: VerifiedPurchase }
  | { ok: false; code: IapFailureCode; status: number; message: string; detail?: string };

export interface IapVerifyInput {
  platform: IapPlatform;
  productId: string;
  transactionId: string;
  purchaseToken?: string | null;
  packageName?: string | null;
  /** Non-consumables are acknowledged server-side; consumables are consumed by the client. */
  productType: "consumable" | "non_consumable";
}

const HTTP_TIMEOUT_MS = 8_000;
const APPLE_PRODUCTION_HOST = "https://api.storekit.itunes.apple.com";
const APPLE_SANDBOX_HOST = "https://api.storekit-sandbox.itunes.apple.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
export const DEFAULT_ANDROID_PACKAGE_NAME = "com.globalwalkerleague.app";

// ── Env helpers ───────────────────────────────────────────────────────────────

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return value === "true";
}

/** PEM keys pasted into a dashboard arrive with literal `\n` — restore real newlines. */
function normalizePem(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

interface AppleConfig {
  issuerId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
}

function appleConfig(): AppleConfig | null {
  const issuerId = env("APPLE_IAP_ISSUER_ID");
  const keyId = env("APPLE_IAP_KEY_ID");
  const privateKey = env("APPLE_IAP_PRIVATE_KEY");
  const bundleId = env("APPLE_BUNDLE_ID");
  if (!issuerId || !keyId || !privateKey || !bundleId) return null;
  return { issuerId, keyId, privateKey: normalizePem(privateKey), bundleId };
}

interface GoogleConfig {
  clientEmail: string;
  privateKey: string;
  packageName: string;
}

function googleConfig(): GoogleConfig | null {
  // Accept either the whole service-account JSON blob or the two fields split out, since
  // some deployment UIs mangle multi-line JSON.
  const rawJson = env("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
  let clientEmail = env("GOOGLE_PLAY_CLIENT_EMAIL");
  let privateKey = env("GOOGLE_PLAY_PRIVATE_KEY");

  if (rawJson && (!clientEmail || !privateKey)) {
    try {
      const parsed = JSON.parse(rawJson) as { client_email?: string; private_key?: string };
      clientEmail = clientEmail ?? parsed.client_email?.trim() ?? null;
      privateKey = privateKey ?? parsed.private_key?.trim() ?? null;
    } catch {
      return null;
    }
  }

  if (!clientEmail || !privateKey) return null;
  return {
    clientEmail,
    privateKey: normalizePem(privateKey),
    packageName: env("GOOGLE_PLAY_PACKAGE_NAME") ?? DEFAULT_ANDROID_PACKAGE_NAME,
  };
}

export function androidPackageName(): string {
  return env("GOOGLE_PLAY_PACKAGE_NAME") ?? DEFAULT_ANDROID_PACKAGE_NAME;
}

/**
 * platform:"dev" bypasses the store entirely, so it is only ever allowed where an operator
 * has asked for it. Default: on outside production, off in production — set
 * ENABLE_DEV_IAP_PURCHASES=true to unlock it on a prod-mode staging/QA deployment.
 */
export function devIapPurchasesEnabled(): boolean {
  return envBoolean("ENABLE_DEV_IAP_PURCHASES", process.env.NODE_ENV !== "production");
}

/** Sandbox/TestFlight and Play license-tester purchases. On by default: App Review buys in sandbox. */
function appleSandboxAllowed(): boolean {
  return envBoolean("APPLE_IAP_ALLOW_SANDBOX", true);
}

function googleTestPurchasesAllowed(): boolean {
  return envBoolean("GOOGLE_PLAY_ALLOW_TEST_PURCHASES", true);
}

/** Non-secret snapshot for startup logs and ops checks. */
export function iapConfigStatus() {
  return {
    appleConfigured: appleConfig() !== null,
    googleConfigured: googleConfig() !== null,
    devPurchasesEnabled: devIapPurchasesEnabled(),
    androidPackageName: androidPackageName(),
    appleSandboxAllowed: appleSandboxAllowed(),
    googleTestPurchasesAllowed: googleTestPurchasesAllowed(),
  };
}

// ── JWT signing (no external dependency; node:crypto only) ────────────────────

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function jwtSegments(header: object, payload: object): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
}

function loadKey(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** App Store Server API auth token (ES256, per Apple's "Generating JSON Web Tokens"). */
function appleBearerToken(cfg: AppleConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = jwtSegments(
    { alg: "ES256", kid: cfg.keyId, typ: "JWT" },
    { iss: cfg.issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1", bid: cfg.bundleId },
  );
  // JWS ES256 wants the raw r||s pair, not the DER encoding node emits by default.
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: loadKey(cfg.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function googleAssertion(cfg: GoogleConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = jwtSegments(
    { alg: "RS256", typ: "JWT" },
    {
      iss: cfg.clientEmail,
      scope: ANDROID_PUBLISHER_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
  );
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), loadKey(cfg.privateKey));
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Decode a JWS payload. Trust comes from the TLS call to Apple, not from this decode. */
function decodeJwsPayload(jws: string): Record<string, unknown> | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

type HttpOutcome =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "http"; status: number; body: unknown }
  | { kind: "network"; error: unknown };

async function httpJson(url: string, init: RequestInit): Promise<HttpOutcome> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return res.ok ? { kind: "ok", status: res.status, body } : { kind: "http", status: res.status, body };
  } catch (error) {
    return { kind: "network", error };
  }
}

function unavailable(detail: string): IapVerifyResult {
  return {
    ok: false,
    code: "IAP_VERIFICATION_UNAVAILABLE",
    status: 503,
    message: "Could not reach the store to verify your purchase. Please try again shortly.",
    detail,
  };
}

const NOT_CONFIGURED_MESSAGE = "Store purchase verification is not configured on this server.";

// ── Apple ─────────────────────────────────────────────────────────────────────

interface AppleTransactionPayload {
  bundleId?: string;
  productId?: string;
  transactionId?: string;
  originalTransactionId?: string;
  purchaseDate?: number;
  revocationDate?: number;
  inAppOwnershipType?: string;
  environment?: string;
  type?: string;
}

async function verifyApple(input: IapVerifyInput): Promise<IapVerifyResult> {
  const cfg = appleConfig();
  if (!cfg) {
    return {
      ok: false,
      code: "IAP_VERIFICATION_NOT_CONFIGURED",
      status: 503,
      message: NOT_CONFIGURED_MESSAGE,
      detail: "APPLE_IAP_ISSUER_ID / APPLE_IAP_KEY_ID / APPLE_IAP_PRIVATE_KEY / APPLE_BUNDLE_ID",
    };
  }

  let token: string;
  try {
    token = appleBearerToken(cfg);
  } catch (error) {
    return {
      ok: false,
      code: "IAP_VERIFICATION_NOT_CONFIGURED",
      status: 503,
      message: NOT_CONFIGURED_MESSAGE,
      detail: `APPLE_IAP_PRIVATE_KEY is not a usable EC private key: ${String(error)}`,
    };
  }

  const path = `/inApps/v1/transactions/${encodeURIComponent(input.transactionId)}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  // Production first; a sandbox transaction id simply is not present there (404), which is
  // how Apple expects servers to route TestFlight and App Review purchases.
  let environment: "production" | "sandbox" = "production";
  let outcome = await httpJson(`${APPLE_PRODUCTION_HOST}${path}`, { method: "GET", headers });

  if (outcome.kind === "http" && outcome.status === 404 && appleSandboxAllowed()) {
    environment = "sandbox";
    outcome = await httpJson(`${APPLE_SANDBOX_HOST}${path}`, { method: "GET", headers });
  }

  if (outcome.kind === "network") {
    return unavailable(`apple request failed: ${String(outcome.error)}`);
  }

  if (outcome.kind === "http") {
    if (outcome.status === 404) {
      return {
        ok: false,
        code: "IAP_RECEIPT_INVALID",
        status: 400,
        message: "Apple could not find this purchase. Try Restore Purchases.",
        detail: `apple 404 for transaction ${input.transactionId}`,
      };
    }
    if (outcome.status === 401 || outcome.status === 403) {
      // Our own credentials are wrong — an operator problem, never the buyer's.
      return {
        ok: false,
        code: "IAP_VERIFICATION_NOT_CONFIGURED",
        status: 503,
        message: NOT_CONFIGURED_MESSAGE,
        detail: `apple rejected the API key (${outcome.status})`,
      };
    }
    return unavailable(`apple responded ${outcome.status}`);
  }

  const signed = (outcome.body as { signedTransactionInfo?: string } | null)?.signedTransactionInfo;
  const payload = typeof signed === "string" ? (decodeJwsPayload(signed) as AppleTransactionPayload | null) : null;
  if (!payload) {
    return unavailable("apple returned an unreadable signedTransactionInfo");
  }

  if (payload.bundleId !== cfg.bundleId) {
    return {
      ok: false,
      code: "IAP_RECEIPT_INVALID",
      status: 400,
      message: "This purchase belongs to a different app.",
      detail: `bundleId ${payload.bundleId ?? "none"} != ${cfg.bundleId}`,
    };
  }

  if (payload.productId !== input.productId) {
    return {
      ok: false,
      code: "IAP_PRODUCT_MISMATCH",
      status: 400,
      message: "This purchase is for a different product.",
      detail: `store productId ${payload.productId ?? "none"} != claimed ${input.productId}`,
    };
  }

  if (payload.revocationDate) {
    return {
      ok: false,
      code: "IAP_PURCHASE_REVOKED",
      status: 409,
      message: "This purchase was refunded or revoked.",
    };
  }

  // FAMILY_SHARED is a legitimate entitlement when Family Sharing is enabled on the product;
  // anything else (e.g. a shared-but-revoked state) is not a purchase we grant on.
  if (payload.inAppOwnershipType && !["PURCHASED", "FAMILY_SHARED"].includes(payload.inAppOwnershipType)) {
    return {
      ok: false,
      code: "IAP_RECEIPT_INVALID",
      status: 400,
      message: "This purchase is not owned by this account.",
      detail: `inAppOwnershipType ${payload.inAppOwnershipType}`,
    };
  }

  const reportedEnvironment = payload.environment?.toLowerCase() === "sandbox" ? "sandbox" : environment;
  if (reportedEnvironment === "sandbox" && !appleSandboxAllowed()) {
    return {
      ok: false,
      code: "IAP_RECEIPT_INVALID",
      status: 400,
      message: "Sandbox purchases are not accepted on this server.",
    };
  }

  return {
    ok: true,
    purchase: {
      provider: "apple",
      productId: payload.productId!,
      transactionId: payload.transactionId ?? input.transactionId,
      purchaseToken: null,
      originalTransactionId: payload.originalTransactionId ?? null,
      environment: reportedEnvironment,
      purchasedAt: typeof payload.purchaseDate === "number" ? new Date(payload.purchaseDate) : null,
      raw: payload as Record<string, unknown>,
    },
  };
}

// ── Google Play ───────────────────────────────────────────────────────────────

let googleTokenCache: { token: string; expiresAtMs: number } | null = null;

/** Exported for tests: a credential rotation must not be masked by a cached token. */
export function resetGoogleTokenCacheForTests(): void {
  googleTokenCache = null;
}

async function googleAccessToken(cfg: GoogleConfig): Promise<{ token: string } | { error: IapVerifyResult }> {
  if (googleTokenCache && googleTokenCache.expiresAtMs > Date.now() + 60_000) {
    return { token: googleTokenCache.token };
  }

  let assertion: string;
  try {
    assertion = googleAssertion(cfg);
  } catch (error) {
    return {
      error: {
        ok: false,
        code: "IAP_VERIFICATION_NOT_CONFIGURED",
        status: 503,
        message: NOT_CONFIGURED_MESSAGE,
        detail: `GOOGLE_PLAY_PRIVATE_KEY is not a usable RSA private key: ${String(error)}`,
      },
    };
  }

  const outcome = await httpJson(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });

  if (outcome.kind === "network") {
    return { error: unavailable(`google token request failed: ${String(outcome.error)}`) };
  }
  if (outcome.kind === "http") {
    return {
      error: {
        ok: false,
        code: "IAP_VERIFICATION_NOT_CONFIGURED",
        status: 503,
        message: NOT_CONFIGURED_MESSAGE,
        detail: `google rejected the service account (${outcome.status})`,
      },
    };
  }

  const body = outcome.body as { access_token?: string; expires_in?: number } | null;
  if (!body?.access_token) {
    return { error: unavailable("google token response had no access_token") };
  }

  googleTokenCache = {
    token: body.access_token,
    expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return { token: body.access_token };
}

interface GooglePurchasePayload {
  purchaseState?: number;
  consumptionState?: number;
  acknowledgementState?: number;
  purchaseTimeMillis?: string;
  orderId?: string;
  purchaseType?: number;
  regionCode?: string;
}

async function verifyGoogle(input: IapVerifyInput): Promise<IapVerifyResult> {
  const cfg = googleConfig();
  if (!cfg) {
    return {
      ok: false,
      code: "IAP_VERIFICATION_NOT_CONFIGURED",
      status: 503,
      message: NOT_CONFIGURED_MESSAGE,
      detail: "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (or GOOGLE_PLAY_CLIENT_EMAIL + GOOGLE_PLAY_PRIVATE_KEY)",
    };
  }

  const purchaseToken = input.purchaseToken?.trim();
  if (!purchaseToken) {
    return {
      ok: false,
      code: "IAP_RECEIPT_INVALID",
      status: 400,
      message: "purchase_token is required for Google Play purchases.",
    };
  }

  const packageName = input.packageName?.trim() || cfg.packageName;
  if (packageName !== cfg.packageName) {
    return {
      ok: false,
      code: "IAP_RECEIPT_INVALID",
      status: 400,
      message: "This purchase belongs to a different app.",
      detail: `package ${packageName} != ${cfg.packageName}`,
    };
  }

  const auth = await googleAccessToken(cfg);
  if ("error" in auth) return auth.error;

  const base =
    `${GOOGLE_PLAY_API}/applications/${encodeURIComponent(cfg.packageName)}` +
    `/purchases/products/${encodeURIComponent(input.productId)}/tokens/${encodeURIComponent(purchaseToken)}`;

  const outcome = await httpJson(base, {
    method: "GET",
    headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" },
  });

  if (outcome.kind === "network") {
    return unavailable(`google request failed: ${String(outcome.error)}`);
  }

  if (outcome.kind === "http") {
    if (outcome.status === 400 || outcome.status === 404 || outcome.status === 410) {
      // Play answers 400/404 for a token that does not match this product — which is exactly
      // what a forged or mis-attributed token looks like.
      return {
        ok: false,
        code: "IAP_RECEIPT_INVALID",
        status: 400,
        message: "Google Play could not find this purchase. Try Restore Purchases.",
        detail: `google ${outcome.status} for product ${input.productId}`,
      };
    }
    if (outcome.status === 401 || outcome.status === 403) {
      return {
        ok: false,
        code: "IAP_VERIFICATION_NOT_CONFIGURED",
        status: 503,
        message: NOT_CONFIGURED_MESSAGE,
        detail: `google rejected the service account for androidpublisher (${outcome.status})`,
      };
    }
    return unavailable(`google responded ${outcome.status}`);
  }

  const payload = (outcome.body ?? {}) as GooglePurchasePayload;

  if (payload.purchaseState === 2) {
    return {
      ok: false,
      code: "IAP_PURCHASE_NOT_COMPLETED",
      status: 409,
      message: "This payment is still pending with Google Play. It will unlock once it completes.",
    };
  }
  if (payload.purchaseState !== 0) {
    return {
      ok: false,
      code: "IAP_PURCHASE_REVOKED",
      status: 409,
      message: "This purchase was cancelled or refunded.",
      detail: `purchaseState ${payload.purchaseState ?? "unknown"}`,
    };
  }

  if (payload.purchaseType === 0 && !googleTestPurchasesAllowed()) {
    return {
      ok: false,
      code: "IAP_RECEIPT_INVALID",
      status: 400,
      message: "Test purchases are not accepted on this server.",
    };
  }

  // Play auto-refunds anything unacknowledged after 3 days. Consumables are acknowledged
  // implicitly when the client consumes them, so only non-consumables are acknowledged here.
  let acknowledged = payload.acknowledgementState === 1;
  if (!acknowledged && input.productType === "non_consumable") {
    const ack = await httpJson(`${base}:acknowledge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    acknowledged = ack.kind === "ok";
  }

  const purchaseTimeMs = Number(payload.purchaseTimeMillis);

  return {
    ok: true,
    purchase: {
      provider: "google",
      productId: input.productId,
      // orderId is Play's stable payment identity; the token is the fallback for the rare
      // test purchase that carries no order id.
      transactionId: payload.orderId?.trim() || purchaseToken,
      purchaseToken,
      originalTransactionId: payload.orderId?.trim() ?? null,
      environment: payload.purchaseType === 0 ? "sandbox" : "production",
      purchasedAt: Number.isFinite(purchaseTimeMs) && purchaseTimeMs > 0 ? new Date(purchaseTimeMs) : null,
      raw: { ...payload, acknowledged },
    },
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function verifyStorePurchase(input: IapVerifyInput): Promise<IapVerifyResult> {
  if (input.platform === "dev") {
    if (!devIapPurchasesEnabled()) {
      return {
        ok: false,
        code: "DEV_PURCHASES_DISABLED",
        status: 403,
        message: "Development purchases are disabled on this server.",
      };
    }
    return {
      ok: true,
      purchase: {
        provider: "dev",
        productId: input.productId,
        transactionId: input.transactionId,
        purchaseToken: input.purchaseToken?.trim() || null,
        originalTransactionId: null,
        environment: "dev",
        purchasedAt: new Date(),
        raw: { dev: true },
      },
    };
  }

  return input.platform === "ios" ? verifyApple(input) : verifyGoogle(input);
}
