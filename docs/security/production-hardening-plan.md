# Production Hardening Plan

Before production enablement, run the release gate in [production-hardening-validation.md](../runbooks/production-hardening-validation.md). The plan below is not considered complete until those runtime checks pass against the deployed environment.

## Deployment invariants

- Cloudflare is the first public edge for API traffic, but the origin must still reject direct public ingress.
- If historical DNS or logs reveal the origin IP, rotate the origin IP before depending on Cloudflare-only firewall rules.
- Use Full Strict TLS and Authenticated Origin Pulls/mTLS where supported.
- Cloudflare Tunnel is the preferred stronger origin-isolation target if public inbound origin exposure remains a concern.
- Do not enable Free-plan Bot Fight Mode on webhook hostnames; it cannot be skipped for payment providers. Use Super Bot Fight Mode/Bot Management skip rules or a dedicated webhook hostname.

## Cache policy

Default API responses must stay private:

```http
Cache-Control: no-store
Cloudflare-CDN-Cache-Control: no-store
CDN-Cache-Control: no-store
Surrogate-Control: no-store
```

Only explicitly whitelisted public, versioned media/static routes may override this. Enable Cache Deception Armor for cache-eligible Cloudflare rules.

## Redis roles

| Role | Policy | Persistence | Workloads |
| --- | --- | --- | --- |
| `redis-cache` | `allkeys-lfu` | optional | cache, negative cache, rate limits, Bloom bitmaps, locks |
| `redis-queue` | `noeviction` | AOF `everysec` | BullMQ queues, delayed jobs, retries, outbox dispatch |

`volatile-lfu` is allowed only if release checks prove every cache/rate-limit/negative-cache/Bloom/lock key has TTL discipline or an explicit memory budget.

Queue Redis capacity gates:

- alert above 70% memory
- pause noncritical enqueue sources above 85%
- any queue Redis eviction is a production incident
- API producers use fail-fast BullMQ connections with bounded enqueue timeouts
- workers can reconnect/retry normally, but worker readiness requires healthy queue Redis

## Webhook critical path

Payment webhooks must not depend on BullMQ availability:

```text
verify raw body signature
-> insert provider webhook ledger row and outbox_events row in one DB transaction
-> commit
-> return 2xx
-> worker later enqueues/processes idempotently
```

Provider IP allowlists are optional defense in depth. Signature verification and provider event ID uniqueness are the correctness controls.

## Kill switches

- `ENABLE_EDGE_STRICT_MODE`
- `ENABLE_NEW_RATE_LIMITER`
- `ENABLE_CACHE_GET_OR_COMPUTE`
- `BLOOM_GUARDS_MODE=off|monitor|enforce`
- `ENABLE_LOAD_SHEDDING`
- `ENABLE_BULLMQ_WEBHOOK_PROCESSING`
- `ENABLE_CIRCUIT_BREAKERS`

New route budgets should launch in monitor/log mode before hard blocking when the route is not auth, payment, admin, or abuse-critical.

## Health endpoints

`/livez` returns only minimal liveness. `/readyz` hides dependency detail in production unless `X-Health-Check-Token` matches `READINESS_DETAIL_TOKEN`.

API readiness treats queue Redis problems as degraded unless a request path strictly requires queue availability. Worker readiness requires queue Redis `noeviction`, AOF, memory, and eviction gates to pass.

## Express proxy trust

Prefer `TRUST_PROXY_CIDRS` with explicit Cloudflare/load-balancer subnets. Avoid `trust proxy=true`; if hop-count trust is used temporarily, verify the full proxy chain overwrites `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`.
