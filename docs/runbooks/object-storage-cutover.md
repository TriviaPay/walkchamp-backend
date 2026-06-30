# Object Storage Cutover

## Goal

Replace legacy OCI object URLs with R2-backed storage and keep media loading safe during the cutover.

## Pre-cutover artifacts

Record all of these before deploying the OVH-only release:

- pre-cutover git tag
- current production image digest
- current production env snapshot
- Neon restore point
- object-copy verification output

## Copy scope

Copy objects into R2 under the same keys for:

- `avatars/`
- `group-images/`
- `race-themes/`

## Verification gate

Do not apply the DB rewrite until all are true:

- R2 bucket exists
- R2 custom domain is active
- prefix counts match
- missing-key report is empty or explicitly accepted
- sample objects match expected size and content type
- sample objects are publicly readable from the R2 custom domain

Do not rely on multipart ETag equality alone when verifying object integrity.

## DB rewrite

Dry-run first:

```bash
pnpm storage:rewrite-urls
```

Apply only after verification:

```bash
pnpm storage:rewrite-urls --apply
```

The rewrite targets:

- `profiles.avatar_url`
- `walking_groups.group_image_url`

## Client checks

Before promoting the cutover:

- verify avatar loading in real clients
- verify group-image loading in real clients
- verify theme-image loading in real clients
- verify upload, replace, and delete flows

## Post-cutover

- watch media proxy logs for elevated `404`, `413`, and `502` rates
- confirm backup scripts are writing to R2
- schedule the post-cutover Cloudflare hardening work
