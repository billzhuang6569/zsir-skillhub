---
title: 已有网关与 Tailscale Serve
description: 使用 proxy 预设接入同机 HTTPS 网关或 Tailscale 尾网。
sidebar: { order: 4 }
---

1. 在部署目标主机运行 `bash deploy/selfhost/install.sh`，选择 `proxy`。
2. 填写外部 HTTPS 基址，例如 `https://skills.example.com`，也可带路径前缀。
3. 让同机网关转发到本机 Server 的回环端口 3001。仓库提供 `deploy/selfhost/nginx.conf.example` 模板。
4. 用 APP 测试外部地址，再登录。证书签发与续期由自己的网关负责。

网关须保留外部 Host；配置路径前缀时剥离前缀。必须覆盖来自客户端的不可信转发头，并发送真实客户端的 `X-Forwarded-For` 与 `X-Forwarded-Proto: https`。不要加 Cookie 登录、额外 CORS，或用身份头替代 SkillHub Bearer 认证。

## Tailscale Serve

在 Docker 同一宿主上启用 tailnet HTTPS，然后运行：

```sh
tailscale serve --bg --https=443 http://localhost:3001
tailscale serve status
```

向导中的 proxy URL 必须使用 Serve 实际给出的 HTTPS 地址；`skills.example.com` 仅是普通网关示例。APP 设备也必须有尾网访问权限。Serve 仅向 tailnet 提供服务，不等于公网 Funnel；按尾网授权限制访问，并检查所用版本是否正确发送上述转发头。

停止该监听：

```sh
tailscale serve --https=443 off
```

Compose 预设已配置专用可信代理网络。不要加入不可信容器，也不要将 Server 端口改为公网发布；网络冲突时必须同时调整子网、网关与 `TRUSTED_PROXIES`。见 [环境变量](../reference/environment-variables.md)。
