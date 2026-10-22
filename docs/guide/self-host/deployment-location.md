---
title: 部署在自己电脑还是云服务器
description: 按访问范围与持续在线需求选择自部署位置。
sidebar: { order: 1 }
---

| 场景 | 预设 | 访问范围与维护 |
| --- | --- | --- |
| 先在自己电脑试用 | `local` | 仅同机 APP；电脑和 Docker 停止时不可用 |
| 多人通过公网使用 | `public` | 云服务器、域名、开放 TCP 80/443，由 Caddy 提供证书 |
| 已有 HTTPS 网关或尾网 | `proxy` | 同机网关转发；证书与访问控制由自己的网关维护 |

安装脚本支持 macOS / Linux，需要 Docker、支持 `up --wait-timeout` 的 Compose v2 或更高主版本与 OpenSSL。local 要求 APP 与 Server 同机；APP 只有 macOS / Windows 版，Linux 服务器请选 public 或 proxy。Mac 可用 Docker Desktop、OrbStack 或 colima；Windows 脚本没有原生安装步骤，WSL2 Docker 未验证。

构建约需 1.5 GB 内存（含 swap）；小内存主机须先准备足够资源。同步、备份与对象存储也需要磁盘空间。不要把仅供本机的监听端口直接开放到公网。

选择 [本机部署](local-deployment.md)、[云服务器准备](cloud-preparation.md) 或 [已有网关](existing-gateway.md) 后再安装。
