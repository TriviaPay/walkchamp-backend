# Staging And Release Gate

Production is blocked unless staging exists first.

## Required Staging Shape

- Smaller OCI VM with the same service split as production.
- Separate staging Neon branch or database.
- Separate Redis instance or logical DB.
- Separate staging OCI Object Storage bucket or prefix.
- Sandbox Stripe and Razorpay keys.
- Staging Descope project or config.
- Staging Sentry environment.
- Staging API domain.

## Release Gate

Every production release must pass this sequence in staging first:

1. Deploy the release artifact to staging.
2. Validate config startup checks.
3. Run the DB migration.
4. Start the worker and API services.
5. Verify `/api/healthz` and `/api/readyz`.
6. Verify Redis-backed auth or payment rate limiting.
7. Verify Descope session validation.
8. Verify sandbox payment flow and webhook replay.
9. Verify upload, read, and delete against staging object storage.
10. Verify worker queue execution.
11. Verify Sentry ingestion.
12. Rehearse rollback.

Do not promote to production if any staging gate fails.
