# 账号与鉴权

APP 是唯一登录入口。CLI 自动继承 APP 当前账号；不要要求用户在 CLI 再登录，也不要索取密码、Token 或用户 ID。

`skillhub server show [--json]` 只读当前空间（不做在线验证），JSON 信封的 `data` 包含 profile、origin、spaceId、generation、signedIn、pending 和 serverValidated。`skillhub server use <url|official|local>` 仅在 APP 未运行时可用；成功返回 `data.profile/origin/spaceId`；APP 持锁时返回 `CONFLICT`、退出码 4，并在 `nextActions` 提示「请在 APP 设置页切换」。切换会保留原数据，但目标为游客，服务器空间需回 APP 登录；CLI 不接受密码、不做初始化，也不迁移数据。两个实例即使用户 UUID 相同也不共用账号数据。

规范命令语法是 `skillhub auth status [--refresh] [--json]`；方括号表示 `--refresh` 与 `--json` 可选，不要把方括号原样传给 Shell。

## 三种空间与仅本机空间

先读取当前空间的 `profile`，不要从登录状态猜空间：

```sh
skillhub server show --json
```

`profile` 为 `local`（仅本机）、`official`（一探官方）或 `selfhost`（自部署）。`local` 不连接业务服务器。本地 Skill 的查询、导入、Agent 投影、版本、`env status` 和 `run` 可用；运行仍须满足该 Skill 的钥匙与授权要求。

`profile` 为 `local` 时，`skill analyze`、`team` 全部子命令、`sync`（包括 `--retry`、`status`）和 `feedback submit` 返回 `SPACE_UNSUPPORTED`、退出码 2，不发起网络请求；反馈在 preflight 阶段就拒绝。按下方标准说法解释，不要当作故障上报或重试。`auth status --refresh` 仍成功返回 guest，`data.profile` 为 `local`、`data.serverValidated` 为 `false`，不做在线验证。

Marketplace 安装走官方目录的免登录链路，不要求当前空间账号；仍需联网并按预检/apply 流程执行。不能把它解释成账号同步。

标准说法：

> 当前是仅本机空间，团队与账号同步需要在 SkillHub APP 的设置 → 服务与账号中连接一探官方或自部署服务器后使用。

不要建议用 `server use` 绕过 APP 登录；连接服务器与登录账号是两步，切换空间不迁移数据。

## 查询当前账号

快速查看本机会话状态：

```sh
skillhub auth status --json
```

当回答“我登录的是谁”或执行任何账号型操作时，必须向 Server 验证：

```sh
skillhub auth status --refresh --json
```

读取 `account.state`、`account.verified` 和 `data.serverValidated` 判断验证状态。只使用响应中的公开账号字段，例如 `id`、`email`、`displayName`、`avatarUrl` 和 `marketplaceRole`。本地存在会话但未经 Server 验证，只能描述为未验证；不能断言在线登录有效。

## 状态处理

- `guest`：提示用户在已安装的 SkillHub APP 登录，然后重新查询；其他账号型命令可返回 `AUTH_REQUIRED`。
- `unverified`：若任务需要账号，使用 `--refresh`；不要把它当作已验证。
- `sync_pending` / `AUTH_SYNC_PENDING`：APP 正在切换或同步账号；等待 APP 完成后重新查询，不能使用旧会话。
- `offline` / `OFFLINE`：保留当前会话，仅暂停网络任务；不得声称用户已退出。
- `expired` / `AUTH_EXPIRED`：提示用户回到 APP 重新登录。
- `invalid`：结合 `AUTH_IDENTITY_MISMATCH` 或 `AUTH_SESSION_UNSAFE` 说明会话失效原因，并提示用户打开 APP 修复。
- `unknown`：不要猜测账号；报告安全错误并提示用户在 APP 确认登录状态。
- `ACCOUNT_CHANGED`：丢弃本次结果，重新查询账号并让用户确认是否继续。

账号型命令期间发生切号时，旧账号结果不能写入本地、不能归入新账号，也不能作为成功结果展示。
