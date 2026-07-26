/**
 * §26 Load & scale harness for the hybrid live + verified step pipeline.
 *
 * Drives N virtual participants against a RUNNING deployment (local, staging, or a load
 * environment) at a realistic 3–5s cadence, optionally interleaving periodic verified
 * submissions, and reports API latency percentiles, throughput, and error rate.
 *
 * It targets a real base URL + auth token + race id rather than spinning up its own server,
 * because a meaningful run needs a seeded active race, Redis-live state, and a DB — the same
 * infra the metrics (Redis memory, DB load, event volume) are measured on. See
 * docs/hybrid-load-testing.md for the full methodology and how to capture the infra-side metrics.
 *
 * Usage:
 *   BASE_URL=https://staging.example.com \
 *   RACE_ID=<uuid> \
 *   AUTH_TOKENS=tokenA,tokenB,...   # one bearer per virtual participant (or AUTH_TOKEN for all) \
 *   PARTICIPANTS=1000 DURATION_SECONDS=120 UPLOAD_INTERVAL_MS=4000 VERIFY_EVERY=8 \
 *   tsx ./scripts/src/loadHybridRace.ts
 */
import { performance } from "node:perf_hooks";

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

interface Metrics {
  latencies: number[];
  ok: number;
  clientErr: number; // 4xx
  serverErr: number; // 5xx / network
  skipped: number; // accepted:false / skipped duplicates
}

async function main() {
  const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const raceId = process.env.RACE_ID;
  if (!raceId) throw new Error("RACE_ID is required");

  const tokens = (process.env.AUTH_TOKENS ?? process.env.AUTH_TOKEN ?? "")
    .split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("AUTH_TOKENS (csv) or AUTH_TOKEN is required");

  const participants = envInt("PARTICIPANTS", 1000);
  const durationMs = envInt("DURATION_SECONDS", 120) * 1000;
  const uploadIntervalMs = envInt("UPLOAD_INTERVAL_MS", 4000);
  const verifyEvery = envInt("VERIFY_EVERY", 0); // 0 = never; N = submit a verification every Nth tick
  const stepsPerTick = envInt("STEPS_PER_TICK", 18); // ~4.5 steps/s over 4s — under the 6/s cap

  console.log(JSON.stringify({
    run: "hybrid-load", baseUrl, raceId, participants, durationSeconds: durationMs / 1000,
    uploadIntervalMs, verifyEvery, stepsPerTick, tokenPool: tokens.length,
  }));

  const m: Metrics = { latencies: [], ok: 0, clientErr: 0, serverErr: 0, skipped: 0 };
  const startedAt = performance.now();

  async function participant(i: number) {
    const token = tokens[i % tokens.length]!;
    const sessionId = `load-${i}-${startedAt.toFixed(0)}`;
    let seq = 0;
    let cumulative = 0;
    // Stagger starts across the upload window so uploads don't thundering-herd on one tick.
    await sleep((i % uploadIntervalMs));
    while (performance.now() - startedAt < durationMs) {
      seq += 1;
      cumulative += stepsPerTick;
      const t0 = performance.now();
      try {
        const res = await fetch(`${baseUrl}/api/races/${raceId}/progress`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            steps: cumulative, sequenceId: seq, sessionId,
            stepSource: i % 2 === 0 ? "android_step_counter" : "ios_pedometer",
            deviceTime: new Date().toISOString(),
          }),
        });
        m.latencies.push(performance.now() - t0);
        if (res.ok) m.ok += 1;
        else if (res.status >= 500) m.serverErr += 1;
        else m.clientErr += 1;
        await res.arrayBuffer();
      } catch {
        m.latencies.push(performance.now() - t0);
        m.serverErr += 1;
      }

      if (verifyEvery > 0 && seq % verifyEvery === 0) {
        try {
          const res = await fetch(`${baseUrl}/api/races/${raceId}/verify`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({
              verifiedCumulativeSteps: cumulative,
              source: i % 2 === 0 ? "health_connect" : "healthkit",
              measuredAtUtc: new Date().toISOString(),
            }),
          });
          if (!res.ok && res.status < 500) m.clientErr += 1;
          await res.arrayBuffer();
        } catch { /* verification errors are non-fatal to the run */ }
      }

      await sleep(uploadIntervalMs + jitter(i, seq));
    }
  }

  await Promise.all(Array.from({ length: participants }, (_, i) => participant(i)));
  const elapsedMs = performance.now() - startedAt;
  const total = m.ok + m.clientErr + m.serverErr;

  console.log(JSON.stringify({
    summary: {
      participants, elapsedSeconds: +(elapsedMs / 1000).toFixed(1),
      progressRequests: total,
      requestsPerSecond: +(total / (elapsedMs / 1000)).toFixed(1),
      ok: m.ok, clientErr: m.clientErr, serverErr: m.serverErr,
      errorRatePct: +((100 * (m.clientErr + m.serverErr)) / Math.max(total, 1)).toFixed(2),
      latencyMs: {
        p50: +percentile(m.latencies, 50).toFixed(1),
        p95: +percentile(m.latencies, 95).toFixed(1),
        p99: +percentile(m.latencies, 99).toFixed(1),
        max: +Math.max(0, ...m.latencies).toFixed(1),
      },
    },
    note: "Capture Redis memory (INFO memory), DB connections/CPU, and Pusher event volume out-of-band during the run — see docs/hybrid-load-testing.md.",
  }, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
// Deterministic jitter (no Math.random) so runs are reproducible: ±400ms based on indices.
function jitter(i: number, seq: number): number {
  return ((i * 131 + seq * 17) % 800) - 400;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
