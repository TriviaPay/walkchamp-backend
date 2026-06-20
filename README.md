# Walk Champ — Backend

Standalone Express API server.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
```

This bootstraps a fresh empty PostgreSQL database from the committed Drizzle migrations in `db/migrations/`.

## Scripts

```bash
pnpm dev          # Build and start API
pnpm build        # Production bundle
pnpm start        # Run production bundle
pnpm typecheck    # TypeScript check
pnpm test         # Unit tests
pnpm db:generate  # Generate a reviewed SQL migration into db/migrations
pnpm db:migrate   # Apply committed SQL migrations to PostgreSQL
```

## Database Workflow

Use this project as PostgreSQL-only. The schema uses PostgreSQL types and features, so changing database engines is a porting task, not a config swap.

For any empty PostgreSQL-compatible database:

```bash
pnpm install
cp .env.example .env
# set DATABASE_URL or NEON_DATABASE_URL
pnpm db:migrate
```

For an existing PostgreSQL database that already has the old Walk Champ schema but is not yet tracked by Drizzle:

```bash
pnpm db:adopt-existing
pnpm db:migrate
```

`db:adopt-existing` marks the current database as being at migration `0000_baseline` so that only newer migrations are applied.

For schema changes:

```bash
pnpm db:generate
# review the generated SQL in db/migrations/
pnpm db:migrate
```

## Layout

| Path | Purpose |
|------|---------|
| `src/` | API routes, services, middleware |
| `db/` | Drizzle schema + database config |
| `api-zod/` | Zod validation schemas |
| `scripts/` | DB seeds and maintenance |
| `.github/workflows/` | CI template (copy to repo root `.github` for GitHub Actions) |

## Health check

`GET /api/healthz`

## Deploy on Vercel

- Production branch: `main`
- Build command: `pnpm run vercel-build`
- Install command: `pnpm install --frozen-lockfile`
- Set all variables from `.env.example` in the Vercel project settings
