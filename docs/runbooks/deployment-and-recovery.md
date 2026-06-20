# Deployment And Recovery Runbook

## Release Layout

- Releases live under `/srv/walkchamp/releases/<timestamp>`.
- `/srv/walkchamp/current` points to the active release.
- Runtime env files live outside releases under `/etc/walkchamp`.
- Logs live under `/var/log/walkchamp`.
- Keep the last `5` releases unless disk pressure requires fewer.

## Deployment Order

1. Upload or unpack the release to `/srv/walkchamp/releases/<timestamp>`.
2. Install production dependencies and build artifacts.
3. Validate env/config with the new release.
4. Stop or quiesce the worker if migrations affect job-mutated tables.
5. Run migrations using the admin DB role.
6. Restart `walkchamp-worker`.
7. Restart `walkchamp-api`.
8. Run smoke checks:
   - `/api/healthz`
   - `/api/readyz`
   - auth-protected request
   - worker heartbeat or queue execution
9. Inspect logs and Sentry.
10. Mark the release healthy.

## Migration Rules

- Use expand/contract migrations only.
- Do not pair destructive schema removal with the first release that depends on the new schema.
- Large backfills must be resumable and must not run inside API startup.
- DB restore is disaster recovery, not a routine rollback strategy.

## Rollback Branches

### App-only rollback

- Use when the schema is compatible.
- Repoint `/srv/walkchamp/current` to the previous release.
- Restart worker, then API.

### App rollback on compatible schema

- Same as app-only rollback, but confirm the old release is compatible with the live schema before restart.

### Disaster recovery

- Use Neon restore only when the live database state must be reverted.
- Restore to a separate recovery branch first when possible.
- Expect connection interruption during restore activity.

## Neon Continuity

- Confirm the actual Neon restore window for the production plan before go-live.
- Run restore drills against a staging or recovery branch.
- Decide whether long-retention `pg_dump` backups are required beyond Neon PITR.
- Keep backup or recovery credentials separate from runtime credentials.

## Disk And Log Policy

- Install `logrotate` and rotate `/var/log/walkchamp/*.log`.
- Alert on disk usage above `80%`; escalate above `90%`.
- Emergency cleanup:
  - remove old releases beyond retention count
  - rotate and compress stale logs
  - clear abandoned temp files under `/tmp`
