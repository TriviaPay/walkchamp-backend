#!/bin/sh
set -eu

heartbeat_file="${WORKER_HEARTBEAT_FILE:-/tmp/worker-heartbeat}"
max_age_seconds="${WORKER_HEALTHCHECK_MAX_AGE_SECONDS:-90}"

[ -f "${heartbeat_file}" ]

current_epoch="$(date +%s)"
heartbeat_epoch="$(stat -c %Y "${heartbeat_file}" 2>/dev/null || stat -f %m "${heartbeat_file}")"
heartbeat_age="$((current_epoch - heartbeat_epoch))"

[ "${heartbeat_age}" -le "${max_age_seconds}" ]
