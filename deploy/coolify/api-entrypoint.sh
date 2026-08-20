#!/bin/sh
set -eu

if [ -z "${REDIS_PASSWORD:-}" ]; then
  echo "[startup] REDIS_PASSWORD is required at runtime" >&2
  exit 1
fi

# The api container owns schema migrations. Running them here — rather than from Coolify's
# pre/post-deployment hooks — is what makes an automated deploy safe:
#
#   * pre_deployment_command execs into the *previous* image's containers, so it would apply
#     the old migration set and silently miss anything new in this release.
#   * post_deployment_command runs after the rolling update and swallows its own failures, so
#     a broken migration would leave the new code live on a stale schema with a green deploy.
#
# Migrating here means the schema is in place before this process accepts a single request, and
# a failed migration exits non-zero -> the container never becomes healthy -> Coolify fails the
# deployment and leaves the previous containers serving.
#
# This assumes a single api replica, which is the current topology. Running more than one would
# need an advisory lock around the migration step so replicas don't race.
/usr/local/bin/run-migrations

# Hot-table index builds (F-14) run CONCURRENTLY in the background: they must not extend the
# healthcheck window, and CONCURRENTLY cannot run inside the migration transaction anyway.
# Double-fork via a subshell so the builder is reparented to tini (PID 1) immediately and reaped,
# rather than becoming an unreaped zombie child of the exec'd node process (audit 2026-08-17 L7).
( /usr/local/bin/ensure-concurrent-indexes & )

exec node --enable-source-maps ./dist/index.mjs
