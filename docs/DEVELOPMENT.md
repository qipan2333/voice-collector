# 本地开发

## 前置条件

- Docker Engine 和 Docker Compose Plugin
- Node.js 22 或兼容版本（仅在直接运行前端时需要）
- Python 3.13（仅在直接运行 API 测试时需要）

## Docker 启动

```bash
cp .env.example .env
docker compose -f ops/docker-compose.yml up -d --build
docker compose -f ops/docker-compose.yml ps
```

本地 Web 地址为 `http://127.0.0.1:5173`，API 地址为 `http://127.0.0.1:8000`。开发环境如需手机访问，可将 `WEB_PORT` 改为可访问端口并配置网络转发；录音仍要求 HTTPS 安全上下文。

## 直接运行前端

```bash
cd apps/web
npm ci
npm run dev
npm test
npm run build
```

Vite 会将 `/api` 和 `/health` 代理到 `127.0.0.1:8000`。

## API 测试

推荐在 API Docker 镜像中运行，确保 ffmpeg 和 Python 依赖一致：

```bash
docker build -t voice-collector-api-test apps/api
docker run --rm -e PYTHONPATH=/app \
  -v "$PWD/apps/api/tests:/app/tests:ro" \
  voice-collector-api-test pytest -q
```

## 代码约定

- API 路径统一使用 `/api/v1`。
- 所有时间使用带时区的 UTC 时间。
- 音频处理失败必须写入可查询状态，不应让 worker 进程退出。
- 跟读识别是录音旁路，任何识别失败都不能丢失完整录音。
