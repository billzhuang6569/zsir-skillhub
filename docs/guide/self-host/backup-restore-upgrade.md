---
title: 备份、恢复与升级
description: 分开保管数据与恢复材料，并在空环境恢复完整实例。
sidebar: { order: 9 }
---

升级到包含后台 Skill 分析的版本后，启动入口会自动迁移任务表，并补扫未分析、无图片的作者 Skill。无需增加环境变量；配置 AI 或 fal 后才执行对应任务。已继承分析资料或头像的副本保持原状。升级前仍须按下文备份；已有手动编辑痕迹的历史资料会保留。

## 备份

在 `deploy/selfhost` 目录运行：

```sh
./skillhub-server backup
```

交互输入至少 12 字符的口令并确认。工具暂停原本运行的 Server，完成或失败后尝试恢复；public 还短暂停止 Caddy，本地 SeaweedFS 叠加会短暂停止对象服务。原本停止的服务保持停止。

也可创建口令文件供 `backup`、`verify`、`restore`、`upgrade` 的 `--passphrase-file` 使用：

```sh
mkdir -p ~/private
chmod 700 ~/private
# 只在该文件尚不存在时执行，避免覆盖已有口令。
install -m 600 /dev/null ~/private/skillhub-backup-pass
```

随后用编辑器打开 `~/private/skillhub-backup-pass`，写入一行至少 12 字符的口令，末尾换行可以。文件须归当前用户所有、为普通文件、权限恰为 `0600`；不把口令写进命令参数。例如：

```sh
./skillhub-server backup --passphrase-file ~/private/skillhub-backup-pass
```

若还没创建管理员，初始化码在 Server 启动后 30 分钟过期；每次重启（包括 stop/up、backup、upgrade 中的重启）会签发新码，旧码立即失效。操作后使用新码，见 [初始化码过期](troubleshooting.md#setup-code-expired)。已初始化实例不再签发码。

输出两份配套材料：

| 材料 | 内容 | 保管方式 |
| --- | --- | --- |
| 数据目录 | manifest 与加密的数据库、媒体、卡片等分片 | 保存完整目录，不只保存 manifest |
| `.skr` 恢复文件 | 口令加密的数据密钥、配置原文与摘要 | 移到另一台设备，与数据目录分开保管 |

**两份材料和口令缺一不可；口令遗失无法恢复。** manifest 不含密钥，但包含实例身份、版本和统计。默认目录为仓库中的 `deploy/selfhost/backups/` 与 `deploy/selfhost/backups/recovery/`，均已被 Git 忽略；可用 `--out DIR --recovery-out DIR` 指定不同位置。失败留下 `.partial` 目录供排查，不能当成完成备份。

备份含数据库、整个媒体卷和头像历史、卡片包、`.env`、当前与历史加密密钥、实例身份私钥；public 另含证书状态，本地 SeaweedFS 另含对象卷。外部 S3 不包含在内，须独立备份 bucket。

## 验证

把下面占位路径换成实际配套材料路径：

```sh
./skillhub-server verify --backup /备份目录/skillhub-时间-ID --recovery /另一设备/skillhub-recovery-时间-实例.skr
```

刚备份后、材料还在默认位置时，可在 `deploy/selfhost` 使用相对路径（替换为本次实际名称）：

```sh
./skillhub-server verify --backup backups/skillhub-时间-ID --recovery backups/recovery/skillhub-recovery-时间-实例.skr --passphrase-file ~/private/skillhub-backup-pass
```

验证后将恢复文件移到另一台设备，不长期和数据备份放在一起。

验证完全离线，不启动服务、不修改备份，需要本地已有 `skillhub-selfhost-server` 工具镜像。空机可先在 `deploy/selfhost` 构建：

```sh
docker build -t skillhub-selfhost-server -f ../../server/Dockerfile ../..
```

## 空机恢复

1. 在全新 Docker 主机取得整个仓库，选择不低于备份版本的发布 tag。不能只复制部署目录，构建需要 `server/` 等目录。替换尚未确定的 `OWNER` 和实际 `<发布 tag>` 后执行：

```sh
git clone https://github.com/billzhuang6569/zsir-skillhub
cd zsir-skillhub
git checkout <发布 tag>
cd deploy/selfhost
```

**不要先运行 `install.sh`，不要创建 `.env` 或项目数据卷。**
2. 带入数据目录与对应 `.skr`，执行：

```sh
./skillhub-server restore --backup /备份目录/skillhub-时间-ID --recovery /恢复材料/skillhub-recovery-时间-实例.skr
```

3. 工具先构建镜像并完整验证材料，再写配置和恢复。配置保留原 APP 地址；公网域名需要指向新主机。
4. 看到“恢复完成”后，用原账号登录 APP，检查历史图片、卡片与团队钥匙实际运行。身份、密文、文件和健康检查通过不能替代这一步。

已有 `.env` 或任一项目数据卷会被拒绝，工具不删除它们；换全新主机。写入后失败时保留现场与日志，另建空环境重试。Postgres 主版本必须匹配，不能直接用新大版本挂旧卷。

## 升级

macOS 的 WorkBuddy AI.app 使用新的兼容 Agent 标识 `workbuddy-ai`；`workbuddy` 在 Mac/Windows 都表示 WorkBuddy。使用新版 APP 时，请同步升级 Server，再保存包含新标识的 Skill 资料；旧 Server 会拒绝未知标识。本机安装仍可使用，历史 AI 目录安装自动归属 WorkBuddy AI，链接与内容保持不变，见 [Agent 能力列表](../reference/agent-capabilities.md)。

在**原安装仓库**原地更新，不另 clone 新目录，否则 `.env` 与默认备份仍留在旧目录。若当前在 `deploy/selfhost`，先用 `cd ../..` 返回原仓库根目录；确认没有待保留的源码修改，再替换 `<新 tag>` 为所需发布标签并执行：

```sh
git fetch --tags && git checkout <新 tag>
cd deploy/selfhost
./skillhub-server upgrade
```

升级先成功备份，再更新镜像类服务、构建 Server、启动与检查健康；备份失败则停止升级。仍须移走恢复文件并保管口令。

**数据库迁移后不能只回退镜像**。需要回退时，用升级前完整备份在空环境恢复。不要执行 `docker compose down -v`，也不要删除 `.env` 重新生成密钥。

具体拒绝原因见 [恢复排查](troubleshooting.md#restore-existing-env)。
