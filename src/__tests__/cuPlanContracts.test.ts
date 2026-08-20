import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeOutboxDelayMs } from "../lib/outbox.js";

describe("CU rollout safety contracts", () => {
  it("propagates a future outbox time as a BullMQ delay", () => {
    expect(computeOutboxDelayMs(new Date(15_000), 10_000)).toBe(5_000);
    expect(computeOutboxDelayMs(new Date(5_000), 10_000)).toBe(0);
  });

  it("keeps daily step table writes inside the walk route/checkpoint service", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const writerPattern = /(insert|update)\(stepDaily(Device)?TotalsTable/;
    const output = readdirSync(`${root}/src`, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts"))
      .filter((path) => writerPattern.test(readFileSync(`${root}/src/${path}`, "utf8")))
      .map((path) => `src/${path}`);
    expect(output.sort()).toEqual(["src/lib/walkRedisIngest.ts", "src/routes/walk.ts"]);
  });

  it("keeps authority migration additive and hot indexes concurrent", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const migration = readFileSync(`${root}/db/migrations/0032_walk_ingest_authority.sql`, "utf8");
    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(migration).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
    const concurrent = readFileSync(`${root}/db/concurrent-indexes.sql`, "utf8");
    expect(concurrent).toContain('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "step_sessions_ingest_session_key_idx"');
  });

  it("defers financial settlement when either Redis checkpoint barrier fails", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const races = readFileSync(`${root}/src/routes/races.ts`, "utf8");
    const completion = races.slice(races.indexOf("export async function autoCompleteRace"));
    expect(completion).toContain("await flushRedisRaceToPostgres(raceId)");
    expect(completion).toContain("redis flush failed — settlement deferred");
    expect(completion).toContain("await satisfyWalkSettlementBarrier(watermarks)");
    expect(completion).toContain("walk checkpoint barrier unsatisfied — settlement deferred");
    expect(completion).not.toContain("finalizing on last checkpoint");
  });

  it("keeps Redis credentials runtime-only and fails closed at process startup", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const compose = readFileSync(`${root}/docker-compose.coolify.yml`, "utf8");
    const apiEntrypoint = readFileSync(`${root}/deploy/coolify/api-entrypoint.sh`, "utf8");
    const workerEntrypoint = readFileSync(`${root}/deploy/coolify/worker-entrypoint.sh`, "utf8");
    const workerHealthcheck = readFileSync(`${root}/deploy/coolify/worker-healthcheck.sh`, "utf8");
    expect(compose).not.toContain("REDIS_PASSWORD:?REDIS_PASSWORD");
    expect(compose).toContain("REDIS_PASSWORD: ${REDIS_PASSWORD:-}");
    expect(apiEntrypoint).toContain('if [ -z "${REDIS_PASSWORD:-}" ]');
    expect(workerEntrypoint).toContain('if [ -z "${REDIS_PASSWORD:-}" ]');
    expect(workerHealthcheck).toContain('queue_url="redis://default:${queue_url#redis://:}"');
    expect(workerHealthcheck).toContain('redis-cli --no-auth-warning -u "${queue_url}" ping');
  });
});
