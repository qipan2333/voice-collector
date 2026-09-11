# Voice Collector

面向微信和手机 QQ 内嵌浏览器的学生朗读录音采集系统。目标是单 ECS 部署约 100 名参与者的固定文本录音任务。

## 当前实现范围

- React/Vite 移动端学生页面和管理页面
- FastAPI API、PostgreSQL 数据库
- 邀请码会话、知情同意确认、录音上传与状态查询
- 本地声音活动驱动的跟读高亮、自动滚动和小米 MiMo ASR 位置校准
- 多任务管理工作台、独立质量统计、在线播放和批量人工审核
- ffmpeg worker 的标准化入口
- Docker Compose、Caddy、健康检查和本机备份脚本

项目文档：

- [架构与数据流](docs/ARCHITECTURE.md)
- [本地开发](docs/DEVELOPMENT.md)
- [生产部署](docs/DEPLOYMENT.md)
- [Nginx 配置](docs/NGINX.md)
- [接口与状态](docs/API.md)
- [运维与故障排查](docs/OPERATIONS.md)
- [开发计划与约束](docs/DEVELOPMENT_PLAN.md)

## 本地启动

```bash
cp .env.example .env
docker compose -f ops/docker-compose.yml up -d --build
```

开发环境 API 默认位于 `http://localhost:8000`，前端开发服务器默认位于 `http://localhost:5173`。

学生端只放行微信和手机 QQ 内嵌浏览器，管理后台仍可使用桌面浏览器。麦克风权限要求 HTTPS；正式手机录音请使用带有效证书的 HTTPS 地址。前端兼容 `audio/mp4`、`audio/webm`、`audio/ogg`，并在没有 `MediaRecorder` 时使用 Web Audio PCM 录音兜底。

跟读高亮首先由浏览器本地的声音活动和任务预计时长即时驱动，不依赖网络即可在朗读和停顿时推进或暂停。设置 `MIMO_API_KEY` 且任务使用 `consent-v2-mimo-asr` 知情同意版本后，录音期间还会约每 8 秒发送一个临时 WAV 窗口用于位置校准；转写文字和分片不会写入数据库或导出包。未配置 MiMo、识别超时或限流时，本地跟读和完整录音仍会继续。当前学生端会限制为微信和手机 QQ 内嵌浏览器，管理后台不受此限制。

## 生产部署提醒

生产环境由宿主机已有 Nginx 负责域名、HTTPS 和证书。Compose 只将 Web 容器绑定到 `127.0.0.1:${WEB_PORT:-5173}`，默认不会占用宿主机 `80/443`。Nginx 将站点代理到 `http://127.0.0.1:5173`，并保持长连接/大请求体设置，以支持录音上传和跟读识别请求。

部署前复制 `.env.example` 为 `.env`，修改 `APP_SECRET`、数据库密码、公开 HTTPS 地址、管理员凭据和可选的 `MIMO_API_KEY`；不要把 `.env` 提交到版本库。

启动服务：

```bash
docker compose -f ops/docker-compose.yml up -d --build
docker compose -f ops/docker-compose.yml ps
```

健康检查：

```bash
curl http://127.0.0.1:8000/health/ready
curl -I http://127.0.0.1:${WEB_PORT:-5173}
```

Nginx 最小反向代理目标为 `127.0.0.1:5173`；不要直接把 API 端口 `8000` 暴露到公网。可直接使用 [docs/NGINX.md](docs/NGINX.md) 中的配置片段。
