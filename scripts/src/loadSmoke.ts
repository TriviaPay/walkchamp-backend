import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";

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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function runConcurrentRequests(
  baseUrl: string,
  path: string,
  totalRequests: number,
  concurrency: number,
) {
  let nextIndex = 0;
  const latencies: number[] = [];
  let ok = 0;
  let nonOk = 0;

  async function worker() {
    while (true) {
      const current = nextIndex++;
      if (current >= totalRequests) return;

      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}${path}`);
      latencies.push(performance.now() - startedAt);

      if (response.ok) ok++;
      else nonOk++;
      await response.arrayBuffer();
    }
  }

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = performance.now() - startedAt;

  return {
    totalRequests,
    concurrency,
    ok,
    nonOk,
    elapsedMs,
    requestsPerSecond: totalRequests / (elapsedMs / 1000),
    avgMs: latencies.reduce((sum, n) => sum + n, 0) / latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: Math.max(...latencies),
  };
}

async function main() {
  loadDotEnvFile(".env");

  const port = String(4500 + Math.floor(Math.random() * 200));
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: port,
    RUN_BACKGROUND_JOBS: "false",
    CASH_FEATURES_ENABLED: "false",
  };

  const serverProcess: ChildProcessWithoutNullStreams = spawn(
    "node",
    ["--enable-source-maps", "./dist/index.mjs"],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );

  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealthy(baseUrl);

    const healthLoad = await runConcurrentRequests(baseUrl, "/api/healthz", 250, 25);

    const limiterStatuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      const response = await fetch(`${baseUrl}/api/auth/username-check?username=admin123`);
      limiterStatuses.push(response.status);
      await response.arrayBuffer();
    }

    const first429 = limiterStatuses.findIndex((status) => status === 429);

    console.log(JSON.stringify({
      healthLoad,
      authLimiter: {
        attempts: limiterStatuses.length,
        first429Attempt: first429 >= 0 ? first429 + 1 : null,
        finalStatuses: limiterStatuses.slice(-5),
      },
    }, null, 2));
  } finally {
    serverProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      serverProcess.once("exit", () => resolve());
      setTimeout(() => {
        serverProcess.kill("SIGKILL");
        resolve();
      }, 2_000);
    });

    if (stderr.trim()) {
      console.error(stderr.trim());
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
