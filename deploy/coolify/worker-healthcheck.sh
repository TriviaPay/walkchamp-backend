#!/bin/sh
set -eu

heartbeat_file="${WORKER_HEARTBEAT_FILE:-/tmp/worker-heartbeat}"
max_age_seconds="${WORKER_HEALTHCHECK_MAX_AGE_SECONDS:-90}"

[ -f "${heartbeat_file}" ]

current_epoch="$(date +%s)"
heartbeat_epoch="$(stat -c %Y "${heartbeat_file}" 2>/dev/null || stat -f %m "${heartbeat_file}")"
heartbeat_age="$((current_epoch - heartbeat_epoch))"

[ "${heartbeat_age}" -le "${max_age_seconds}" ]

# Prove the BullMQ queue Redis is actually reachable (audit 2026-08-17 H17). The heartbeat above
# only proves the node process is alive; a wrong/rotated REDIS_PASSWORD leaves the worker running
# but silently unable to pull settlement/refund/webhook jobs — a green-but-dead worker. Ping the
# queue instance so Coolify restarts the container on an auth/connectivity failure. Some redis-cli
# builds do not apply password-only URLs to Redis' default ACL user, even though ioredis accepts the
# same URL. Normalize that form to an explicit default user before probing.
if [ -n "${REDIS_QUEUE_URL:-}" ]; then
  queue_url="${REDIS_QUEUE_URL}"
  case "${queue_url}" in
    redis://:*) queue_url="redis://default:${queue_url#redis://:}" ;;
    rediss://:*) queue_url="rediss://default:${queue_url#rediss://:}" ;;
  esac
  redis-cli --no-auth-warning -u "${queue_url}" ping | grep -q PONG
fi
