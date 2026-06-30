#!/bin/sh
set -eu

heartbeat_file="${WORKER_HEARTBEAT_FILE:-/tmp/worker-heartbeat}"
heartbeat_interval="${WORKER_HEARTBEAT_INTERVAL_SECONDS:-30}"

touch "${heartbeat_file}"

node --enable-source-maps ./dist/worker.mjs &
worker_pid="$!"

forward_signal() {
  kill -TERM "${worker_pid}" 2>/dev/null || true
}

trap forward_signal INT TERM

while kill -0 "${worker_pid}" 2>/dev/null; do
  date +%s > "${heartbeat_file}"
  sleep "${heartbeat_interval}"
done

wait "${worker_pid}"
