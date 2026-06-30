# Deployment And Recovery Runbook

## Active deployment model

- One OVH VPS runs Coolify.
- Coolify deploys `docker-compose.coolify.yml`.
- Services are `api`, `worker`, and `redis`.
- Neon remains the source of truth for Postgres.
- Cloudflare R2 is the only active object storage backend.

## Standard deploy order

1. Confirm cutover and release gates in `docs/runbooks/object-storage-cutover.md` and `docs/runbooks/staging-and-release-gate.md`.
2. Confirm a pre-deploy Neon restore point or equivalent restore window.
3. Confirm the pre-cutover git tag, current image digest, and env snapshot are recorded.
4. Build and deploy the new image in Coolify.
5. Run migrations:

```bash
docker compose -f docker-compose.coolify.yml run --rm api /usr/local/bin/run-migrations
```

6. Start or redeploy the stack.
7. Verify:
   - `/api/healthz`
   - `/api/readyz`
   - one authenticated request
   - one worker-owned recurring job or queue-backed action
   - avatar, group image, and theme image fetches
8. Inspect logs for:
   - media proxy failures
   - Redis connection errors
   - Neon connection errors
   - provider auth errors
9. Mark the release healthy only after the checks pass.

## Cutover gate

Do not ship the OVH-only release until all are true:

- R2 bucket is active.
- R2 custom domain is active.
- OCI-to-R2 copy finished for `avatars/`, `group-images/`, and `race-themes/`.
- Object counts match by prefix.
- Missing-key report is empty or explicitly accepted.
- Sample objects were verified for size, content type, and public readability.
- A DB restore point exists.
- Real client checks passed for avatar, group-image, and theme loading.

## Rollback

OCI is not a runtime fallback.

Rollback artifacts remain mandatory:

- pre-cutover git tag
- previous container image digest
- env snapshot
- Neon restore point
- media-copy verification output

### App rollback

Use when the schema remains compatible:

1. Redeploy the previous image digest in Coolify.
2. Re-apply the previous env snapshot if config changed.
3. Restart `worker`, then `api`.
4. Re-run smoke checks.

### Database rollback

Priority order:

1. Neon restore or branch restore when suitable.
2. Verified `pg_dump` from R2 only when Neon-native recovery is unavailable or unsuitable.

### Redis recovery

1. Restore the latest verified Redis volume archive into a disposable container first.
2. Validate that the archive boots and responds.
3. Only then restore to the live Redis data directory.

## Post-cutover hardening

DNS-only is temporary.

After the cutover stabilizes:

1. Move `api.<domain>` to proxied Cloudflare mode.
2. Revalidate `X-Forwarded-*` behavior.
3. Revisit `TRUST_PROXY_HOPS`.
4. Restrict origin ingress to Cloudflare IPs where practical.
5. Re-test health checks and long-lived connections.
