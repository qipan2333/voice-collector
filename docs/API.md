# 接口与状态

## 学生接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/v1/participant/exchange` | 邀请码交换学生会话 |
| GET | `/api/v1/participant/context` | 获取任务、同意状态和历史录音 |
| POST | `/api/v1/participant/consent` | 写入知情同意回执 |
| PUT | `/api/v1/participant/profile` | 保存必填个人信息 |
| POST | `/api/v1/participant/attempts` | 创建录音尝试 |
| PUT | `/api/v1/participant/attempts/{id}/content` | 上传完整录音 |
| POST | `/api/v1/participant/attempts/{id}/finalize` | 将录音加入处理队列 |
| GET | `/api/v1/participant/attempts/{id}/status` | 查询处理状态 |
| POST | `/api/v1/participant/asr/chunks` | 临时 WAV 分片识别 |

跟读分片接口要求学生 Cookie、`Content-Type: audio/wav`、`X-ASR-Session-Id` 和递增的 `X-ASR-Sequence`。返回识别文字和延迟；接口不会持久化分片或转写结果。

学生流程为：确认当前版本知情同意 → 填写个人信息 → 朗读题 → 自我表述题。个人信息包含 `name`、`school`、`grade`、`class_name`、`phone`、`student_number`；学校、年级、班级暂由学生手动填写，不校验选项名单；六项信息仍必填，学号按字符串保存以保留前导零。

创建录音时传 `task_type: "reading" | "self_expression"`，默认 `reading`。朗读题没有 3 分钟门槛（worker 仍拒绝不足 1 秒的无效音频）；自我表述题要求客户端时长和实际音频时长均不少于 180 秒，且本轮朗读题已经 `ready`。每轮每题最多创建 3 次录音；同一题已入队或完成后不能重复创建。上传失败可用同一个 attempt 重传，finalize 对 queued/processing/ready 幂等。

Context 返回 `participant_info`、`recording_round`，每条录音返回 `task_type` 和 `recording_round`。只以当前轮的录音恢复进度；本轮两题都处理成功才将邀请设为 `submitted`。管理员重开会增加轮次，保留之前的录音，学生需重录两题。

## 管理接口

```text
POST  /api/v1/admin/login
GET   /api/v1/admin/session
DELETE /api/v1/admin/session
GET   /api/v1/admin/dashboard
GET   /api/v1/admin/studies
GET   /api/v1/admin/studies/{id}
POST  /api/v1/admin/studies
PATCH /api/v1/admin/studies/{id}
POST  /api/v1/admin/studies/{id}/open
POST  /api/v1/admin/studies/{id}/close
POST  /api/v1/admin/studies/{id}/archive
POST  /api/v1/admin/studies/{id}/restore
POST  /api/v1/admin/invites/bulk
GET   /api/v1/admin/recordings
GET   /api/v1/admin/studies/{id}/recordings
GET   /api/v1/admin/recordings/{id}/audio
POST  /api/v1/admin/invites/{id}/reopen
PATCH /api/v1/admin/recordings/{id}/review
PATCH /api/v1/admin/recordings/review/bulk
PATCH /api/v1/admin/recordings/{id}/qc
POST  /api/v1/admin/exports
GET   /api/v1/admin/exports/{id}
GET   /api/v1/admin/exports/{id}/download
```

任务状态为 `draft`、`open`、`closed`、`archived`。只有草稿可以修改题目内容；开放中和已关闭任务可单独修改 `school_options`、`grade_options`、`class_options`，不会改变文本版本。选项字段保留以兼容已有数据，但后台配置入口暂时隐藏，不再要求配置选项才能开放任务。关闭任务会阻止创建新录音，但已创建的上传和处理任务会继续。

自动质量状态为 `pending/pass/review/reject`，人工审核状态独立为 `pending/approved/rejected`。旧 QC 更新接口保留为兼容入口，新管理页面使用 review 接口。

## 状态

邀请：`unused`、`active`、`submitted`、`reopened`、`withdrawn`、`disabled`。

录音：`created`、`uploading`、`queued`、`processing`、`ready`、`failed`、`superseded`、`deleted`。

## 认证与错误

- 学生和管理员均使用 HttpOnly Cookie 会话。
- API 错误使用 HTTP 状态码和 JSON `detail` 字段。
- `401` 表示会话失效，`403` 表示权限或同意条件不满足，`409` 表示状态冲突，`413` 表示文件超限，`429/503` 表示跟读识别旁路不可用。

导出的 manifest.csv 包含题型、录音轮次和六项个人信息；音频目录按参与者和题型区分。管理录音列表也返回并展示个人信息。
