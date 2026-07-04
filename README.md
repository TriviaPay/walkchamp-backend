# Walk Champ Backend

Express API plus worker for step ingestion, race state, wallets, chat, groups, and media.

## Current production target

- `OVH VPS-2`
- `Coolify`
- `api` container
- `worker` container
- split local Redis (`redis-cache` for cache/rate limits and `redis-queue` for BullMQ/outbox)
- `Neon` Postgres
- `Cloudflare DNS`
- `Cloudflare R2`

There is no active OCI, Render, or Vercel production path in the runtime or deploy docs. Legacy platform assets live under `archive/`.

## Local development

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Useful commands:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm db:adopt-existing
pnpm storage:rewrite-urls
```

## Production deployment

Primary deployment files:

- `Dockerfile`
- `docker-compose.coolify.yml`
- `deploy/coolify/run-migrations.sh`
- `deploy/coolify/worker-entrypoint.sh`
- `deploy/coolify/worker-healthcheck.sh`

Primary runbooks:

- `docs/architecture/ovh-production-minimal.md`
- `docs/runbooks/deployment-and-recovery.md`
- `docs/runbooks/object-storage-cutover.md`
- `docs/runbooks/secrets-and-host-baseline.md`
- `docs/runbooks/staging-and-release-gate.md`

Run migrations before promoting a release:

```bash
docker compose -f docker-compose.coolify.yml run --rm api /usr/local/bin/run-migrations
```

## Object storage

Runtime object storage is provider-neutral S3-compatible storage configured through:

- `OBJECT_STORAGE_ENDPOINT`
- `OBJECT_STORAGE_REGION`
- `OBJECT_STORAGE_BUCKET`
- `OBJECT_STORAGE_ACCESS_KEY_ID`
- `OBJECT_STORAGE_SECRET_ACCESS_KEY`
- `OBJECT_STORAGE_PUBLIC_BASE_URL`

Day-1 cutover keeps compatibility routes under:

- `/api/profile/avatar/:userId`
- `/api/groups/:groupId/image`
- `/api/track-themes/:code/image`

Old OCI asset URLs can be rewritten after copy verification with:

```bash
pnpm storage:rewrite-urls
pnpm storage:rewrite-urls --apply
```

## Backups

Repo-provided backup helpers:

- `ops/backup/pgdump-to-r2.sh`
- `ops/backup/redis-volume-backup.sh`
- `ops/backup/redis-restore-drill.sh`

These are operator scripts. They assume `aws`, `zstd`, and for restore drills `docker` are installed where they run.
