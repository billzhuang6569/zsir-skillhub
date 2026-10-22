---
title: APP 与 Server 兼容矩阵
description: 通过最低客户端版本和能力发现判断功能是否可用。
sidebar: { order: 2 }
---

APP 与 Server 不要求版本号完全相同。APP 测试连接读取 Server 的 `minClientVersion`，按严格 SemVer 比较；客户端低于下限则阻止连接并提示升级，`null` 表示没有额外版本下限，不表示所有功能都支持。

| 组合或能力 | 行为 |
| --- | --- |
| v0.32 起的空间客户端与自部署 Server | 要求有效部署档、实例身份、登录方式和服务合同 |
| v0.32 起客户端连接旧官方服务 | 固定官方地址可兼容缺少新增字段的健康响应，仍检查明确的最低版本 |
| Server 缺 `skills.library-sync.v1` | 不启用账号库同步，本机功能保留 |
| Server 缺 `skills.library-organizer.v1` | 不启用整理器云同步 |
| Server 缺 `teams.management.v1` | 不启用团队功能 |
| Server 缺 `runtime.env.v1` | 不启用团队钥匙解析 |
| 自部署缺 `features.catalogInstall` | 官方商店安装保留本机，不绑定实例账号库 |
| 缺或关闭 AI、头像 feature | 不提供对应生成能力，已有内容仍保留 |

自部署的旧合同、缺失身份或非法最低版本不能靠改 APP 版本字符串绕过。遇到 `426` 按提示升级，例如旧团队凭据接口不再受支持。

来源：`server/src/server-info.ts`、`server/src/config-schema.ts`、`desktop/src-tauri/src/spaces.rs`。本文描述代码的兼容规则，不用版本号替代实际能力检查。自部署升级步骤见 [备份与升级](../self-host/backup-restore-upgrade.md)。
