#!/usr/bin/env bash
set -euo pipefail

: "${OBJECT_STORAGE_ENDPOINT:?OBJECT_STORAGE_ENDPOINT is required}"
: "${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}"
: "${OBJECT_STORAGE_ACCESS_KEY_ID:?OBJECT_STORAGE_ACCESS_KEY_ID is required}"
: "${OBJECT_STORAGE_SECRET_ACCESS_KEY:?OBJECT_STORAGE_SECRET_ACCESS_KEY is required}"
: "${REDIS_BACKUP_KEY:?REDIS_BACKUP_KEY is required}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
archive_path="${tmp_dir}/redis-restore.tar.zst"
restore_dir="${tmp_dir}/restore"
container_name="walkchamp-redis-restore-drill"

cleanup() {
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

mkdir -p "${restore_dir}"

AWS_ACCESS_KEY_ID="${OBJECT_STORAGE_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${OBJECT_STORAGE_SECRET_ACCESS_KEY}" \
AWS_DEFAULT_REGION="${OBJECT_STORAGE_REGION:-auto}" \
aws --endpoint-url "${OBJECT_STORAGE_ENDPOINT}" s3 cp "s3://${OBJECT_STORAGE_BUCKET}/${REDIS_BACKUP_KEY}" "${archive_path}"

tar --use-compress-program=unzstd -xf "${archive_path}" -C "${restore_dir}"

docker run -d --rm \
  --name "${container_name}" \
  -v "${restore_dir}:/data" \
  redis:7.2-alpine \
  redis-server --dir /data --appendonly yes --appendfsync everysec >/dev/null

sleep 5
docker exec "${container_name}" redis-cli ping | grep -q '^PONG$'
docker exec "${container_name}" redis-cli dbsize >/dev/null

echo "Redis restore drill succeeded for ${REDIS_BACKUP_KEY}"
