# Secrets And Host Baseline

## Secrets model

- Coolify-managed environment variables are the runtime source of truth.
- Cloudflare, Neon, Descope, Stripe, Razorpay, OneSignal, LiveKit, and R2 credentials are not stored in the repo.
- `.env` stays local-only and ignored.
- Runtime secrets must never be baked into images.
- Secret rotation requires redeploying the affected Coolify services.

## Required production secret groups

- app routing: `APP_BASE_URL`, `ALLOWED_ORIGINS`, `TRUST_PROXY_HOPS`
- database: `DATABASE_RUNTIME_URL`, `DATABASE_ADMIN_URL`
- auth: `DESCOPE_PROJECT_ID`, `DESCOPE_MANAGEMENT_KEY`
- realtime: `PUSHER_*`
- push: `ONESIGNAL_*`
- payments: `STRIPE_*`, `RAZORPAY_*`
- voice: `LIVEKIT_*`
- storage: `OBJECT_STORAGE_*`
- admin: `ADMIN_API_KEY`, `ADMIN_SERVICE_KEY`, `ADMIN_USER_IDS`

## Host baseline

- SSH: key-only
- Password login: disabled
- Coolify host: patched on a regular cadence
- Docker and Coolify logs retained long enough for incident review
- Firewall: allow only required ingress
- Redis containers are never exposed with a public host port
- Cloudflare DNS starts as `DNS only`, not as the final hardened state

## Object storage policy

- R2 is the only active object storage backend.
- Media keys are backend-generated only.
- Prefixes stay separated by asset type:
  - `avatars/`
  - `group-images/`
  - `race-themes/`
- Public reads go through the R2 custom domain.
- Writes go through the S3-compatible R2 endpoint.
- Day-1 compatibility routes stay enabled until direct-public or redirect-based delivery is proven safe.

## Redis persistence and backup

- `redis-cache` uses bounded memory with `allkeys-lfu` eviction by default.
- `redis-queue` runs with `maxmemory-policy noeviction`.
- `redis-queue` runs with `appendonly yes`.
- `redis-queue` runs with `appendfsync everysec`.
- `redis-queue` keeps RDB snapshots.
- `redis-queue` data lives on a named Docker volume.
- Coolify instance backup is not enough for Redis queue recovery.
- `redis-queue` volume backups must be copied off-host to R2 daily.
- Monthly `redis-queue` restore drills are mandatory.

## Kill switches

These remain valid env-backed controls:

- disable worker processing
- disable uploads
- disable payments
- disable signups
- disable push delivery
- global maintenance mode
