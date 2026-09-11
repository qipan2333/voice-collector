#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${ROOT_DIR}/backups/${STAMP}"
mkdir -p "${BACKUP_DIR}"

cd "${ROOT_DIR}/ops"
docker compose exec -T db pg_dump -U voice -d voice_collector --format=custom > "${BACKUP_DIR}/database.dump"
tar --sort=name --mtime='UTC 2020-01-01' -C "${ROOT_DIR}/data" -czf "${BACKUP_DIR}/recordings.tar.gz" recordings
sha256sum "${BACKUP_DIR}"/* > "${BACKUP_DIR}/SHA256SUMS"

find "${ROOT_DIR}/backups" -mindepth 1 -maxdepth 1 -type d -mtime +28 -exec rm -rf -- {} +
echo "backup complete: ${BACKUP_DIR}"

