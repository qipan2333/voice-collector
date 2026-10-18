#!/usr/bin/env bash
# Run locally: bash ops/scripts/deploy-ecs.sh [--check] [user@host]
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/root/voice-collector}"
TARGET="root@121.41.177.154"
MODE=deploy
while (($#)); do
  case "$1" in
    --check) MODE=check ;;
    -h|--help) echo "Usage: $0 [--check] [user@host]"; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) TARGET="$1" ;;
  esac
  shift
done
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
remote_command() { printf 'bash -s -- %q %q %q %q' "$MODE" "$REMOTE_DIR" "${1:-}" "${2:-}"; }
if [[ "$MODE" == check ]]; then
  "${SSH[@]}" "$TARGET" "$(remote_command)" < "$ROOT_DIR/ops/scripts/deploy-podman.sh"
  exit
fi
cd "$ROOT_DIR"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "请先提交本地修改；部署只发布干净工作区的 HEAD。" >&2
  exit 1
fi
COMMIT="$(git rev-parse HEAD)"
"${SSH[@]}" "$TARGET" "bash -s -- check $(printf %q "$REMOTE_DIR")" < ops/scripts/deploy-podman.sh
LOCAL_TMP="$(mktemp -d)"
REMOTE_TMP=''
cleanup() {
  rm -rf -- "$LOCAL_TMP"
  if [[ -n "$REMOTE_TMP" ]]; then
    "${SSH[@]}" "$TARGET" "rm -f -- $(printf %q "$REMOTE_TMP")" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
git bundle create "$LOCAL_TMP/source.bundle" HEAD
REMOTE_TMP="$("${SSH[@]}" "$TARGET" 'umask 077; mktemp /tmp/voice-collector-deploy.XXXXXXXX.bundle')"
[[ "$REMOTE_TMP" =~ ^/tmp/voice-collector-deploy\.[a-zA-Z0-9]+\.bundle$ ]] || { echo 'Unexpected remote temporary path' >&2; exit 1; }
scp -q -o BatchMode=yes "$LOCAL_TMP/source.bundle" "$TARGET:$REMOTE_TMP"
"${SSH[@]}" "$TARGET" "$(remote_command "$REMOTE_TMP" "$COMMIT")" < ops/scripts/deploy-podman.sh
