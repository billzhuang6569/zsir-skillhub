---
title: 一条命令安装
description: 从完整源码运行安装向导并选择部署预设。
sidebar: { order: 5 }
---

在部署目标机器取得整个仓库，不能只拷贝 `deploy/selfhost`，构建还需要 `server/` 等目录。公开仓库尚未确定，以下 `OWNER` 待替换；`<发布 tag>` 也必须替换为实际已发布标签：

```sh
git clone https://github.com/billzhuang6569/zsir-skillhub
cd zsir-skillhub
git checkout <发布 tag>
```

最低要求为 Compose v2 主版本且支持 `up --wait-timeout`。版本显示 v2.x 或更高主版本均可，帮助检查有输出即可：

```sh
docker compose version
docker compose up --help | grep -- --wait-timeout
```

然后在源码根目录执行：

```sh
bash deploy/selfhost/install.sh
```

不需要宿主 Node，也不需要用 sudo 启动脚本；需要当前用户可用的 Docker 与 OpenSSL。首次安装预计 1.5–5 分钟，会下载镜像和 npm 包，时间取决于网络与主机性能。

英文提示为 `Where to deploy? local / public / proxy:`；本机部署输入 `local` 回车。local 的同机与平台限制、输出样例和健康检查见 [本机部署](local-deployment.md)。

| 选择 | 填写内容 | APP 使用的地址 |
| --- | --- | --- |
| `local` | 无 | 向导给出的同机 HTTP 回环地址 |
| `public` | 域名与 ACME 邮箱 | `https://skills.example.com` |
| `proxy` | 已有外部 HTTPS 基址 | 填写的 HTTPS 地址，可含路径前缀 |

向导等待 Server 健康，再显示初始化码与 APP 地址。已初始化实例使用已有管理员账号。公网 HTTPS 健康检查超时会停止 Caddy；修好 DNS、网络或证书问题后再重试，不要反复申请证书。

已有 `.env` 默认拒绝覆盖。确需重配可运行：

```sh
bash deploy/selfhost/install.sh --overwrite-env
```

它保留已有 JWT、KEK 和数据库密码，只接受向导生成的密钥格式；手工添加的配置要自行保留。先备份再重配，不要删除 `.env` 生成新密钥来连接旧数据库。

下一步：[创建管理员](create-admin.md)。安装细节的源码入口是 `deploy/selfhost/README.md`；本页按其中预设编写。
