---
title: 云服务器准备
description: 在 public 安装前核对资源、域名、端口和证书条件。
sidebar: { order: 3 }
---

## 资源与工具

准备可运行 Docker 的 macOS / Linux 主机、Compose v2、OpenSSL；`public` 还需要 `dig`、`curl` 和 `ss` 或 `netstat`。构建约需 1.5 GB 内存（含 swap）；1 GB 主机请先增加至少 1 GB swap。

以下只适用于 Linux，先确认 `/swapfile` 不存在，再执行；本次启动生效，重启后需重新启用：

```sh
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
```

## 域名与网络

1. 为服务器准备域名，例如 `skills.example.com`。
2. 所有 A 记录指向当前服务器的 IPv4 出口；有可用 IPv6 才配置 AAAA。旧 AAAA 会使部分客户端访问错误机器，即使 A 正确也可能失败。
3. 在云安全组、宿主防火墙以及适用的路由器上开放 TCP 80/443；确认没有其他服务占用。
4. 准备 ACME 联系邮箱，例如 `admin@example.com`。安装选择 `public` 后由 Caddy 申请并维护证书。

向导会检查 DNS 与出口地址是否一致，以及本机端口占用；本机检查通过不代表外网一定可达。CDN、多出口或特殊 NAT 环境使用 [proxy 预设](existing-gateway.md)。

## 地域与接入要求

中国大陆服务器对外提供域名服务通常需要 ICP 备案，按接入商要求办理。也可考虑港澳或海外区域，先向接入商确认域名接入、网络和相关要求；不要仅凭服务器地理位置推断全部合规义务。参见 [阿里云接入说明](https://www.alibabacloud.com/help/en/icp-filing/basic-icp-service/product-overview/icp-filing-requirements-for-a-regular-website)。

无法开放端口时可使用已有 HTTPS 网关或尾网。DNS-01 需要带相应 DNS 插件的 Caddy 镜像与受限凭据，当前向导不代配。

完成后进入 [一条命令安装](one-command-install.md)。证书报错见 [故障排查](troubleshooting.md#cert-untrusted)。
