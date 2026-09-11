# 语音朗读采集系统开发计划

## 已确定约束

- 约 100 名学生；每人朗读同一段约 3 分钟的固定文本。
- 学生端只支持 iOS、Android 上的微信和手机 QQ 内嵌浏览器；管理后台保留桌面浏览器支持。
- 使用匿名邀请码，不保存姓名和学号。
- 知情同意在系统外完成，网页记录确认状态、说明版本和时间。
- 使用浏览器压缩音频；兼容性优先，仅请求基础 `audio: true`，保留实际设备参数，并生成 48kHz/单声道/16-bit WAV 便于统一分析。
- 使用小米 MiMo HTTP ASR 对 12–15 秒临时 WAV 分片进行识别，按短语匹配原文并自动滚动；识别失败时继续录音并允许手动滚动。
- MiMo 识别文本、对齐轨迹和临时分片不持久化；启用跟读的任务必须使用 `consent-v2-mimo-asr` 知情同意版本。
- 提供完整后台：进度、试听、质量标记、重开、导出。
- 单 ECS 部署，最低建议 2 vCPU/4GB RAM；峰值并发不超过 20 人。
- 50GB 磁盘在正常采集规模下足够，但仅 ECS 本机备份不能抵御实例或磁盘整体丢失。

## 架构

- 前端：React + TypeScript + Vite + Tailwind CSS。
- 后端：FastAPI + SQLAlchemy + Alembic。
- 数据库：ECS 内 PostgreSQL 容器。
- 音频处理：独立 worker 容器调用 ffmpeg/ffprobe。
- 入口：宿主机已有 Nginx 处理 HTTPS，Web 容器内 Caddy 只提供静态文件并代理 `/api`。
- 部署：Docker Compose；Web 仅绑定宿主机回环地址，数据通过宿主机目录持久化。

## 核心行为

1. 管理员创建文本版本并批量生成邀请码。
2. 学生通过 fragment URL 进入，交换为短期 HttpOnly 会话。
3. 学生确认已完成外部知情同意，完成麦克风测试后开始录音。
4. 前端保存完整原始 Blob，同时旁路生成 16kHz 单声道 WAV 分片；识别结果以宽松、单向的短语匹配推进文字变色和滚动。
5. API 以临时文件接收上传，校验后进入处理队列。
6. worker 记录原始 MIME、浏览器参数、ffprobe 信息、时长和 QC 指标，并生成标准化 WAV。
7. 管理员查看进度和音频，必要时重开或标记质量状态。
8. 导出包包含 CSV manifest、文本版本、原始文件、标准化文件和 SHA-256 清单。

## 状态与接口

邀请状态：`unused`、`active`、`submitted`、`reopened`、`withdrawn`、`disabled`。

录音状态：`created`、`uploading`、`queued`、`processing`、`ready`、`failed`、`superseded`、`deleted`。

学生接口：

```text
POST /api/v1/participant/exchange
GET  /api/v1/participant/context
POST /api/v1/participant/consent
POST /api/v1/participant/attempts
PUT  /api/v1/participant/attempts/{id}/content
POST /api/v1/participant/attempts/{id}/finalize
GET  /api/v1/participant/attempts/{id}/status
POST /api/v1/participant/asr/chunks
```

管理接口：

```text
POST /api/v1/admin/login
GET  /api/v1/admin/dashboard
POST /api/v1/admin/studies
POST /api/v1/admin/invites/bulk
GET  /api/v1/admin/recordings
POST /api/v1/admin/invites/{id}/reopen
PATCH /api/v1/admin/recordings/{id}/qc
POST /api/v1/admin/exports
```

## 容量和风险

- 192kbps、3 分钟压缩音频约 4.3MB/人。
- 48kHz 单声道 16-bit WAV 约 16.5MiB/人。
- 上传上限 50MB，单次录音最长 480 秒。
- 磁盘剩余空间低于 10GB 时阻止新上传。
- 本机备份保留 7 个日备份和 4 个周备份；正式研究前应评估是否增加 OSS/S3 等异机备份。

## 开发顺序

1. 基础工程、Compose、数据库迁移和健康检查。
2. 邀请码、会话、上传 API 和处理队列。
3. 学生端录音流程和移动端视觉。
4. 音频 worker、QC、后台和导出。
5. HTTPS、备份、恢复演练、真实手机试点和并发压测。
