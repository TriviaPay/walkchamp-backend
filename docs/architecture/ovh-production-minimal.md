# OVH Production Minimal

## Baseline

This repo now targets a low-cost single-node production shape:

- one OVH VPS-2
- Coolify on the same host
- one API container
- one worker container
- split local Redis containers (`redis-cache` and `redis-queue`)
- Neon Postgres
- Cloudflare DNS
- Cloudflare R2 with a custom public domain

This is intentionally not HA. It is a pragmatic single-host setup for moderate traffic and bounded media sizes.

## Runtime model

- `api` handles HTTP, auth, payments, groups, race state APIs, and media compatibility routes.
- `worker` owns recurring jobs and background processing.
- `redis-cache` and `redis-queue` are local-only and never publicly exposed.
- `redis-cache` may evict cache/rate-limit/Bloom/lock keys under memory pressure.
- `redis-queue` must use `noeviction` with AOF enabled so BullMQ queue keys are never removed by Redis eviction.
- Postgres stays in Neon.
- Object storage reads and writes go to R2 through a provider-neutral S3-compatible client.

## Media compatibility phase

Day-1 cutover keeps backend-owned compatibility routes:

- `/api/profile/avatar/:userId`
- `/api/groups/:groupId/image`
- `/api/track-themes/:code/image`

These routes:

- return `200 image/*` responses instead of redirects
- stream from object storage without buffering whole files
- support `HEAD`
- reject `Range`
- enforce `5 MB` for avatars and group images
- enforce `10 MB` for theme images
- log route name, object key, upstream status, latency, bytes served, and response status

This is a temporary cutover mode. Long term, direct R2 delivery or redirects should replace API-proxied media after client verification.

## Cutover model

There is no active OCI runtime fallback.

Rollback artifacts remain mandatory:

- pre-cutover git tag
- previous image digest
- env snapshot
- Neon restore point
- media verification report

## Backup model

- Neon restore or PITR is the first DB rollback path.
- Nightly `pg_dump` to R2 is the portable secondary backup.
- Coolify instance backup is required but does not cover Redis data.
- `redis-queue` persistence files must be copied off-host to R2 daily.
- Monthly `redis-queue` restore drills are part of normal operations.

## Security posture

Initial cutover uses Cloudflare `DNS only` for lower complexity.

That is not the hardened final state. After cutover:

- move the API record to proxied mode
- validate forwarded-header behavior
- revisit `TRUST_PROXY_HOPS`
- prefer explicit `TRUST_PROXY_CIDRS`
- tighten origin firewall rules to Cloudflare IP ranges only
- add Authenticated Origin Pulls/mTLS where supported
- rotate the origin IP first if DNS history exposed it

## Upgrade triggers

Move beyond this baseline when any of these become persistent:

- CPU contention between API and worker
- Redis memory pressure
- sustained media proxy bandwidth pressure
- need for zero-downtime host maintenance
- stricter availability targets than a single VPS can offer
