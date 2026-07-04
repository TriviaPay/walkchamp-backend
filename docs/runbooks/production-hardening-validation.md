# Production Hardening Validation

Run this before enabling strict production traffic gates. This is a release gate, not an architecture checklist.

## 1. Redis Runtime Configuration

Check the running Redis servers, not only compose or environment files.

```sh
redis-cli -u "$REDIS_CACHE_URL" CONFIG GET maxmemory
redis-cli -u "$REDIS_CACHE_URL" CONFIG GET maxmemory-policy
redis-cli -u "$REDIS_CACHE_URL" INFO memory

redis-cli -u "$REDIS_QUEUE_URL" CONFIG GET maxmemory-policy
redis-cli -u "$REDIS_QUEUE_URL" CONFIG GET appendonly
redis-cli -u "$REDIS_QUEUE_URL" CONFIG GET appendfsync
redis-cli -u "$REDIS_QUEUE_URL" INFO memory
redis-cli -u "$REDIS_QUEUE_URL" INFO stats
```

Expected:

- `redis-cache`: `maxmemory > 0`, `maxmemory-policy allkeys-lfu`
- `redis-cache`: container memory limit leaves headroom above Redis `maxmemory`
- `redis-queue`: `maxmemory-policy noeviction`, `appendonly yes`, `appendfsync everysec`
- `redis-queue`: container memory limit leaves headroom for AOF/replication/client/output buffers
- `redis-queue`: memory above 70% pages/warns, memory above 85% blocks worker readiness and pauses noncritical enqueue attempts
- `redis-queue`: any `evicted_keys > 0` is a production incident

For container memory headroom, check the actual deployment runtime. Examples:

```sh
docker inspect "$REDIS_CACHE_CONTAINER" --format '{{.HostConfig.Memory}}'
docker inspect "$REDIS_QUEUE_CONTAINER" --format '{{.HostConfig.Memory}}'
```

Block release if Redis `maxmemory` is set so close to the container limit that Redis overhead can OOM the container.

Also verify app readiness exposes the same runtime status:

```sh
curl -fsS -H "X-Health-Check-Token: $READINESS_DETAIL_TOKEN" "$API_BASE_URL/readyz"
curl -fsS -H "X-Health-Check-Token: $READINESS_DETAIL_TOKEN" "$API_BASE_URL/api/readyz"
```

Block release if queue Redis is shared with cache Redis while BullMQ workers or webhook processing are enabled.

## 2. Liveness And Readiness

Expected endpoints:

```sh
curl -fsS "$API_BASE_URL/livez"
curl -fsS "$API_BASE_URL/readyz"
curl -fsS "$API_BASE_URL/api/livez"
curl -fsS "$API_BASE_URL/api/readyz"
```

`/livez` only proves the process is alive and the event loop is responsive. Its public response must stay minimal.

`/readyz` public responses must not expose dependency details. Detailed checks require `X-Health-Check-Token: $READINESS_DETAIL_TOKEN` in production. Detailed `/readyz` must prove the instance is safe for traffic:

- Postgres query succeeds
- migration journal is readable
- redis-cache runtime policy is valid when rate limiting is enabled
- API role: redis-queue degradation is warning/degraded unless the endpoint requires queue availability
- worker role: redis-queue runtime policy, AOF, memory, and eviction gates are required
- worker role: split Redis is required before BullMQ webhook/worker processing is enabled
- event-loop p95 is below readiness threshold
- optional providers do not hard-fail readiness

Expected external response shape:

```json
{"status":"ready"}
```

or:

```json
{"status":"degraded"}
```

or:

```json
{"status":"not_ready"}
```

Dependency details belong in logs/metrics or token-authenticated readiness responses.

## 3. Origin Bypass

After Cloudflare proxying and origin firewall rules are enabled:

```sh
curl -i "https://api.example.com/api/healthz"
curl -i --resolve "api.example.com:443:$ORIGIN_IP" "https://api.example.com/api/healthz"
curl -i "https://$ORIGIN_IP/api/healthz"
```

Expected:

- Cloudflare hostname returns `200`
- direct origin IP or `--resolve` bypass is blocked by network firewall, AOP/mTLS, or returns a non-app response
- if historical DNS exposed the origin IP, rotate it before relying on Cloudflare-only ingress

## 4. Proxy Header Spoofing

With the origin locked down, verify the app trusts only explicit proxy IPs/subnets via `TRUST_PROXY_CIDRS`.

```sh
curl -i "$API_BASE_URL/api/healthz" \
  -H "X-Forwarded-For: 1.2.3.4" \
  -H "X-Forwarded-Proto: http" \
  -H "X-Forwarded-Host: attacker.example"
```

Expected:

- spoofed forwarded headers do not change rate-limit identity unless the request came through a trusted proxy
- do not use broad `trust proxy=true` unless the full proxy chain is controlled and overwrites forwarded headers

## 5. Webhook Correctness Under Queue Failure

Run these against staging with provider test secrets:

- raw body parser runs before JSON parsing and resource-budget checks
- valid signed webhook inserts provider ledger/outbox rows and returns `2xx`
- duplicate provider event returns `2xx` and creates no duplicate mutation
- redis-queue down still allows DB insert/outbox insert and returns `2xx`
- invalid signature returns `400` and creates no DB mutation
- request parsed as non-raw body fails signature verification
- out-of-order provider events are idempotent and safe

Do not make BullMQ availability part of the payment webhook acknowledgement path.

## 6. BullMQ Producer Failure Behavior

API enqueue producers must fail fast:

- `enableOfflineQueue: false`
- bounded enqueue timeout
- noncritical enqueue failure does not block HTTP responses

Workers may reconnect/retry normally. Validate by stopping `redis-queue` in staging and confirming API requests do not hang while outbox rows remain in Postgres for later dispatch.

## 7. Cache Deny By Default

Check authenticated/private API routes and known public media routes separately.

```sh
curl -i "$API_BASE_URL/api/healthz"
curl -i "$API_BASE_URL/api/me"
curl -i "$API_BASE_URL/api/leaderboard"
curl -i "$API_BASE_URL/api/profile/avatar/some-user-id"
```

Expected for normal/private API JSON:

```http
Cache-Control: no-store
Cloudflare-CDN-Cache-Control: no-store
CDN-Cache-Control: no-store
Surrogate-Control: no-store
```

Only whitelisted versioned media/static routes may override. Cloudflare cache hits should appear only on that whitelist, with Cache Deception Armor enabled.

## 8. Rate Limit Rollout

Initial posture:

- auth, signup, payment, webhook verification, and admin write limits may enforce early
- leaderboard, catalog, media, presence/race heartbeat, and broad room/race traffic start in monitor/log mode
- promote monitor -> challenge/degrade -> enforce only after false-positive review

Verify emitted headers on limited routes:

```http
Retry-After
RateLimit
RateLimit-Policy
RateLimit-Limit
RateLimit-Remaining
RateLimit-Reset
```

## 9. Resource Budgets

Validate request-count limits and resource budgets:

- JSON body max bytes
- JSON depth
- JSON array item count
- JSON string length
- JSON object key count
- upload bytes per request
- image dimensions/MIME/transform time for upload paths
- provider timeouts for payment calls
- DB result-size caps and admin export limits

The app enforces JSON shape budgets after parsing. Upload-specific dimensions/MIME/transform limits must be verified on the upload routes and object-processing pipeline.

## 10. Queue/Outbox Observability

Required alerts:

- redis-queue memory above 70% warning
- redis-queue memory above 85% critical and noncritical enqueue pause
- any redis-queue eviction critical
- sustained BullMQ stalled jobs critical
- outbox/webhook processing lag above 120 seconds critical
- redis-queue unavailable while outbox rows continue accumulating

Queue Redis outage must pause side-effect processing, not block DB writes or webhook `2xx`.

## 11. Do Not Enable On Day One

- Do not move money webhooks fully async.
- Do not switch `BLOOM_GUARDS_MODE` to `enforce`.
- Do not enable load shedding globally until thresholds are observed in production traffic.
- Do not enable BullMQ webhook processing without split Redis runtime validation passing.

## 12. Canary Kill Switches

If auth false positives spike:

```text
Set affected route group to monitor/degrade.
If needed, disable ENABLE_NEW_RATE_LIMITER.
Keep Cloudflare edge rules and API no-store headers active.
```

If webhook lag spikes:

```text
Keep webhook signature verification and DB insert inline.
Disable ENABLE_BULLMQ_WEBHOOK_PROCESSING.
Scale workers or pause noncritical queues.
Do not make BullMQ availability part of webhook 2xx acknowledgement.
```

If queue Redis memory rises:

```text
Pause noncritical enqueue sources.
Inspect delayed, failed, stalled, and retained jobs.
Reduce BullMQ retention temporarily if needed.
Treat any redis-queue eviction as critical.
```

If cache causes incorrect or stale responses:

```text
Disable ENABLE_CACHE_GET_OR_COMPUTE.
Keep API Cache-Control/Cloudflare-CDN-Cache-Control/CDN-Cache-Control/Surrogate-Control no-store defaults active.
Purge only cache-eligible public media/static routes.
```

If load shedding triggers incorrectly:

```text
Disable ENABLE_LOAD_SHEDDING.
Keep route-level rate limits and circuit breakers active.
Review DB pool waiters, event-loop delay, and active request thresholds before re-enabling.
```

If Bloom guards block legitimate IDs:

```text
Set BLOOM_GUARDS_MODE=monitor or off.
Rebuild the next Bloom version without flipping active_version until verification passes.
Never use Bloom guards as a correctness dependency for payment, wallet, auth, registration, or race finalization.
```
