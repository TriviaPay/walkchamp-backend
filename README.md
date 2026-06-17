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

## Deploy on Vercel

1. Connect repo `TriviaPay/walkchamp-backend`, branch `main`
2. **Settings → General → Output Directory:** `public` (or leave blank — `vercel.json` sets this)
3. **Framework Preset:** Other
4. Build command: `pnpm run vercel-build` (from `vercel.json`)
5. Set all variables from `.env.example` in **Settings → Environment Variables**

Traffic is routed to `api/index.js` (esbuild bundle of `src/app.ts`), which exports the Express app for Vercel serverless.
