# Nginx 反向代理

下面配置假设域名为 `voice.example.org`，证书路径由现有证书系统替换。Nginx 只代理 Web 容器，Web 容器内部再将 `/api` 和 `/health` 转发给 API。

```nginx
server {
    listen 443 ssl http2;
    server_name voice.example.org;

    ssl_certificate     /etc/letsencrypt/live/voice.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/voice.example.org/privkey.pem;

    client_max_body_size 60m;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

录音上传会达到几十 MB，`client_max_body_size` 必须不小于应用上传上限。修改后检查并重载：

```bash
nginx -t
systemctl reload nginx
```

麦克风权限要求 HTTPS；通过 IP 地址或普通 HTTP 访问通常不能完成手机录音。
