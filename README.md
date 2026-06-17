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
5. **Copy all secrets from Replit** into **Settings → Environment Variables** using `vercel.env.example` as the checklist (same names as Replit except `REPLIT_DOMAINS` → `APP_BASE_URL`)
6. **Redeploy** after saving env vars

### Required Vercel env vars (minimum to boot)

| Variable | Source |
|----------|--------|
| `NEON_DATABASE_URL` | Neon console → connection string (pooled) |
| `DESCOPE_PROJECT_ID` | Replit secrets / Descope dashboard |
| `SESSION_SECRET` | Replit secrets (any long random string) |
| `NODE_ENV` | `production` |
| `APP_BASE_URL` | `https://walkchamp-backend-sooty.vercel.app` |
| `ALLOWED_ORIGINS` | Your frontend URL(s), comma-separated |

Traffic is routed to `api/index.ts`, which loads the pre-bundled `api/handler.js` (built from `src/app.ts`).

See also: `.env.example` (full list + Replit mapping), `vercel.env.example` (paste template for Vercel UI).
