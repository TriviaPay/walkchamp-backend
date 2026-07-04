# Staging And Release Gate

Production stays blocked unless the release is validated outside the live stack first.

## Low-cost staging shape

The base production budget does not assume a second always-on VPS.

Acceptable validation shapes are:

- a short-lived second OVH VPS running the same Coolify stack
- a temporary Coolify project on spare capacity
- local Docker Compose plus separate staging Neon branch and staging R2 bucket for non-network-edge checks

## Required staging parity

- same image as production
- same service split: `api`, `worker`, `redis-cache`, `redis-queue`
- separate Neon branch or database
- separate R2 bucket or isolated staging prefix
- separate Cloudflare hostname if internet-exposed
- sandbox Stripe and Razorpay credentials
- non-production Descope, Pusher, OneSignal, and LiveKit settings where applicable

## Release gate

Every production release must pass this sequence first:

1. Deploy the image to the validation environment.
2. Run the migration command.
3. Verify `/api/healthz` and `/api/readyz`.
4. Verify Redis-backed rate limiting.
5. Verify auth token validation.
6. Verify worker startup and recurring-job ownership.
7. Verify R2 upload, read, delete, and metadata behavior.
8. Verify media compatibility routes:
   - `GET`
   - `HEAD`
   - `404`
   - rejected `Range`
9. Verify one sandbox payment flow and webhook replay if payments are enabled.
10. Rehearse rollback.

Do not promote if any gate fails.
