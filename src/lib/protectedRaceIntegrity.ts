import { createSign } from "node:crypto";
import { config } from "./config.js";

export type ProtectedIntegrityProvider = "android_play_integrity" | "ios_app_attest";

export type ProtectedIntegrityResult =
  | { ok: true; provider: ProtectedIntegrityProvider; reference: string | null; details: Record<string, unknown> }
  | { ok: false; provider: ProtectedIntegrityProvider; code: string; retryable: boolean; details?: Record<string, unknown> };

type VerifyInput = {
  provider: ProtectedIntegrityProvider;
  token: string;
  expectedRequestHash: string;
};

export type IntegrityChallengeFailure =
  | "INTEGRITY_CHALLENGE_INVALID"
  | "INTEGRITY_CHALLENGE_REPLAYED"
  | "INTEGRITY_CHALLENGE_EXPIRED";

export function classifyIntegrityChallenge(input: {
  existsAndBound: boolean;
  challengeHashMatches: boolean;
  consumedAt: Date | null;
  expiresAt: Date | null;
  now?: Date;
}): IntegrityChallengeFailure | null {
  if (!input.existsAndBound || !input.challengeHashMatches || !input.expiresAt) return "INTEGRITY_CHALLENGE_INVALID";
  if (input.consumedAt) return "INTEGRITY_CHALLENGE_REPLAYED";
  if (input.expiresAt.getTime() <= (input.now ?? new Date()).getTime()) return "INTEGRITY_CHALLENGE_EXPIRED";
  return null;
}

type TestVerifier = (input: VerifyInput) => Promise<ProtectedIntegrityResult>;
let testVerifier: TestVerifier | null = null;

/** Test-only injection; production can never replace the platform verifier. */
export function setProtectedIntegrityVerifierForTests(verifier: TestVerifier | null): void {
  if (config.nodeEnv !== "test") throw new Error("Integrity verifier injection is test-only");
  testVerifier = verifier;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function googleCredentials(): { clientEmail: string; privateKey: string; packageName: string } | null {
  let clientEmail = config.protectedRace.googleClientEmail;
  let privateKey = config.protectedRace.googlePrivateKey;
  const raw = config.protectedRace.googleServiceAccountJson;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string };
      clientEmail ||= parsed.client_email?.trim() ?? null;
      privateKey ||= parsed.private_key?.replace(/\\n/g, "\n").trim() ?? null;
    } catch {
      return null;
    }
  }
  const packageName = config.protectedRace.googlePackageName;
  return clientEmail && privateKey && packageName ? { clientEmail, privateKey, packageName } : null;
}

let accessTokenCache: { token: string; expiresAtMs: number } | null = null;

async function googleAccessToken(credentials: NonNullable<ReturnType<typeof googleCredentials>>): Promise<string | null> {
  if (accessTokenCache && accessTokenCache.expiresAtMs > Date.now() + 60_000) return accessTokenCache.token;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: credentials.clientEmail,
    scope: "https://www.googleapis.com/auth/playintegrity",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(credentials.privateKey).toString("base64url")}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;
  const body = await response.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;
  accessTokenCache = { token: body.access_token, expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

async function verifyPlayIntegrity(input: VerifyInput): Promise<ProtectedIntegrityResult> {
  const provider = "android_play_integrity" as const;
  const credentials = googleCredentials();
  if (!credentials) return { ok: false, provider, code: "INTEGRITY_PROVIDER_NOT_CONFIGURED", retryable: true };
  try {
    const accessToken = await googleAccessToken(credentials);
    if (!accessToken) return { ok: false, provider, code: "INTEGRITY_PROVIDER_UNAVAILABLE", retryable: true };
    const response = await fetch(
      `https://playintegrity.googleapis.com/v1/${encodeURIComponent(credentials.packageName)}:decodeIntegrityToken`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ integrityToken: input.token }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      return { ok: false, provider, code: response.status >= 500 ? "INTEGRITY_PROVIDER_UNAVAILABLE" : "INTEGRITY_TOKEN_INVALID", retryable: response.status >= 500 };
    }
    const decoded = await response.json() as {
      tokenPayloadExternal?: {
        requestDetails?: { requestPackageName?: string; timestampMillis?: string; requestHash?: string };
        appIntegrity?: { appRecognitionVerdict?: string; packageName?: string; versionCode?: string };
        deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
      };
    };
    const payload = decoded.tokenPayloadExternal;
    const request = payload?.requestDetails;
    const app = payload?.appIntegrity;
    const devices = payload?.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    const timestampMs = Number(request?.timestampMillis ?? 0);
    if (request?.requestHash !== input.expectedRequestHash) {
      return { ok: false, provider, code: "INTEGRITY_REQUEST_HASH_MISMATCH", retryable: false };
    }
    if (request.requestPackageName !== credentials.packageName || app?.packageName !== credentials.packageName) {
      return { ok: false, provider, code: "INTEGRITY_APP_MISMATCH", retryable: false };
    }
    if (app.appRecognitionVerdict !== "PLAY_RECOGNIZED") {
      return { ok: false, provider, code: "INTEGRITY_APP_UNRECOGNIZED", retryable: false };
    }
    if (!devices.includes("MEETS_DEVICE_INTEGRITY")) {
      return { ok: false, provider, code: "INTEGRITY_DEVICE_FAILED", retryable: false };
    }
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 10 * 60_000) {
      return { ok: false, provider, code: "INTEGRITY_TOKEN_STALE", retryable: false };
    }
    return {
      ok: true,
      provider,
      reference: app.versionCode ?? null,
      details: { appRecognitionVerdict: app.appRecognitionVerdict, deviceRecognitionVerdict: devices },
    };
  } catch (error) {
    return { ok: false, provider, code: "INTEGRITY_PROVIDER_UNAVAILABLE", retryable: true, details: { error: String(error) } };
  }
}

export async function verifyProtectedIntegrity(input: VerifyInput): Promise<ProtectedIntegrityResult> {
  if (testVerifier) return testVerifier(input);
  if (input.provider === "android_play_integrity") return verifyPlayIntegrity(input);
  // App Attest assertion validation requires the installation's registered attestation public key.
  // The interface is intentionally fail-closed until that mobile registration ceremony is wired.
  return { ok: false, provider: "ios_app_attest", code: "IOS_APP_ATTEST_NOT_CONFIGURED", retryable: true };
}
