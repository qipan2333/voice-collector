# 生产部署

## 目录与服务

在服务器上保留项目目录，例如 `/opt/voice-collector`。Compose 会使用以下宿主机目录：

- `postgres-data`：PostgreSQL 数据
- `data`：录音和导出文件

启动命令：

```bash
cd /opt/voice-collector
cp .env.example .env
# 编辑 .env
docker compose -f ops/docker-compose.yml up -d --build
docker compose -f ops/docker-compose.yml ps
```

## 必填配置

```env
APP_ENV=production
APP_SECRET=随机长字符串
POSTGRES_PASSWORD=随机数据库密码
ADMIN_PASSWORD=随机管理员密码
PUBLIC_BASE_URL=https://voice.example.org
WEB_PORT=5173
```

可选跟读配置：

```env
MIMO_API_KEY=...
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
MIMO_ASR_MODEL=mimo-v2.5-asr
MIMO_ASR_RPM_LIMIT=90
MIMO_ASR_PARTICIPANT_INTERVAL_SECONDS=7.5
MIMO_REQUIRED_CONSENT_VERSION=consent-v2-mimo-asr
```

本地声音活动检测始终用于即时跟读。配置 MiMo 后，服务端默认限制同一参与者至少间隔 7.5 秒调用一次 ASR，前端会按约 8 秒的窗口进行位置校准；该默认值适合少量参与者同时跟读。

## 网络暴露

Web 仅绑定 `127.0.0.1:5173`，API 没有宿主机端口映射。已有 Nginx 负责 `443` 终止 TLS 并代理到 `127.0.0.1:5173`。不要将 `8000`、PostgreSQL `5432` 或容器网络端口暴露到公网。

## 更新与回滚

更新前必须备份 PostgreSQL 和 `data`。API 容器启动时会先执行 Alembic 迁移；worker 和 web 均等待 API 健康后启动，避免新代码在迁移完成前读取旧表结构。

```bash
docker compose -f ops/docker-compose.yml pull
docker compose -f ops/docker-compose.yml up -d --build
docker compose -f ops/docker-compose.yml logs --tail=100 api worker web
```

更新前先执行备份。代码回滚使用 Git 版本回退后重新构建；数据库迁移由 API 容器启动命令执行 `alembic upgrade head`。

## 现有 ECS 的一键 Podman 更新

在本地仓库根目录执行（不是在服务器上执行）：

```bash
bash ops/scripts/deploy-ecs.sh --check
bash ops/scripts/deploy-ecs.sh
```

默认 SSH 目标 `root@121.41.177.154`，项目目录 `/root/voice-collector`，Compose 项目名 `ops`。脚本使用现有 SSH 密钥和服务器 `ops/.env`，不会覆盖配置。该 ECS 根目录的 `.env` 与运行配置不一致，不要换用它。

脚本仅部署已提交且工作区干净的 HEAD，要求服务器工作区也干净，并能 fast-forward 到该提交。源码通过临时 Git bundle 上传，无需 git push 或服务器访问代码托管平台。仅检查时不会上传代码或改动服务。

执行流程：

1. 检查容器所属项目、数据库及录音绑定目录、数据库可用性、至少 10GB 空间；加部署锁防止并发发布。
2. 保存旧代码提交、源码包、镜像 ID 和配置；更新服务器代码，构建镜像。构建失败时原容器继续运行。
3. 暂停 web/API，最多等待 4 分钟让 worker 排空任务，再停止 worker。应在没有学生录音时部署，停机期间页面不可用，未提交的浏览器录音不会被备份。
4. 备份 PostgreSQL 和整个 data 目录，验证数据库备份目录并生成校验和。
5. 先删除已停止的旧 web/worker 容器，解除 Podman 保存的 API 依赖，再删除旧 API。逐条检查原生 podman rm 的返回结果，然后单独重建 API，自动执行 Alembic 迁移，等待健康检查通过并验证镜像 ID，然后重建 worker/web，验证页面及反向代理健康路径。

备份位置 `/root/voice-collector-backup-日期时间.随机后缀/`，包含 `database.dump`、`data.tar.gz`、`ops.env`、`previous-source.tar.gz`、`previous-commit.txt`、镜像 ID 和 `deploy.log`。日志可能包含 Podman Compose 输出的环境变量，目录和文件仅当前用户可读；脚本不会自动删除历史备份。

脚本针对现有 Podman 部署，不初始化新服务器。ECS 的 podman-compose 1.0.6 在 up 时不执行 no-deps，因此脚本生成移除 depends_on、使用绝对路径的专用 Compose 文件，再选择性重建 api/worker/web；不停止或删除数据库容器。

备份或排空任务失败时，脚本尝试恢复原容器；迁移开始后出现失败则停止并报告备份目录，不自动回滚数据库。数据库和旧源码必须配套恢复，不能只退回代码就认为已回滚。

可覆盖目标（仍要求相同的 ops 容器布局）：

```bash
DEPLOY_REMOTE_DIR=/root/voice-collector bash ops/scripts/deploy-ecs.sh root@121.41.177.154
```

若旧脚本停在 API 更新阶段并报告失败，先检查实际镜像 ID 和 Alembic 版本：旧 Podman Compose 可能在删除 API 被依赖阻止后仍返回成功并重启旧容器。新版脚本已改为先删除旧依赖容器，再更新 API，并保留镜像 ID 校验。
