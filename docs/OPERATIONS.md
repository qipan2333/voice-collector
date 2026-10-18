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

检查任务 `consent_version` 是否为 `consent-v3-experiment`（也兼容 `consent-v2-mimo-asr`）、`MIMO_API_KEY` 是否配置，以及 `/health/ready` 的 `asr_configured`。MiMo 限流、超时或识别失败不会影响完整录音。

### 磁盘空间不足

应用在剩余空间低于 10GB 时拒绝新上传。先导出并转移数据，再清理过期导出文件；不要直接删除仍在任务中的录音目录。

## 2026-10 实验流程升级

本次新增迁移 `7e902f5c81a2`。Docker API 启动时自动执行 `alembic upgrade head`；直接运行时需先在仓库根目录执行 `PYTHONPATH=apps/api .venv/bin/alembic upgrade head`，再重启 API、worker 和前端。

迁移保留旧录音及审核结果，将其归为第 1 轮朗读题。旧的 submitted 邀请变为 active，学生确认新版同意书、补全个人信息后继续完成自我表述题；已有成功朗读无需重录。旧同意回执保留，但不能代替新版本确认。自定义朗读文本保留，只有旧占位文本会替换为实验文档原文。新任务默认包含文档中的朗读原文和自我表述提示语。

学校、年级、班级暂时通过输入框手动填写；后台选项配置入口隐藏，旧选项数据保留但不限制学生填写。新版知情同意使用 `consent-v3-experiment`；配置了 MiMo 时，仍会在同意页明确展示跟读分片说明，仅朗读题发送分片。

朗读题读完即可结束；自我表述题满 180 秒后“完成”按钮变绿。worker 会按实际音频时长校验，自我表述不足 180 秒会失败并允许重录。测试覆盖两题流程、旧版同意失效、个人信息校验、失败重试、重开轮次、导出和旧数据库升级。

现有 ECS 使用 Podman，可在本地运行 `bash ops/scripts/deploy-ecs.sh` 更新，或加 `--check` 仅做只读检查。不要直接将 Docker 示例替换成旧版 `podman-compose up --force-recreate --no-deps`：ECS 上的 1.0.6 版本在 up 时忽略 no-deps。新脚本会生成移除 depends_on 的部署配置、逐阶段启动应用，避免重建数据库容器。
