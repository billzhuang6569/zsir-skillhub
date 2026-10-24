---
title: CLI 命令参考
description: 当前 skillhub 命令的参数、预检执行方式与退出码。
sidebar: { order: 4 }
---

来源：`desktop/src-tauri/src/main.rs`、`lib.rs` 的帮助分派、`cli_*.rs` 的 usage 与解析器；同步和运行分别见 `library_sync/mod.rs`、`runtime_env.rs`。尖括号是待替换参数，方括号是可选项，不要原样执行。

控制面命令默认向 stdout 输出同一 JSON 信封，省略 `--json` 与显式传入的结果相同。`--help` 与 `--version` 保持纯文本；用法错误的 `nextActions` 给出对应的帮助命令。

## 状态和空间

```text
skillhub --help
skillhub --version
skillhub status [--json]
skillhub doctor [--json]
skillhub auth status [--refresh] [--json]
skillhub agent list [--json]
skillhub app open [--json]
skillhub update check [--json]
skillhub server show [--json]
skillhub server use <url|official|local> [--json]
```

`server show` 的档案字段位于 `data`；`server use` 成功返回 `data.profile/origin/spaceId`，APP 运行时返回 `CONFLICT` 和退出码 4，操作提示位于 `nextActions`。

`server show` 只读本机活动档案，不做在线验证。`server use` 仅在 APP 未运行时切换为目标游客，不登录或迁移；登录从 APP 完成。`update check` 只检查，安装更新由 APP 确认。

## 本机 Skill

```text
skillhub skill list [--query <text>] [--json]
skillhub skill show --skill-id <id> [--json]
skillhub skill discover [--agent <key>] [--json]
skillhub skill import preflight --path <path> [--skill-id <id>] [--json]
skillhub skill import apply --path <path> [--skill-id <id>] --plan-digest <digest> [--replace-conflicts] [--json]
skillhub skill install preflight --skill-id <id> --agent <key> [--agent <key> ...] [--json]
skillhub skill install apply --skill-id <id> --agent <key> [--agent <key> ...] --plan-digest <digest> [--replace-conflicts] [--json]
skillhub skill enable preflight --skill-id <id> --agent <key> [--json]
skillhub skill enable apply --skill-id <id> --agent <key> --plan-digest <digest> [--replace-conflicts] [--json]
skillhub skill disable preflight --skill-id <id> --agent <key> [--json]
skillhub skill disable apply --skill-id <id> --agent <key> --plan-digest <digest> [--json]
skillhub skill uninstall preflight --skill-id <id> [--json]
skillhub skill uninstall apply --skill-id <id> --plan-digest <digest> [--json]
skillhub skill history --skill-id <id> [--json]
skillhub skill diff --skill-id <id> --working [--json]
skillhub skill diff --skill-id <id> --from <hash> --to <hash> [--json]
skillhub skill snapshot --skill-id <id> --message <text> [--version <0.1.1>] [--json]
skillhub skill restore-version preflight --skill-id <id> --hash <40hex> [--receipt-id <uuid>] [--json]
skillhub skill restore-version apply --skill-id <id> --hash <40hex> [--receipt-id <uuid>] --plan-digest <digest> [--json]
skillhub skill delete preflight --skill-id <id> [--json]
skillhub skill delete apply --skill-id <id> --plan-digest <digest> [--json]
skillhub skill trash list [--json]
skillhub skill trash restore preflight --trash-id <id> [--json]
skillhub skill trash restore apply --trash-id <id> --plan-digest <digest> [--json]
skillhub skill prepare-edit (--skill-id <id> | --skill-path <SKILL.md>) [--json]
skillhub skill finish-edit <session-id> [--json]
skillhub skill analyze <local-skill-id> --preflight [--json]
skillhub skill analyze <local-skill-id> --apply --plan-digest <digest> [--json]
```

`--replace-conflicts` 不是默认选项，只有核对预检冲突后才使用。`prepare-edit` 返回工作副本与完成命令，只编辑该副本。已加入账号的条目删除需在 APP 使用账号删除入口。

## 商店与团队

```text
skillhub marketplace search [--query <text>] [--category <category>] [--label <label>] [--agent <agent>] [--sort latest|downloads] [--page <n>] [--page-size <n>] [--json]
skillhub marketplace show <skill-id> [--json]
skillhub marketplace updates [--json]
skillhub marketplace install <server-skill-id> --preflight [--json]
skillhub marketplace install <server-skill-id> --apply --plan-digest <digest> [--json]
skillhub team list [--json]
skillhub team skills <team-id> [--json]
skillhub team show <skill-id> [--json]
skillhub team updates [--json]
skillhub team install <server-skill-id> --preflight [--json]
skillhub team install <server-skill-id> --apply --plan-digest <digest> [--json]
skillhub team share preflight --local-skill-id <id> --team-id <uuid> [--json]
skillhub team share apply --local-skill-id <id> --team-id <uuid> --plan-digest <64hex> [--json]
skillhub team share status --local-skill-id <id> --team-id <uuid> [--json]
skillhub team unshare preflight --local-skill-id <id> --team-id <uuid> [--json]
skillhub team unshare apply --local-skill-id <id> --team-id <uuid> --plan-digest <64hex> [--json]
```

商店、团队 install 是取得本机内容；安装到具体 Agent 另用 `skill install`。团队操作要求当前空间登录与相应权限。

## 钥匙、同步与运行

```text
skillhub env status [--skill-id <local-skill-id>] [--json]
skillhub env request --skill-id <local-skill-id> --key <KEY> [--reason <text>] [--json]
skillhub sync [--retry] [--json]
skillhub sync status [--json]
skillhub run <skill-id> -- <program> [args...]
```

钥匙命令只处理状态与需求，不输出值；授权与填写在 APP 完成。`sync status` 是本机记录，`sync` 才触发引擎；仅本机空间不支持账号同步。

仅本机空间（`profile: local`）下，`team`、`sync`（含 `--retry` 和 `status`）、`feedback submit`、`skill analyze` 返回 `SPACE_UNSUPPORTED`，退出码为 2，不发起网络请求。反馈在 preflight 阶段就拒绝；`nextActions` 引导你到 APP 设置 → 服务与账号连接一探官方或自部署服务器。`auth status --refresh` 仍成功返回 guest，`data.profile` 为 `local`、`data.serverValidated` 为 `false`。

## 反馈

```text
skillhub feedback submit preflight --type <bug|usage|feature|other> --content <text> [--contact <text>] [--include-diagnostics] [--json]
skillhub feedback submit apply --type <bug|usage|feature|other> --content <text> [--contact <text>] [--include-diagnostics] --operation-id <uuid> --plan-digest <64hex> [--json]
skillhub feedback status --operation-id <uuid> [--json]
```

先审阅提交内容与诊断范围。响应不确定时用 operation ID 查询结果，不能直接重新下发。

## 返回和退出码

JSON 命令包含 `schemaVersion`、`ok`、`command`、`account`、`data`、`warnings`、`nextActions`，失败可含 `error`。不要只看终端有没有文字；同时检查退出码与 `ok`。

| 退出码 | 常规 CLI 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 内部错误 |
| 2 | 参数错误或空间不支持（`SPACE_UNSUPPORTED`） |
| 3 | 账号或授权错误 |
| 4 | 冲突、计划失效或忙碌 |
| 5 | 网络错误 |

`skillhub run` 还涉及被启动程序自身的退出状态，不能把任意子进程退出码都按这张表解释。运行失败的钥匙错误见 [钥匙指南](../guides/keys.md)。
