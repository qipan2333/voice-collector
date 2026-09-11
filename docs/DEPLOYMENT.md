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
