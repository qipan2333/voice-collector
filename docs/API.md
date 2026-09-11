# 接口与状态

## 学生接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/v1/participant/exchange` | 邀请码交换学生会话 |
| GET | `/api/v1/participant/context` | 获取任务、同意状态和历史录音 |
| POST | `/api/v1/participant/consent` | 写入知情同意回执 |
| POST | `/api/v1/participant/attempts` | 创建录音尝试 |
| PUT | `/api/v1/participant/attempts/{id}/content` | 上传完整录音 |
| POST | `/api/v1/participant/attempts/{id}/finalize` | 将录音加入处理队列 |
| GET | `/api/v1/participant/attempts/{id}/status` | 查询处理状态 |
| POST | `/api/v1/participant/asr/chunks` | 临时 WAV 分片识别 |

跟读分片接口要求学生 Cookie、`Content-Type: audio/wav`、`X-ASR-Session-Id` 和递增的 `X-ASR-Sequence`。返回识别文字和延迟；接口不会持久化分片或转写结果。

## 管理接口

```text
POST  /api/v1/admin/login
GET   /api/v1/admin/dashboard
POST  /api/v1/admin/studies
POST  /api/v1/admin/studies/{id}/open
POST  /api/v1/admin/invites/bulk
GET   /api/v1/admin/recordings
GET   /api/v1/admin/recordings/{id}/audio
POST  /api/v1/admin/invites/{id}/reopen
PATCH /api/v1/admin/recordings/{id}/qc
POST  /api/v1/admin/exports
GET   /api/v1/admin/exports/{id}
GET   /api/v1/admin/exports/{id}/download
```

## 状态

邀请：`unused`、`active`、`submitted`、`reopened`、`withdrawn`、`disabled`。

录音：`created`、`uploading`、`queued`、`processing`、`ready`、`failed`、`superseded`、`deleted`。

## 认证与错误

- 学生和管理员均使用 HttpOnly Cookie 会话。
- API 错误使用 HTTP 状态码和 JSON `detail` 字段。
- `401` 表示会话失效，`403` 表示权限或同意条件不满足，`409` 表示状态冲突，`413` 表示文件超限，`429/503` 表示跟读识别旁路不可用。
