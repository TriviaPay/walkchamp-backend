#!/bin/sh
set -eu

# Builds hot-table indexes with CREATE INDEX CONCURRENTLY (audit 2026-08-17 F-14), outside the
# drizzle migration transaction and off the deploy critical path — api-entrypoint runs this in
# the background after migrations, so a long build delays no healthcheck and blocks no writes.
#
# db/concurrent-indexes.sql is the managed list; every statement must be of the form
#   CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS "<name>" ON ...;
# A CONCURRENTLY build that fails leaves an INVALID index behind, which would turn
# IF NOT EXISTS into a permanent no-op — so invalid managed indexes are dropped first,
# making every boot a clean retry.

sql_file="${CONCURRENT_INDEXES_FILE:-./db/concurrent-indexes.sql}"
db_url="${DATABASE_ADMIN_URL:-${DATABASE_RUNTIME_URL:-}}"

if [ ! -f "${sql_file}" ]; then
  echo "[concurrent-indexes] ${sql_file} not found; nothing to do"
  exit 0
fi
if [ -z "${db_url}" ]; then
  echo "[concurrent-indexes] no DATABASE_ADMIN_URL/DATABASE_RUNTIME_URL; skipping"
  exit 0
fi

names="$(sed -n 's/^CREATE \(UNIQUE \)\{0,1\}INDEX CONCURRENTLY IF NOT EXISTS "\([^"]*\)".*/\2/p' "${sql_file}")"

if [ -z "${names}" ]; then
  echo "[concurrent-indexes] no managed index statements; nothing to do"
  exit 0
fi

for name in ${names}; do
  invalid="$(psql "${db_url}" -qtAc "SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = '${name}' AND NOT i.indisvalid" || true)"
  if [ "${invalid}" = "1" ]; then
    echo "[concurrent-indexes] dropping INVALID index ${name} left by an earlier failed build"
    psql "${db_url}" -qc "DROP INDEX CONCURRENTLY IF EXISTS \"${name}\"" || true
  fi
done

# psql autocommits statement-by-statement — exactly what CONCURRENTLY requires.
psql "${db_url}" -v ON_ERROR_STOP=1 -f "${sql_file}"
echo "[concurrent-indexes] all managed indexes ensured"
