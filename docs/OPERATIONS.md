# 运维与故障排查

## 日常检查

```bash
docker compose -f ops/docker-compose.yml ps
curl -fsS http://127.0.0.1:8000/health/live
curl -fsS http://127.0.0.1:8000/health/ready
docker compose -f ops/docker-compose.yml logs --tail=100 api worker web
```

`/health/ready` 会返回磁盘剩余空间、是否接受上传以及 `asr_configured`。

## 备份

仓库提供 `ops/scripts/backup.sh`，默认备份数据库和录音目录。正式研究前应将备份复制到异机或对象存储；仅保存在同一 ECS 无法抵御实例和磁盘整体故障。

```bash
bash ops/scripts/backup.sh
```

恢复前停止写入服务，确认备份完整，再恢复 PostgreSQL 和 `data` 目录。恢复后执行健康检查和一条测试录音流程。

## 常见问题

### 页面打不开

确认 `web` 容器健康、宿主机 `127.0.0.1:5173` 可访问，并检查 Nginx `proxy_pass`、域名解析和防火墙。

### 手机无法录音

必须使用有效 HTTPS；确认浏览器为微信或手机 QQ 内嵌页面，应用和系统均允许麦克风，并避免通话或其他录音程序占用设备。

### 录音一直处理中

检查 worker 日志、`data/recordings/incoming` 和 PostgreSQL 连接。worker 需要 ffmpeg；API 只负责入队，不负责格式转换。

### 跟读不变色

检查任务 `consent_version` 是否为 `consent-v2-mimo-asr`、`MIMO_API_KEY` 是否配置，以及 `/health/ready` 的 `asr_configured`。MiMo 限流、超时或识别失败不会影响完整录音。

### 磁盘空间不足

应用在剩余空间低于 10GB 时拒绝新上传。先导出并转移数据，再清理过期导出文件；不要直接删除仍在任务中的录音目录。
