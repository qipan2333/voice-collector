# 架构与数据流

## 组件

```text
浏览器（微信/手机 QQ）
        |
        | HTTPS
        v
宿主机 Nginx（证书、域名、反向代理）
        |
        | 127.0.0.1:5173
        v
Web 容器（Caddy 静态文件 + /api 反代）
        |
        +--> API 容器（FastAPI） --> PostgreSQL 容器
        |          |
        |          +--> MiMo HTTP ASR（可选）
        |
        +--> Worker 容器（ffmpeg/ffprobe）
```

## 录音流程

1. 管理员创建固定文本任务并生成邀请码。
2. 学生访问 `/#/join/<token>`，服务端交换为 HttpOnly 会话 Cookie。
3. 学生确认外部知情同意并授权麦克风。
4. 浏览器保存完整录音 Blob，同时 Web Audio 旁路生成 16kHz、单声道 PCM。
5. 跟读开启时，每 12–15 秒将临时 WAV 分片提交到 API，由 API 调用 MiMo 并返回识别文字。
6. 前端按短语做宽松、单向匹配，更新已读颜色、当前短语高亮和自动滚动。
7. 完整录音仍按原流程上传；API 创建处理任务，worker 校验、归档并生成标准 WAV。

## 持久化数据

- PostgreSQL：任务、邀请码、会话摘要、知情同意回执、录音元数据、处理任务、审计事件和导出任务。
- `data/recordings`：原始录音和标准化 WAV。
- `data/exports`：导出 ZIP。
- 不保存 MiMo 临时音频、转写文本或跟读对齐轨迹。

## 信任边界

- MiMo API Key 只存在 API 容器环境变量，不下发浏览器。
- 学生会话使用 HttpOnly Cookie；邀请码数据库只保存摘要。
- 生产入口由已有 Nginx 提供 HTTPS。API `8000` 和 Web `5173` 仅绑定宿主机回环地址。
