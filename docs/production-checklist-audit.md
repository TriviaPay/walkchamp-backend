# Backend Production Checklist Audit

## Current truth

The active production path in this repo is now:

- OVH VPS-2
- Coolify
- `api` container
- `worker` container
- local Redis
- Neon Postgres
- Cloudflare DNS
- Cloudflare R2

Legacy OCI, Render, and Vercel assets are archive-only and are not part of the live deployment path.

## Implemented

- Typed runtime config validates required production `OBJECT_STORAGE_*` envs.
- Active object storage runtime is provider-neutral S3-compatible code.
- Day-1 media compatibility routes stream `200 image/*` responses from object storage.
- Media routes support `HEAD`, reject `Range`, preserve key headers, and enforce size limits.
- Compose deployment exists for Coolify with `api`, `worker`, and `redis`.
- Redis persistence is configured with AOF plus RDB snapshots on a named volume.
- Backup helper scripts exist for nightly `pg_dump`, Redis volume backup, and Redis restore drills.
- URL rewrite tooling exists for old OCI asset URLs after copy verification.

## Still operator-dependent

- External OCI-to-R2 copy and verification
- Neon restore-point creation before cutover
- Coolify env population
- Cloudflare custom domain and DNS setup
- Daily execution of backup scripts
- Monthly Redis restore drills
- Post-cutover move from `DNS only` to proxied Cloudflare mode

## Launch blockers

Do not call production ready until these are complete:

- OCI-to-R2 copy verified by prefix count and sample reads
- DB rewrite dry-run reviewed, then applied
- Coolify deployment smoke-checked
- backup scripts scheduled and first uploads verified
- real client checks passed for avatar, group-image, and theme loading
- rollback artifacts recorded

## Verification run

- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`: passed
- `./node_modules/.bin/vitest run src/__tests__/config-object-storage.test.ts src/__tests__/object-media-proxy.test.ts`: passed

Additional release verification still requires a full image build and a deployment smoke test in the target environment.
