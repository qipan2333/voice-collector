# 接口与状态

## 学生接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/v1/participant/exchange` | 公共任务链接创建新的参与记录及学生会话 |
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

每个任务的 `join_token` 唯一且固定，只有管理接口返回公共 `join_url`。`exchange` 传入链接中的 `token`；每次调用都创建新的参与记录和会话，即使浏览器已有会话或之前已经完成，也不会复用录音、个人信息或同意回执。任务未开放时拒绝参与；旧独立邀请码不再有效。

Context 返回 `participant_info`、`recording_round`，每条录音返回 `task_type` 和 `recording_round`。同一次参与中的状态刷新不会重新开始；本轮两题都处理成功才将参与状态设为 `submitted`。再次打开公共链接会开始全新参与，之前已提交的录音仍保留。学生端通过浏览器 localStorage 缓存六项个人信息（包括未完成的填写），下次只预填表单，仍须确认同意和保存信息。

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

任务状态为 `draft`（界面显示“未开始”）、`open`、`closed`、`archived`。只有未开始的任务可以修改题目内容；开放中和已关闭任务可单独修改 `school_options`、`grade_options`、`class_options`，不会改变文本版本。选项字段保留以兼容已有数据，但后台配置入口暂时隐藏，不再要求配置选项才能开放任务。关闭任务会阻止创建新录音，但已创建的上传和处理任务会继续。

任务列表和详情返回 `join_url`。公共链接在关闭、重新开放、归档、恢复和内容编辑后保持不变。旧 `/admin/invites/bulk` 仅作为兼容接口，忽略生成数量，总是返回包含一个公共链接的数组，不创建参与记录。`stats.invites_total` 现在表示打开链接产生的参与次数；同一人再次打开也计为新的一次。旧重开接口仍保留兼容，管理页面已移除重开按钮，重录直接打开公共链接即可。

自动质量状态为 `pending/pass/review/reject`，人工审核状态独立为 `pending/approved/rejected`。旧 QC 更新接口保留为兼容入口，新管理页面使用 review 接口。

## 状态

邀请：`unused`、`active`、`submitted`、`reopened`、`withdrawn`、`disabled`。

录音：`created`、`uploading`、`queued`、`processing`、`ready`、`failed`、`superseded`、`deleted`。

## 认证与错误

- 学生和管理员均使用 HttpOnly Cookie 会话。
- API 错误使用 HTTP 状态码和 JSON `detail` 字段。
- `401` 表示会话失效，`403` 表示权限或同意条件不满足，`409` 表示状态冲突，`413` 表示文件超限，`429/503` 表示跟读识别旁路不可用。

导出的 manifest.csv 包含题型、录音轮次和六项个人信息；音频目录按参与者和题型区分。管理录音列表也返回并展示个人信息。
