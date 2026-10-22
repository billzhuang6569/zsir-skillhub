---
title: 在自己电脑上部署
description: 使用 local 预设启动仅供同机访问的 SkillHub Server。
sidebar: { order: 2 }
---

**local 预设要求 APP 与 Server 在同一台电脑**，只发布回环 `127.0.0.1:3001`。APP 只有 macOS 与 Windows 版：Mac 可使用 Docker Desktop、OrbStack 或 colima 提供 Docker；Windows 本脚本未提供原生安装步骤，WSL2 中的 Docker 未验证。Linux 服务器没有桌面 APP，请用 [public](cloud-preparation.md) 或 [proxy](existing-gateway.md) 预设，让另一台电脑的 APP 连接。

先 [下载安装 APP](../getting-started/install-app.md)，安装并启动 Docker。取得完整源码（整个仓库，构建需要 `server/` 等目录，不能只拷贝 `deploy/selfhost`）：

```sh
git clone https://github.com/billzhuang6569/zsir-skillhub
cd zsir-skillhub
git checkout <发布 tag>
```

公开仓库地址尚未确定，`OWNER` 是占位；取得实际地址后替换它，并把 `<发布 tag>` 替换为所需的已发布标签，不能原样执行。

在仓库根目录检查工具。Compose 最低要求是 v2 主版本且支持 `up --wait-timeout`；`docker compose version` 显示 v2.x 或更高主版本均可，下面帮助检查有输出即可：

```sh
docker compose version
docker compose up --help | grep -- --wait-timeout
openssl version
bash deploy/selfhost/install.sh
```

向导为英文交互，看到以下提示时输入 `local` 并回车：

```text
Where to deploy? local / public / proxy: local
```

首次安装预计 1.5–5 分钟，取决于网络与主机性能。不需要域名，数据库不发布宿主端口。完成输出示例如下，初始化码是四组四字符，下面只展示占位值：

```text
Server /health is ready. App server address: http://127.0.0.1:3001
One-time setup code: XXXX-XXXX-XXXX-XXXX
Expires 30 minutes after Server startup; keep it private.
```

在私人终端保管初始化码。创建管理员前，码在 Server 启动后 30 分钟过期；每次重启（含 stop/up、backup 或 upgrade 导致的重启）签发新码，旧码立即失效。见 [初始化码过期](troubleshooting.md#setup-code-expired)。已创建管理员后不再签发初始化码。

在仓库根目录检查服务状态与健康响应：

```sh
cd deploy/selfhost && docker compose ps
curl -fsS http://127.0.0.1:3001/health
```

打开同一台电脑的 APP，依次进入侧边栏「设置」→「服务与账号」→「自部署服务器」，填写向导给出的 APP 地址，点「测试连接」→「连接到这台服务器」，按 [初始化管理员](create-admin.md) 完成设置。完整说明见 [在 APP 中连接](connect-app.md)。必须原样复制地址，不替换为 `localhost`，否则可能因 Host 校验被拒绝。

“空间”是某种服务及其账号数据的独立范围。已登录一探官方也可直接切换，原空间数据保留，详见 [空间切换](../account-and-data/switch-spaces.md)。连接成功后可 [导入第一个 Skill](../guides/import-skill.md)。

需要另一台电脑连接时，`local` 不适用；选择 [云服务器](cloud-preparation.md) 或 [HTTPS 网关](existing-gateway.md)，不要把 HTTP 地址改成局域网地址尝试绕过安全检查。

日常停止与恢复，在 `deploy/selfhost` 目录执行（若还在仓库根目录，先运行 `cd deploy/selfhost`）：

```sh
docker compose stop
docker compose up -d --wait --wait-timeout 180
```

停止保留数据。服务使用 `restart: unless-stopped`：未手动停止的服务随 Docker 启动自动恢复；手动 `docker compose stop` 过的服务在主机重启后不会自动启动，需执行上面的 `up` 命令。不要删除 `.env` 或数据卷来重新初始化。开始保存重要内容前，先阅读 [备份与恢复](backup-restore-upgrade.md)。
