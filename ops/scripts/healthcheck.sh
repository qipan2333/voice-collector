#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FREE_KB="$(df -Pk "${ROOT_DIR}" | awk 'NR==2 {print $4}')"
if [[ "${FREE_KB}" -lt 10485760 ]]; then
  echo "ERROR: less than 10GB free on ${ROOT_DIR}" >&2
  exit 1
fi

cd "${ROOT_DIR}/ops"
docker compose exec -T api curl --fail --silent http://127.0.0.1:8000/health/ready >/dev/null
echo "voice-collector health: ok"
