# CLI 契约与安全边界

## 能力发现

- `skillhub --help` 和各命令族 `--help` 是本机已安装版本的能力事实源。
- 文档提到但 help 未列出的命令视为尚未开放；回到 APP，不拼接私有命令。
- 控制面命令默认输出 JSON 信封，`--json` 可省略；显式传入仍兼容。`server show` 与 `server use` 也使用同一信封；`--help` 和 `--version` 保持纯文本。用法错误的 `nextActions` 提供对应的 `--help` 命令。
- `run ... -- <program> [args...]` 由 Rust 直接启动目标进程并传播其退出码，不返回控制面 JSON，也不输出钥匙值。
- `env status` 与 `env request` 只处理钥匙的变量名和状态元数据；`env request` 只把变量名登记为待确认需求，没有任何读取、写入、解析或授权值的 CLI 命令。

## JSON

使用稳定字段判断结果：`schemaVersion`、`ok`、`command`、`account`、`data`、`warnings`、`nextActions` 和失败时的 `error.code`。不要解析中文/英文消息文本来决定下一步。

常见错误处理：

- `AUTH_REQUIRED`、`AUTH_EXPIRED`：停止账号型操作并按账号文档处理。
- `SPACE_UNSUPPORTED`：当前是仅本机空间，不支持该账号功能；引导用户到 APP 设置 → 服务与账号连接一探官方或自部署服务器，不作为故障重试或上报。
- `AUTH_SYNC_PENDING`：等待 APP 完成账号同步，再重新查询。
- `ACCOUNT_CHANGED`、`AUTH_IDENTITY_MISMATCH`：丢弃结果，重新验证，不能换用旧账号资料。
- `OFFLINE`：可继续不依赖 Server 的纯本地查询；不自动清会话。
- `CONFLICT`：保留双方内容，向用户展示冲突，不能静默覆盖。
- `PLAN_STALE`：状态已变化，重新查询和预检，不能继续使用旧 `planDigest`。
- `VALIDATION_FAILED`、`NOT_FOUND`：检查参数或当前对象；不得根据消息文本猜测另一个目标。对状态类查询（如 `env status`）这表示查询本身失败，不能把它解释成“资源缺失”或“钥匙缺失”。
- 成功响应中若 `data.complete` 为 `false`，说明只读清单有被省略的记录，`data.skipped` 列出目录名与脱敏原因；不要把部分清单当作完整结果。
- `PERMISSION_DENIED`、`AUTH_SESSION_UNSAFE`：说明限制，不尝试提升权限或猜路径。
- `OPERATION_OUTCOME_UNKNOWN`：先用对应只读命令或 APP 复核真实状态；不自动重试写入。
- `INTERNAL_ERROR`：停止并报告脱敏错误；不要绕过 CLI。

退出码：`0` 成功，`1` 内部错误或结果未知，`2` 用法/校验或空间不支持，`3` 鉴权，`4` 冲突或计划失效，`5` 离线。始终同时检查 JSON 的 `ok` 和 `error.code`。

## 本地身份

`skill list` / `skill show` 返回的 `id` 是受管目录名，也是所有 `--skill-id` / `--local-skill-id` 参数唯一接受的值。对单个本地 Skill 的查询，`NOT_FOUND` 表示该目录不存在或目录存在但缺少 `.skillhub.json`。`.skillhub.json` 内的 `id` 是稳定本地身份（通常是 UUID），`serverId` 是云端资产编号，`name` 是 Agent 投影名；它们可以合法地互不相同，不能互相替代，也不能用来推断账号或团队授权。

## 永久禁止

- 除 Agent 投影中由 SkillHub 自动生成并固定的受控 Runtime 启动行外，不拼接或调用私有可执行路径、私有 Runtime 文件或未公开 Server API。
- 不向命令传 `--token`、`--user-id` 或用户密码。
- 不输出、保存、总结或推断 JWT、钥匙值和团队钥匙。
- 不以直接文件操作绕过 SkillHub 托管、投影、版本、包校验或回收站。
- 不把成功退出码等同于业务已生效；状态变更后用只读命令复核。
- 不修改、Fork、分享、停用或删除 `yitan-skillhub-manager`。
