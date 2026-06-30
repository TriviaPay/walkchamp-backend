#!/usr/bin/env bash
set -euo pipefail

: "${OBJECT_STORAGE_ENDPOINT:?OBJECT_STORAGE_ENDPOINT is required}"
: "${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}"
: "${OBJECT_STORAGE_ACCESS_KEY_ID:?OBJECT_STORAGE_ACCESS_KEY_ID is required}"
: "${OBJECT_STORAGE_SECRET_ACCESS_KEY:?OBJECT_STORAGE_SECRET_ACCESS_KEY is required}"
: "${REDIS_DATA_DIR:?REDIS_DATA_DIR is required}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 1
fi

if ! command -v zstd >/dev/null 2>&1; then
  echo "zstd is required" >&2
  exit 1
fi

if [[ ! -d "${REDIS_DATA_DIR}" ]]; then
  echo "REDIS_DATA_DIR does not exist: ${REDIS_DATA_DIR}" >&2
  exit 1
fi

backup_prefix="${BACKUP_OBJECT_PREFIX:-backups/production}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_name="redis-${timestamp}.tar.zst"
tmp_dir="$(mktemp -d)"
archive_path="${tmp_dir}/${archive_name}"
target_key="${backup_prefix%/}/redis/${archive_name}"

cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

tar -C "${REDIS_DATA_DIR}" -cf - . | zstd -T0 -19 -o "${archive_path}"

if [[ ! -s "${archive_path}" ]]; then
  echo "Redis archive is empty" >&2
  exit 1
fi

AWS_ACCESS_KEY_ID="${OBJECT_STORAGE_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${OBJECT_STORAGE_SECRET_ACCESS_KEY}" \
AWS_DEFAULT_REGION="${OBJECT_STORAGE_REGION:-auto}" \
aws --endpoint-url "${OBJECT_STORAGE_ENDPOINT}" s3 cp "${archive_path}" "s3://${OBJECT_STORAGE_BUCKET}/${target_key}"

AWS_ACCESS_KEY_ID="${OBJECT_STORAGE_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${OBJECT_STORAGE_SECRET_ACCESS_KEY}" \
AWS_DEFAULT_REGION="${OBJECT_STORAGE_REGION:-auto}" \
aws --endpoint-url "${OBJECT_STORAGE_ENDPOINT}" s3api head-object --bucket "${OBJECT_STORAGE_BUCKET}" --key "${target_key}" >/dev/null

echo "Uploaded ${target_key}"
