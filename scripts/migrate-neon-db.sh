#!/usr/bin/env bash
#
# Neon → Neon migration (zero data loss). SOURCE is only ever READ (pg_dump is read-only).
#
# MODE=full       (default) schema + data → requires an EMPTY dest. Use for a fresh dest.
# MODE=data-only  data only → dest must ALREADY have the schema (e.g. drizzle migrations ran).
#                 Use this for the "schema now, data later" flow once the old DB is reachable.
#
# Usage:
#   SOURCE_DATABASE_URL=... DEST_DATABASE_URL=... ./scripts/migrate-neon-db.sh
#   MODE=data-only ./scripts/migrate-neon-db.sh          # data-only into a schema'd dest
# or, defaulting from .env:
#   SOURCE = NEON_DATABASE_URL1   (the old, quota-blocked project — must be reachable to run)
#   DEST   = NEON_DATABASE_URL     (the new project)
#
# Prereqs:
#   - A pg_dump whose version is >= the SOURCE server's Postgres version (Neon runs PG 15–18).
#     Local pg 14 CANNOT dump a newer server. Install a matching client, e.g.:
#       brew install postgresql@17    # then re-run; the script auto-detects it
#   - The SOURCE must be reachable. If it is quota-blocked ("exceeded the compute time quota"),
#     upgrade that Neon project's plan (or wait for the monthly reset) FIRST.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP_FILE="${DUMP_FILE:-/tmp/walkchamp-neon-$(date +%s).dump}"
MODE="${MODE:-full}"   # full | data-only
[ "$MODE" = "full" ] || [ "$MODE" = "data-only" ] || { echo "ERROR: MODE must be 'full' or 'data-only'"; exit 1; }
echo "MODE: $MODE"

# ── Resolve URLs (env overrides; else read from .env) ─────────────────────────
load_env() { grep -E "^$1=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- ; }
SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-$(load_env NEON_DATABASE_URL1)}"
DEST_DATABASE_URL="${DEST_DATABASE_URL:-$(load_env NEON_DATABASE_URL)}"

redact() { echo "$1" | sed -E 's#(://)[^@]*@#\1<redacted>@#'; }
[ -n "$SOURCE_DATABASE_URL" ] || { echo "ERROR: SOURCE_DATABASE_URL (old DB) is not set"; exit 1; }
[ -n "$DEST_DATABASE_URL" ]   || { echo "ERROR: DEST_DATABASE_URL (new DB) is not set"; exit 1; }
echo "SOURCE (read-only): $(redact "$SOURCE_DATABASE_URL")"
echo "DEST   (restore into): $(redact "$DEST_DATABASE_URL")"

# ── Pick a suitable pg_dump / pg_restore (>= source server version) ───────────
find_pgbin() {
  local name="$1"
  for p in \
    /opt/homebrew/opt/postgresql@18/bin \
    /opt/homebrew/opt/postgresql@17/bin \
    /opt/homebrew/opt/postgresql@16/bin \
    /usr/local/opt/postgresql@18/bin \
    /usr/local/opt/postgresql@17/bin ; do
    [ -x "$p/$name" ] && { echo "$p/$name"; return; }
  done
  command -v "$name"
}
PG_DUMP="$(find_pgbin pg_dump)"
PG_RESTORE="$(find_pgbin pg_restore)"
echo "Using pg_dump:    $PG_DUMP ($("$PG_DUMP" --version | awk '{print $3}'))"
echo "Using pg_restore: $PG_RESTORE ($("$PG_RESTORE" --version | awk '{print $3}'))"

# ── Preflight ─────────────────────────────────────────────────────────────────
echo "== Preflight: SOURCE reachable? =="
if ! SRC_VER="$(psql "$SOURCE_DATABASE_URL" -tA -c 'show server_version_num;' 2>&1)"; then
  echo "ERROR: cannot reach SOURCE. If it is quota-blocked, upgrade the plan or wait for reset."
  echo "  $SRC_VER"
  exit 2
fi
DUMP_MAJOR="$("$PG_DUMP" --version | grep -oE '[0-9]+' | head -1)"
SRC_MAJOR="$(( SRC_VER / 10000 ))"
echo "SOURCE server major: $SRC_MAJOR ; pg_dump major: $DUMP_MAJOR"
if [ "$DUMP_MAJOR" -lt "$SRC_MAJOR" ]; then
  echo "ERROR: pg_dump ($DUMP_MAJOR) is older than the source server ($SRC_MAJOR)."
  echo "       Install a matching client, e.g.: brew install postgresql@$SRC_MAJOR"
  exit 3
fi

echo "== Preflight: DEST reachable? =="
DEST_TABLES="$(psql "$DEST_DATABASE_URL" -tA -c "select count(*) from information_schema.tables where table_schema='public';")"
echo "DEST public tables: $DEST_TABLES"
if [ "$MODE" = "full" ]; then
  if [ "$DEST_TABLES" != "0" ] && [ "${ALLOW_NONEMPTY_DEST:-0}" != "1" ]; then
    echo "ERROR: MODE=full needs an EMPTY dest, but it has $DEST_TABLES tables."
    echo "       If the schema is already applied (drizzle), use MODE=data-only instead."
    exit 4
  fi
else
  if [ "$DEST_TABLES" = "0" ]; then
    echo "ERROR: MODE=data-only needs the schema to already exist in DEST (run drizzle migrations first)."
    exit 4
  fi
fi

# ── Dump (read-only on source) ────────────────────────────────────────────────
DUMP_ARGS=(--format=custom --no-owner --no-privileges --no-acl --verbose)
[ "$MODE" = "data-only" ] && DUMP_ARGS+=(--data-only --disable-triggers)
echo "== Dumping SOURCE ($MODE) → $DUMP_FILE =="
"$PG_DUMP" "$SOURCE_DATABASE_URL" "${DUMP_ARGS[@]}" --file="$DUMP_FILE"
echo "Dump complete: $(du -h "$DUMP_FILE" | awk '{print $1}')"

# ── Restore into DEST ─────────────────────────────────────────────────────────
RESTORE_ARGS=(--no-owner --no-privileges --no-acl --exit-on-error)
if [ "$MODE" = "data-only" ]; then
  # Load data into the existing schema; disable FK triggers during load and wrap in one txn so
  # a failure rolls back cleanly. neondb_owner owns the tables, so trigger toggling is allowed.
  RESTORE_ARGS+=(--data-only --disable-triggers --single-transaction)
fi
echo "== Restoring into DEST ($MODE) =="
"$PG_RESTORE" "${RESTORE_ARGS[@]}" --dbname="$DEST_DATABASE_URL" "$DUMP_FILE"

# ── Verify: compare per-table row counts source vs dest ───────────────────────
echo "== Verifying row counts (source vs dest) =="
COUNT_SQL="select relname, n_live_tup from pg_stat_user_tables order by relname;"
echo "-- SOURCE --"; psql "$SOURCE_DATABASE_URL" -tA -F$'\t' -c "$COUNT_SQL" | tee /tmp/wc-src-counts.txt
echo "-- DEST --";   psql "$DEST_DATABASE_URL"   -tA -F$'\t' -c "select relname, count(*) from information_schema.tables t join pg_stat_user_tables s on true where false group by 1;" >/dev/null 2>&1 || true
psql "$DEST_DATABASE_URL" -tA -F$'\t' -c "$COUNT_SQL" | tee /tmp/wc-dest-counts.txt
echo
echo "Diff (empty = identical live-tuple estimates):"
diff <(sort /tmp/wc-src-counts.txt) <(sort /tmp/wc-dest-counts.txt) && echo "✅ counts match" || echo "⚠️  review differences above (n_live_tup is an estimate; run ANALYZE for exact)"

echo
echo "DONE. Point the app at the new DB by making NEON_DATABASE_URL the primary (it already is)."
echo "Keep the dump file until you've verified the app: $DUMP_FILE"
