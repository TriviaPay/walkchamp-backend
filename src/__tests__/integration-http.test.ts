import fs from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

async function waitForHealthy(baseUrl: string, timeoutMs = 15_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/healthz`);
      if (response.ok) return;
    } catch {
      // Server not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Timed out waiting for ${baseUrl}/api/healthz`);
}

let serverProcess: ChildProcessWithoutNullStreams | null = null;
let baseUrl = "";

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();

  try {
    return { response, json: JSON.parse(text) as unknown, text };
  } catch {
    return { response, json: null, text };
  }
}

beforeAll(async () => {
  loadDotEnvFile(".env");

  const buildResult = spawnSync("node", ["./build.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
    },
    stdio: "pipe",
  });
  if (buildResult.status !== 0) {
    throw new Error(`Failed to build integration server:\n${buildResult.stderr.toString()}`);
  }

  const port = String(4300 + Math.floor(Math.random() * 200));
  baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: port,
    RUN_BACKGROUND_JOBS: "false",
    CASH_FEATURES_ENABLED: "false",
  };

  serverProcess = spawn("node", ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });

  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  serverProcess.on("exit", (code) => {
    if (code && code !== 0) {
      throw new Error(`Integration server exited early with code ${code}\n${stderr}`);
    }
  });

  await waitForHealthy(baseUrl);
}, 30_000);

afterAll(async () => {
  if (!serverProcess) return;

  serverProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    serverProcess?.once("exit", () => resolve());
    setTimeout(() => {
      serverProcess?.kill("SIGKILL");
      resolve();
    }, 2_000);
  });
});

describe("HTTP integration smoke", () => {
  it("serves the health endpoint", async () => {
    const { response, json } = await request("/api/healthz");
    expect(response.status).toBe(200);
    expect(json).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("surrogate-control")).toBe("no-store");
  });

  it("serves the liveness endpoint", async () => {
    const { response, json } = await request("/livez");
    expect(response.status).toBe(200);
    expect(json).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the readiness endpoint", async () => {
    const { response, json } = await request("/api/readyz");
    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      status: "ready",
      checks: {
        database: "skipped",
        migrations: "skipped",
        config: "ok",
      },
    });
  });

  it("preserves the incoming request id", async () => {
    const requestId = "integration-test-request-id";
    const { response } = await request("/api/healthz", {
      headers: {
        "x-request-id": requestId,
      },
    });
    expect(response.headers.get("x-request-id")).toBe(requestId);
  });

  it("rejects unauthenticated access on a protected route", async () => {
    const { response } = await request("/api/leaderboard");
    expect(response.status).toBe(401);
  });

  it("does not expose admin stats to anonymous callers", async () => {
    const { response } = await request("/api/admin/stats");
    expect([401, 404]).toContain(response.status);
  });

  it("blocks cash routes when cash features are disabled", async () => {
    const blockedRequests: Array<{ path: string; init?: RequestInit }> = [
      { path: "/api/wallet/summary" },
      { path: "/api/wallet/deposit/list" },
      { path: "/api/wallet/withdraw", init: { method: "POST" } },
      { path: "/api/payments/test/refund-request", init: { method: "POST" } },
    ];

    for (const blocked of blockedRequests) {
      const { response, json } = await request(blocked.path, blocked.init);
      expect(response.status, blocked.path).toBe(404);
      expect(json, blocked.path).toMatchObject({
        code: "CASH_FEATURES_DISABLED",
      });
    }
  });

  it("exposes password sign-in without classifying it as a disabled cash route", async () => {
    const { response, json } = await request("/api/auth/password/signin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ loginId: "test@example.com" }),
    });

    expect(response.status).toBe(400);
    expect(json).toMatchObject({
      error: "invalid_request",
    });
  });

  it("rejects invalid username format without a database write", async () => {
    const { response, json } = await request("/api/auth/username-check?username=abc");
    expect(response.status).toBe(200);
    expect(json).toEqual({
      available: false,
      reason: "invalid_format",
    });
  });

  it("blocks reserved usernames", async () => {
    const { response, json } = await request("/api/auth/username-check?username=admin123");
    expect(response.status).toBe(200);
    expect(json).toEqual({
      available: false,
      reason: "blocked",
    });
  });
});
