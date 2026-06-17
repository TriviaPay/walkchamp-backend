# Walk Champ — Backend

Standalone Express API server.

## Setup

```bash
cd backend
pnpm install
cp .env.example .env
pnpm db:push
```

## Scripts

```bash
pnpm dev          # Build and start API
pnpm build        # Production bundle
pnpm start        # Run production bundle
pnpm typecheck    # TypeScript check
pnpm test         # Unit tests
pnpm db:push      # Push Drizzle schema to PostgreSQL
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
