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

## 2026-10 公共任务链接升级

新增迁移 `a6c48d91f302`，在 `7e902f5c81a2` 之后执行。每个任务生成唯一固定公共链接；重复获取不生成新链接。所有受试者共用此链接，每次打开从知情同意重新开始。浏览器本地缓存已填写的个人信息，后续预填但仍需确认保存；存储不可用时正常手动填写。

迁移保留任务 ID、标题、朗读题、自我表述题、个人信息选项及其他配置，将所有已有任务（包括关闭和归档任务）设为 `draft`，界面显示“未开始”。清空参与记录、学生会话、同意回执、录音及审核状态、处理队列、导出任务和历史审计事件；同时删除数据库关联的原始录音、标准化录音、上传源文件和导出 ZIP。管理员账号和会话保留。清理只在该迁移首次执行时发生，后续重启不会再清空新数据。

部署脚本会先备份再执行迁移。直接运行时，先停止 API 和 worker 并完成数据库及媒体备份，使用与 API 相同的 `DATABASE_URL` 和 `MEDIA_ROOT` 执行 `PYTHONPATH=apps/api .venv/bin/alembic upgrade head`，再启动服务。迁移删除的数据和文件只能通过备份恢复，执行 downgrade 只回退表结构。Docker API 启动时自动执行 `alembic upgrade head`。

升级后，管理员重新开放需要使用的任务，在“任务链接与导出”中复制公共链接重新分发；旧独立邀请链接全部失效。后台不再批量生成邀请码，也不需要逐人允许重录。关闭、重开、归档和恢复任务不会改变公共链接。参与次数按每次打开链接统计，不等于去重人数。

## 2026-10 实验流程升级（历史版本）

本次新增迁移 `7e902f5c81a2`。Docker API 启动时自动执行 `alembic upgrade head`；直接运行时需先在仓库根目录执行 `PYTHONPATH=apps/api .venv/bin/alembic upgrade head`，再重启 API、worker 和前端。

该历史迁移将旧录音归为第 1 轮朗读题，补充个人信息与自我表述题。升级至当前 head 时还会执行上方公共链接迁移，清空历史参与数据；最终状态以上方说明为准。自定义朗读文本保留，只有旧占位文本会替换为实验文档原文。新任务默认包含文档中的朗读原文和自我表述提示语。

学校、年级、班级暂时通过输入框手动填写；后台选项配置入口隐藏，旧选项数据保留但不限制学生填写。新版知情同意使用 `consent-v3-experiment`；配置了 MiMo 时，仅朗读题发送跟读分片；学生页面不展示 MiMo 分片说明。

朗读题读完即可结束；自我表述题满 180 秒后“完成”按钮变绿。worker 会按实际音频时长校验，自我表述不足 180 秒会失败并允许重录。测试覆盖两题流程、旧版同意失效、个人信息校验、失败重试、重开轮次、导出和旧数据库升级。

现有 ECS 使用 Podman，可在本地运行 `bash ops/scripts/deploy-ecs.sh` 更新，或加 `--check` 仅做只读检查。不要直接将 Docker 示例替换成旧版 `podman-compose up --force-recreate --no-deps`：ECS 上的 1.0.6 版本在 up 时忽略 no-deps。新脚本会生成移除 depends_on 的部署配置、逐阶段启动应用，避免重建数据库容器。

### 录音时自动息屏

两道题录音期间均会尝试请求 Screen Wake Lock，界面显示是否已开启；结束、出错或离开录音组件后释放。返回前台时重新请求；系统释放、请求失败或浏览器无接口时显示手动调整自动锁屏时间的提示和重试按钮。Caddy 响应头允许本站使用 screen-wake-lock。此功能不保证在所有微信/QQ 版本或省电状态下可用，也不会阻止用户手动锁屏。手机真机需确认“屏幕常亮已开启”后测试原有30秒自动锁屏设置。
