# Backend Production Checklist Audit

Legend:

- `Full`: implemented in code or clearly configured in-repo
- `Partial`: some implementation exists, but it is incomplete, deployment-dependent, or uneven
- `Missing`: not implemented in the repo
- `N/A`: not applicable to this backend architecture as currently implemented
- `Not evidenced`: could exist in deployment/provider settings, but is not provable from this repo

## Implementation status

The production-minimal OCI implementation work is now anchored in:

- Architecture truth doc: [docs/architecture/oci-production-minimal.md](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/docs/architecture/oci-production-minimal.md)
- Staging gate: [docs/runbooks/staging-and-release-gate.md](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/docs/runbooks/staging-and-release-gate.md)
- Deployment and recovery runbook: [docs/runbooks/deployment-and-recovery.md](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/docs/runbooks/deployment-and-recovery.md)
- Secrets and host baseline: [docs/runbooks/secrets-and-host-baseline.md](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/docs/runbooks/secrets-and-host-baseline.md)
- OCI bootstrap assets: [deploy/oci/cloud-init.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/deploy/oci/cloud-init.yaml), [deploy/systemd/walkchamp-api.service](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/deploy/systemd/walkchamp-api.service), [deploy/systemd/walkchamp-worker.service](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/deploy/systemd/walkchamp-worker.service)

## 1. Environment and configuration

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Separate production config | Partial | `.env.example`, [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:4), [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:48) | Production env vars and production-only checks exist, but there is no typed config module that centralizes all runtime config. |
| Environment variables | Partial | [.env.example](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/.env.example:1), [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:12) | Required variables are documented, but only some are enforced at startup. |
| Secrets | Partial | [.gitignore](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/.gitignore:9), [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:17) | `.env` is ignored and Render secrets are `sync: false`, but repo history/secrets scanning is not evidenced. |
| Config validation | Partial | [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:24), [db/src/index.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/index.ts:7), [src/lib/descope.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/descope.ts:7) | DB URL, project ID, port, `APP_BASE_URL`, and `ALLOWED_ORIGINS` are validated, but provider secrets such as `DESCOPE_MANAGEMENT_KEY`, Stripe, Razorpay, OneSignal, and OCI mostly fail only when endpoints are exercised. |
| Debug mode off | Partial | [src/lib/logger.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/logger.ts:3) | Pretty logs are disabled in production, but there is no explicit global production-safe error middleware beyond default Express behavior. |
| Production base URLs | Partial | [.env.example](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/.env.example:9), [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:49), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:70) | `APP_BASE_URL` and `ALLOWED_ORIGINS` are wired, but external provider callback/webhook registration cannot be verified from repo alone. |
| Feature flags | Partial | [.env.example](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/.env.example:65), [src/lib/featureFlags.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/featureFlags.ts:22), [src/middleware/requireFeatureEnabled.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/middleware/requireFeatureEnabled.ts:5) | Feature flags exist with env overrides and DB lookup; coverage is selective, not platform-wide. |
| Timezone handling | Partial | [src/routes/walk.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/walk.ts:454), [db/src/schema/groups.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/schema/groups.ts:48) | Some date logic is explicitly UTC-safe and some schema uses `withTimezone`, but timezone policy is not centralized across the codebase. |

## 2. Database

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Production database | Partial | [db/src/index.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/index.ts:7), [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:17) | The app expects a dedicated Postgres URL, but there is no repo-level proof that production is isolated from non-production. |
| Migrations | Full | [db/migrations/0000_baseline.sql](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/migrations/0000_baseline.sql:1), [db/migrations/0001_security_v3.sql](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/migrations/0001_security_v3.sql:1), [README.md](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/README.md:7) | Versioned SQL migrations are committed and documented. |
| Migration rollback | Missing | `db/`, `README.md` | No rollback scripts, `down` migrations, or documented rollback procedure were found. |
| Seed data | Partial | [package.json](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/package.json:22), `scripts/src/seedAchievements.ts`, `scripts/src/seedTestTitles.ts` | Seed scripts exist, but there is no explicit separation of safe production seeds vs test/demo seeds. |
| Backups | Not evidenced | deployment/provider level | No backup configuration appears in repo. |
| Restore test | Not evidenced | deployment/provider level | No restore verification process appears in repo. |
| Connection pooling | Full | [db/src/index.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/index.ts:15) | Uses `pg.Pool`. |
| Indexes | Full | [db/src/schema](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/schema/notifications.ts:45), [db/src/schema](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/schema/chat.ts:83), [db/src/schema](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/schema/steps.ts:20) | Many domain tables define indexes and unique indexes. |
| Query performance | Partial | [package.json](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/package.json:27), `scripts/src/apply-db-indexes.ts` | Index work exists, but there is no query tracing/slow-query instrumentation in repo. |
| Data retention | Missing | repo-wide | No retention policy or cleanup policy for logs, user data, or files was found. |
| PII handling | Partial | [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:317), [src/lib/ociStorage.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/ociStorage.ts:83) | Passwords are delegated to Descope and avatars are proxied through backend-owned storage, but field-level encryption or a general PII policy is not present. |

## 3. Authentication and authorization

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Password policy | Partial | [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:278), [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:416) | Backend only enforces minimum length 8; stronger complexity policy is not present here. |
| Password storage | Full | [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:317) | Passwords are set in Descope; backend comments explicitly state they are never stored in Neon/Postgres. |
| Session security | N/A | repo-wide | This backend is bearer-token based and does not use auth cookies. |
| JWT security | Partial | [src/middleware/requireAuth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/middleware/requireAuth.ts:10), [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:613), [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:716) | Session JWTs are validated by Descope on every request and refresh tokens are returned in auth flows, but token lifetime/rotation policy is external to this repo. |
| Role-based access | Partial | [docs/security/authorization-matrix.md](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/docs/security/authorization-matrix.md:1), [src/middleware/requireAdminRole.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/middleware/requireAdminRole.ts:14), [src/routes/groups.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/groups.ts:653) | Object-level checks exist in many routes, but enforcement is route-by-route rather than via a unified authorization layer. |
| Admin protection | Full | [src/routes/admin.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/admin.ts:20), [src/middleware/requireAdminRole.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/middleware/requireAdminRole.ts:14), [src/middleware/requireAdminKey.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/middleware/requireAdminKey.ts:4) | Admin routes require JWT auth plus allowlist-based admin role; service-only routes use a service key. |
| OAuth callbacks | Partial | [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:638), [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:689) | OAuth start/exchange flows exist, but provider-side production callback registration cannot be verified from repo. |
| Account recovery | Partial | [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:408) | Password reset completion exists, but the full email initiation and end-to-end verification flow is mostly externalized to Descope. |
| Logout | Not evidenced | repo-wide | No backend logout/invalidation endpoint was found in this repo. |
| Rate limiting | Partial | [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:141), [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:13), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:42) | Auth, payment, and report limits exist, but they are in-memory and not multi-instance safe. |

## 4. API design and validation

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Input validation | Partial | [src/routes/auth.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/auth.ts:278), [src/routes/chat.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/chat.ts:94), [src/routes/races.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/races.ts:1635) | Many body payloads use Zod; coverage across query params/headers/path params is good in some routes but not universal. |
| Schema validation | Full | [package.json](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/package.json:55), [src/routes/health.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/health.ts:2), `db/src/schema/*.ts` | Zod and drizzle-zod are used extensively. |
| Output consistency | Partial | repo-wide | Many routes return predictable JSON, but there is no universal response envelope. |
| Error format | Partial | repo-wide | Errors are usually JSON with `error` and sometimes `code`/`details`, but formats vary by route. |
| Pagination | Partial | [src/routes/chat.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/chat.ts:25), [src/routes/notifications.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/notifications.ts:16), [src/routes/wallet.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/wallet.ts:111) | Several list endpoints paginate, but not every large list endpoint is clearly paginated. |
| Filtering/sorting | Partial | [src/routes/races.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/races.ts:1205), [src/routes/leaderboard.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/leaderboard.ts:126), [src/routes/admin.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/admin.ts:175) | Some routes whitelist filters/sorts explicitly; others cast query strings more loosely. |
| File uploads | Partial | [src/routes/profile.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/profile.ts:15), [src/routes/groups.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/groups.ts:21), [src/lib/ociStorage.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/ociStorage.ts:83) | File type and size are constrained, and storage is backend-controlled, but no malware scanning or content rewriting is present. |
| Idempotency | Full | [src/routes/payments.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/payments.ts:256), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:717), [db/src/schema/payments.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/schema/payments.ts:42), [db/src/schema/deposits.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/schema/deposits.ts:14) | Payment, deposit, webhook, and coin reward flows have explicit idempotency handling. |
| Versioning | Missing | [api-spec/openapi.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/api-spec/openapi.yaml:7) | API is mounted at `/api` with no `/v1` or equivalent versioning. |
| API docs | Partial | [api-spec/openapi.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/api-spec/openapi.yaml:1), [README.md](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/README.md:44) | OpenAPI exists, but it currently documents only `GET /healthz`. |

## 5. Security

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| CORS | Full | [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:99) | Production uses allowlisted origins from `ALLOWED_ORIGINS`. |
| CSRF | N/A | repo-wide | No cookie-based auth is implemented here. |
| SQL injection | Full | [db/src/index.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/db/src/index.ts:16), repo-wide Drizzle usage | The backend predominantly uses Drizzle query builders and parameterized SQL templates. |
| XSS protection | Partial | [src/routes/chat.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/chat.ts:94), [src/routes/profile.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/profile.ts:330) | Length/format validation exists, but user-generated text is not sanitized or escaped server-side before being stored/returned. |
| SSRF protection | N/A | repo-wide | No routes were found that fetch arbitrary user-supplied URLs. External fetches target fixed domains such as Apple and OneSignal. |
| Dependency audit | Missing | `package.json` scripts | No `npm audit`, `pnpm audit`, or equivalent audit workflow is defined in repo. |
| Secrets scanning | Missing | repo-wide | No secret scanning workflow or documented process was found. |
| HTTPS | Partial | [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:61), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:77) | Production `APP_BASE_URL` must be HTTPS, but transport TLS enforcement is deployment/provider level. |
| Security headers | Full | [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:69) | Helmet is enabled with CSP and related headers. |
| Webhook verification | Full | [src/routes/payments.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/payments.ts:328), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:1028), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:1145) | Stripe and Razorpay webhooks verify signatures and track processed events. |
| Least privilege | Not evidenced | deployment/provider level | DB roles, cloud IAM scopes, and provider key permissions are not visible in repo. |
| Admin logging | Full | [src/lib/auditLog.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/auditLog.ts:6), [src/routes/admin.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/admin.ts:114) | Sensitive admin actions log both operational events and audit-log records. |

## 6. Logging and monitoring

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Structured logs | Full | [src/lib/logger.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/logger.ts:5), [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:201) | Uses Pino and `pino-http`. |
| No secret logging | Partial | [src/lib/logger.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/logger.ts:7) | Authorization/cookie headers are redacted, but there is no broader redact list for all secret-bearing fields. |
| Error tracking | Missing | [package.json](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/package.json:32) | `@sentry/node` is installed but not initialized anywhere under `src/`. |
| Health endpoint | Partial | [src/routes/health.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/health.ts:6) | Health endpoint exists, but it does not check DB, Redis, or provider readiness. |
| Uptime monitoring | Not evidenced | deployment/provider level | No uptime monitor configuration appears in repo. |
| Alerting | Missing | repo-wide | No alerting hooks or incident thresholds were found. |
| Request tracing | Partial | [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:206) | `req.id` is logged, but there is no distributed tracing or explicit propagation strategy. |
| Replit monitoring | N/A | deployment model | Repo is configured for Render/Vercel rather than Replit. |

## 7. Performance and scalability

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Cold starts | Not evidenced | deployment/runtime level | No cold-start measurement or profiling was found. |
| Heavy tasks | Partial | [src/worker.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/worker.ts:13), [src/lib/scheduler.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/scheduler.ts:160), [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:247) | A worker process and schedulers exist, but background jobs still run in the web app by default. |
| Caching | Partial | [src/lib/featureFlags.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/featureFlags.ts:6) | Small in-memory caches exist, but there is no shared cache for hot reads. |
| DB query limits | Partial | [src/routes/races.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/races.ts:1355), [src/routes/wallet.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/wallet.ts:131), [src/routes/notifications.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/notifications.ts:31) | Many list endpoints enforce `limit`, but not every expensive query is clearly bounded. |
| Payload size | Full | [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:222), [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:242) | JSON/body size limits and compression are enabled. |
| Rate limits | Partial | [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:129) | Present, but per-process only. |
| Memory usage | Not evidenced | runtime level | No profiling, caps, or memory leak monitoring found. |
| CPU usage | Partial | [src/worker.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/worker.ts:7), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:542) | Some work is pushed to worker/background tasks, but HTML rendering and some synchronous logic still occur in request paths. |
| Concurrency | Partial | [src/lib/raceIntegrity.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/raceIntegrity.ts:124), [scripts/src/loadSmoke.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/scripts/src/loadSmoke.ts:1), `src/__tests__/integration-http.test.ts` | Concurrency-sensitive flows use DB locks and there is a smoke/load script, but coverage is not broad enough to call this fully production-proven. |
| Deployment type | N/A | [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:4), `vercel.json` | Checklist wording is Replit-specific; this repo targets Render and Vercel. |

## 8. Background jobs and scheduled tasks

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Job runner | Partial | [src/lib/scheduler.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/scheduler.ts:160), [src/worker.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/worker.ts:13), [src/lib/queue.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/queue.ts:1) | There is working scheduler code and worker bootstrapping, but BullMQ is only scaffolding and not the main execution path yet. |
| Retries | Partial | [src/lib/queue.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/queue.ts:10) | Retry policy exists as helper, but queue-backed retries are not wired into the running job system. |
| Idempotency | Partial | [src/lib/queue.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/queue.ts:18), [src/routes/payments.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/payments.ts:350) | Some background/payment flows are explicitly idempotent, but not every scheduled job documents idempotency guarantees. |
| Dead letter handling | Missing | repo-wide | No DLQ or failed-job persistence path was found. |
| Cron schedule | Partial | [src/lib/scheduler.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/scheduler.ts:160), [src/routes/sponsoredEvents.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/sponsoredEvents.ts:404) | Schedules exist as `setInterval` timers, but production timezone intent and ownership are not clearly centralized. |
| Worker secrets | Partial | [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:41) | Worker env vars are defined, but not all web-service vars are mirrored and separation is minimal. |

## 9. Payments, emails, and third-party services

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Production keys | Partial | [.env.example](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/.env.example:40), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:12) | Runtime env wiring exists, but repo cannot prove live-mode keys are used; deposit file still contains production TODO comments. |
| Webhook URLs | Partial | [src/routes/payments.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/payments.ts:328), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:1028) | Endpoints exist, but provider-side URL registration is not verifiable from repo. |
| Webhook signing | Full | [src/routes/payments.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/payments.ts:344), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:1045), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:1159) | Stripe and Razorpay signatures are verified. |
| Retry behavior | Full | [src/routes/payments.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/payments.ts:350), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:1058), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:1179) | Duplicate webhook delivery is handled through persisted processed-event tables and idempotent crediting. |
| Email domain | Not evidenced | DNS/provider level | SPF, DKIM, and DMARC are not in repo. |
| Test purchases | Not evidenced | repo-wide | No payment end-to-end test suite was found. |
| Failure handling | Partial | [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:344), [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:695), [src/routes/push.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/push.ts:127) | Provider failures are handled in many places, but there is no centralized resilience policy or alerting for provider outages. |

## 10. Deployment and release process

| Check | Status | Where | Notes |
| --- | --- | --- | --- |
| Git repo | Full | `.git/`, [README.md](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/README.md:1) | This is a version-controlled repo. |
| Main branch protection | Not evidenced | Git hosting settings | Branch protection cannot be determined from local repo contents. |
| Build command | Full | [package.json](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/package.json:11), [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:9) | Build command is defined and works locally via `node ./build.mjs`. |
| Start command | Full | [package.json](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/package.json:13), [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:10) | Start command is defined for both API and worker. |
| Deploy script | Partial | [render.yaml](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/render.yaml:4), `vercel.json` | Deployment manifests exist, but no single repeatable release pipeline is documented end-to-end. |
| Rollback | Missing | repo-wide | No rollback procedure or automation is documented. |
| Smoke test | Partial | [package.json](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/package.json:18), `scripts/src/loadSmoke.ts` | A load/smoke script exists, but no documented post-deploy checklist covers login, payments, uploads, and core flows together. |
| Logs after deploy | Partial | [src/lib/logger.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/lib/logger.ts:5), [src/app.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/app.ts:203) | Logging is present, but there is no documented release verification step that requires checking logs after deploy. |
| Custom domain | Not evidenced | provider level | Domain attachment is deployment configuration, not represented in this repo. |

## Verification run

- `./node_modules/.bin/vitest run`: passed (`154` tests)
- `node ./build.mjs`: passed
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`: failed

Current typecheck failures are in:

- [src/routes/deposit.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/deposit.ts:240)
- [src/routes/races.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/races.ts:1505)
- [src/routes/races.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/races.ts:1558)
- [src/routes/races.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/races.ts:2651)
- [src/routes/races.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/races.ts:2748)
- [src/routes/races.ts](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/src/routes/races.ts:2987)

That means the repo is not currently release-clean even though tests and bundling pass.
