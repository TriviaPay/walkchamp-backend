# Hybrid Live + Verified Steps — Load & Scale Testing (§26)

This document defines the load-test methodology for the hybrid step pipeline, the harness, the
metrics to capture, and the recommended operational limits derived from the architecture.

## Harness

`scripts/src/loadHybridRace.ts` (`npm run test:load:hybrid`) drives N virtual participants against
a **running** deployment at a realistic 3–5s cadence and reports API latency percentiles,
throughput, and error rate. It targets a real base URL because the metrics that matter (Redis
memory, DB load, event volume) live on that infra.

```bash
BASE_URL=https://staging.example.com \
RACE_ID=<active-race-uuid> \
AUTH_TOKENS=<bearer1>,<bearer2>,...   # one per virtual participant, or AUTH_TOKEN for all \
PARTICIPANTS=1000 DURATION_SECONDS=120 UPLOAD_INTERVAL_MS=4000 VERIFY_EVERY=8 \
npm run test:load:hybrid
```

Preconditions: an `in_progress` race with `ENABLE_REDIS_LIVE_RACE=true` (redis-mode hot path) and
`ENABLE_HYBRID_RECONCILIATION=true` (verify endpoint + reconciliation), and the participants joined.

## Workload profile

| Knob | Default | Rationale |
|------|---------|-----------|
| Upload cadence | 4s (±0.4s jitter) | Spec §10: uploads arrive every 3–5s when progress changes |
| Steps/tick | 18 (~4.5 steps/s) | Under the 6 steps/s anti-cheat cap so nothing clamps |
| `sessionId` | one per participant | Exercises §8 session binding |
| `VERIFY_EVERY` | 8 ticks | Periodic verified submissions feed reconciliation |
| Sources | alternating step_counter / pedometer | Both provisional live sources |

## Scenarios to run

1. **Large active race** at 1,000 then 10,000 participants (higher where infra permits).
2. **3–5s participant updates** (the default cadence) — steady-state latency.
3. **Redis leaderboard writes** — every accepted tick is one `ZADD` + `SADD` in one Lua `EVAL`.
4. **Real-time event throttling** — confirm broadcasts are coalesced (~1/750ms/race), independent of ingest.
5. **Offline replay bursts** — pause a subset, then resume with backlogged sequences (monotonic max compacts them).
6. **Verification batches** — set `VERIFY_EVERY` low to stress the verify endpoint + finalization pass.
7. **Race finalization** — complete the race under load; confirm the reconciliation pass + payout run once.
8. **Concurrent session conflicts** — reuse a token with two `sessionId`s alternating rapidly.

## Metrics to capture (out-of-band, during each run)

| Metric | How |
|--------|-----|
| API latency (p50/p95/p99) | harness output |
| Error rate | harness output (4xx vs 5xx split) |
| Redis memory | `redis-cli -u $REDIS_LIVE_URL INFO memory` (used_memory_human) before/after |
| Redis ops | `redis-cli INFO commandstats` — `EVAL`/`ZADD`/`ZREVRANGE` call counts |
| DB connections / CPU | provider dashboard (Neon) — pooled connections should stay flat (hot path is zero-SQL in redis mode) |
| Event volume | Pusher dashboard — messages/sec should track ~1/750ms/race, NOT 1/tick |
| Queue behavior | BullMQ depth (checkpoint/finalize jobs) — should not back up |

## Expected shape (from the architecture, to be confirmed by a real run)

- **Hot path is O(1) Redis per tick** in redis-mode: one Lua `EVAL` (sequence dedup + monotonic max +
  rate cap + goal-cross + `ZADD` + dirty `SADD`). No SQL on a normal accepted tick.
- **Broadcasts are bounded** by the 750ms coalescing lease per race, so event volume is decoupled
  from ingest rate — 10,000 participants at 4s cadence still emit ≈1.3 leaderboard events/s/race.
- **Redis memory** ≈ per-participant HASH (~12 small fields) + one ZSET member + one name entry.
  Budget ~1–2 KB/participant ⇒ ~1–2 MB per 1,000, ~10–20 MB per 10,000 (confirm with `INFO memory`).
- **Checkpointing** drains the dirty set on a cadence, so Postgres writes are batched, not per-tick.

## Recommended operational limits (starting points; tighten from measured data)

- **Redis-live**: dedicated instance, `noeviction`, AOF on. Alert at 60% `maxmemory`.
- **Per-race participants**: comfortable to ~10,000 on the redis hot path; beyond that, shard
  leaderboard reads (top-N only; avoid full `ZREVRANGE 0 -1` on the request path).
- **Upload cadence**: enforce ≥3s server-side rate limiting per participant; the client should not
  send every sensor event (§10).
- **Broadcast lease**: keep at 750ms; raise if Pusher message budget is tight at very high race counts.
- **Verification cadence**: cap verify submissions to ≤1 per participant per ~10s; reconciliation is
  deferred to finalization so in-race verify writes are just an additive column update.

## Status

Harness and methodology are committed. A full 1,000 / 10,000-participant run must be executed
against a provisioned staging/load environment (real Redis-live + Neon + Pusher); the numeric
results table is filled in from that run and is not produced by CI.
