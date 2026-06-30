# OCI Production-Minimal Architecture

This backend is intentionally documented as `production-minimal`, not highly available.

## Shape

- OCI Load Balancer terminates TLS.
- One OCI VM runs the API and worker as separate `systemd` services.
- Backend port is private; only the OCI load balancer reaches the API listener.
- Neon/Postgres remains the production database.
- Redis is reserved for shared rate limiting and BullMQ/job coordination.
- OCI Object Storage remains private and is accessed only through backend-controlled reads.

## Truth In Advertising

- VM loss is a manual recovery event.
- API up with worker down is degraded but temporarily tolerable.
- A release is not marked healthy until both API and worker are healthy.
- This shape is acceptable only with staging, rebuild runbooks, backups, and explicit recovery targets.

## Recovery Targets

| Area | Target |
| --- | --- |
| RTO | 4 hours |
| RPO | 15 minutes or better for DB-backed data |
| Expected downtime if VM is lost | Multi-hour manual rebuild and redeploy |
| Scale-up path | Bigger VM -> second VM -> containerized split -> OKE only if justified |

## Explicit Security Decisions

- TLS terminates at the OCI load balancer only in v1.
- Backend traffic remains on the private network and is not re-encrypted in v1.
- `Express trust proxy` is set to one OCI LB hop.
- SSH should go through bastion/VPN when available; otherwise use a temporary source-IP allowlist.
- VM firewall rules must mirror OCI NSG/security-list intent.

## Database Runtime Policy

- API pool max: `10`
- Worker pool max: `5`
- Migration/admin pool max: `2`
- Expected steady-state total max: `17`
- Connection timeout: `5s`
- Idle timeout: `30s`
- Statement timeout: `15s`
- Transaction timeout: `30s`
- Runtime DB role: `app_runtime`
- Migration/admin DB role: `app_migration`

## Worker Policy

- Recurring jobs are worker-owned, not API-owned.
- BullMQ worker concurrency target: `2`
- Job-specific concurrency default: `1` unless explicitly raised.
- Migrations that touch job-mutated tables must run with workers stopped or quiesced.
