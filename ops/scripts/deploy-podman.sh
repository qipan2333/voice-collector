#!/usr/bin/env bash
# Invoked over SSH by deploy-ecs.sh. Existing project only; never recreates the DB.
set -Eeuo pipefail
umask 077
MODE="${1:?mode required}"
ROOT_DIR="${2:?project directory required}"
BUNDLE="${3:-}"
COMMIT="${4:-}"
[[ "$MODE" == check || "$MODE" == deploy ]] || exit 1
[[ "$ROOT_DIR" == /* && "$ROOT_DIR" != / ]] || exit 1
cd "$ROOT_DIR"
for tool in podman podman-compose git python3 curl tar gzip sha256sum flock; do
  command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }
done
test -f ops/.env
test -f ops/docker-compose.yml
test -d data
test -d postgres-data
[[ -z "$(git status --porcelain)" ]] || { echo '服务器工作区有未提交修改，请先处理。' >&2; exit 1; }
python3 - "$ROOT_DIR" <<'PY'
import json, pathlib, subprocess, sys, yaml
root = pathlib.Path(sys.argv[1]).resolve()
for name, destination, source in [
    ('ops_db_1', '/var/lib/postgresql/data', root / 'postgres-data'),
    ('ops_api_1', '/srv/voice-collector', root / 'data'),
    ('ops_worker_1', '/srv/voice-collector', root / 'data'),
]:
    info = json.loads(subprocess.check_output(['podman', 'inspect', name]))[0]
    assert info['Config']['Labels'].get('com.docker.compose.project') == 'ops', f'{name}: unexpected project'
    assert any(m['Destination'] == destination and pathlib.Path(m['Source']).resolve() == source for m in info['Mounts']), f'{name}: unexpected data mount'
info = json.loads(subprocess.check_output(['podman', 'inspect', 'ops_web_1']))[0]
assert info['Config']['Labels'].get('com.docker.compose.project') == 'ops'
PY
podman exec ops_db_1 pg_isready -U voice -d voice_collector >/dev/null
FREE_KB="$(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}')"
[[ "$FREE_KB" -ge 10485760 ]] || { echo '磁盘剩余不足 10GB，停止部署。' >&2; exit 1; }
echo "预检查通过：$ROOT_DIR，项目 ops，配置 ops/.env，数据挂载匹配。"
[[ "$MODE" == deploy ]] || exit 0
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ && -f "$BUNDLE" ]] || { echo 'Invalid source bundle or commit' >&2; exit 1; }
exec 9>"${DEPLOY_LOCK_FILE:-/run/lock/voice-collector-deploy.lock}"
flock -n 9 || { echo '另一个部署正在运行。' >&2; exit 1; }
BACKUP_DIR="$(mktemp -d "${ROOT_DIR%/*}/voice-collector-backup-$(date +%Y%m%d-%H%M%S).XXXXXX")"
LOG="$BACKUP_DIR/deploy.log"
STOPPED=0
MIGRATION_STARTED=0
on_error() {
  local result=$?
  trap - ERR
  echo "部署失败。备份及详细日志：$BACKUP_DIR" >&2
  if [[ "$STOPPED" == 1 && "$MIGRATION_STARTED" == 0 ]]; then
    podman start ops_api_1 ops_worker_1 ops_web_1 >>"$LOG" 2>&1 || true
    echo '迁移尚未开始，已尝试恢复原容器。' >&2
  elif [[ "$MIGRATION_STARTED" == 1 ]]; then
    echo '容器替换已开始，迁移可能已执行；未自动回滚数据库，请检查 deploy.log 和数据库状态。' >&2
  fi
  exit "$result"
}
trap on_error ERR
pc() {
  # podman-compose 1.0.6 prints container environment variables: keep logs private.
  podman-compose --env-file "$ROOT_DIR/ops/.env" -p ops \
    -f "$BACKUP_DIR/compose.yml" "$@" >>"$LOG" 2>&1
}
git rev-parse HEAD > "$BACKUP_DIR/previous-commit.txt"
git archive HEAD | gzip > "$BACKUP_DIR/previous-source.tar.gz"
cp ops/.env "$BACKUP_DIR/ops.env"
podman inspect ops_api_1 ops_worker_1 ops_web_1 --format '{{.Name}} {{.Image}}' > "$BACKUP_DIR/previous-images.txt"
git fetch "$BUNDLE" HEAD >>"$LOG" 2>&1
[[ "$(git rev-parse FETCH_HEAD)" == "$COMMIT" ]]
git merge --ff-only "$COMMIT" >>"$LOG" 2>&1
[[ "$(git rev-parse HEAD)" == "$COMMIT" ]] || { echo '服务器 HEAD 与待部署提交不一致，停止部署。' >&2; false; }
cd "$ROOT_DIR/ops"
echo "构建提交 $COMMIT 的镜像；现有服务继续运行。"
echo "构建日志：$LOG（可另开终端 tail -f 查看进度）"
python3 "$ROOT_DIR/ops/scripts/build-podman.py" "$ROOT_DIR" >>"$LOG" 2>&1
# podman-compose 1.0.6 ignores --no-deps in up. Remove dependencies explicitly,
# and resolve relative paths because this manifest lives in the backup directory.
python3 - "$ROOT_DIR" "$BACKUP_DIR/compose.yml" <<'PYCODE'
import pathlib, sys, yaml
root = pathlib.Path(sys.argv[1])
base = root / 'ops'
config = yaml.safe_load((base / 'docker-compose.yml').read_text())
for service in config['services'].values():
    service.pop('depends_on', None)
    build = service.get('build')
    if isinstance(build, dict):
        build['context'] = str((base / build.get('context', '.')).resolve())
    elif isinstance(build, str):
        service['build'] = str((base / build).resolve())
    for index, volume in enumerate(service.get('volumes', [])):
        if isinstance(volume, str) and volume.startswith('.'):
            source, rest = volume.split(':', 1)
            service['volumes'][index] = str((base / source).resolve()) + ':' + rest
pathlib.Path(sys.argv[2]).write_text(yaml.safe_dump(config, allow_unicode=True))
PYCODE
for service in api worker web; do
  podman image inspect "localhost/ops_${service}:latest" --format '{{.Id}}' > "$BACKUP_DIR/new-${service}-image.txt"
done
# Stop new requests first, then let queued audio finish before taking the backup.
STOPPED=1
podman stop -t 30 ops_web_1 ops_api_1 >>"$LOG" 2>&1
DRAINED=0
for ((i=0; i<120; i++)); do
  JOBS="$(podman exec ops_db_1 psql -U voice -d voice_collector -Atc "SELECT count(*) FROM processing_jobs WHERE state IN ('queued','processing')")"
  if [[ "$JOBS" == 0 ]]; then DRAINED=1; break; fi
  sleep 2
done
[[ "$DRAINED" == 1 ]] || { echo '后台任务未能在4分钟内处理完成，停止升级。' >&2; false; }
podman stop -t 30 ops_worker_1 >>"$LOG" 2>&1
echo '备份数据库和完整 data 目录。'
podman exec ops_db_1 pg_dump -U voice -d voice_collector --format=custom > "$BACKUP_DIR/database.dump"
test -s "$BACKUP_DIR/database.dump"
podman exec -i ops_db_1 pg_restore --list < "$BACKUP_DIR/database.dump" > "$BACKUP_DIR/database-contents.txt"
tar -C "$ROOT_DIR" -czf "$BACKUP_DIR/data.tar.gz" data
(cd "$BACKUP_DIR" && sha256sum database.dump data.tar.gz ops.env previous-source.tar.gz > SHA256SUMS)
echo '启动新版 API，并等待数据库迁移完成。'
MIGRATION_STARTED=1
# Removing depends_on from YAML does not remove dependencies stored on old
# containers. Delete stopped dependents first; check each native Podman result.
podman rm ops_web_1 ops_worker_1 >>"$LOG" 2>&1
podman rm ops_api_1 >>"$LOG" 2>&1
pc up -d --no-build --no-deps api
READY=0
for ((i=0; i<60; i++)); do
  if podman exec ops_api_1 curl -fsS http://127.0.0.1:8000/health/ready >>"$LOG" 2>&1; then READY=1; break; fi
  sleep 2
done
if [[ "$READY" != 1 ]]; then
  podman logs --tail=100 ops_api_1 >>"$LOG" 2>&1
  echo 'API 健康检查超时。' >&2
  false
fi
if [[ "$(podman inspect ops_api_1 --format '{{.Image}}')" != "$(cat "$BACKUP_DIR/new-api-image.txt")" ]]; then
  echo 'API 容器运行的不是本次构建镜像，停止部署。' >&2
  false
fi
podman exec ops_api_1 alembic current >>"$LOG" 2>&1
pc up -d --no-build --no-deps worker web
WEB_READY=0
for ((i=0; i<30; i++)); do
  if podman exec ops_web_1 wget -q -O /dev/null http://127.0.0.1/ >>"$LOG" 2>&1 &&
     podman exec ops_web_1 wget -q -O /dev/null http://127.0.0.1/health/ready >>"$LOG" 2>&1; then WEB_READY=1; break; fi
  sleep 2
done
[[ "$WEB_READY" == 1 ]]
[[ "$(podman inspect ops_worker_1 --format '{{.State.Running}}')" == true ]]
for service in worker web; do
  [[ "$(podman inspect "ops_${service}_1" --format '{{.Image}}')" == "$(cat "$BACKUP_DIR/new-${service}-image.txt")" ]]
done
printf '%s\n' "$COMMIT" > "$BACKUP_DIR/deployed-commit.txt"
echo "部署成功：$COMMIT"
echo "备份和日志：$BACKUP_DIR"
podman ps --filter label=com.docker.compose.project=ops --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
