# 支持、诊断与反馈

## 诊断

先记录用户看到的具体现象，再使用以下只读命令获取脱敏状态：

```sh
skillhub doctor --json
skillhub status --json
skillhub auth status --refresh --json
skillhub agent list --json
skillhub sync status --json
```

只运行与问题有关的命令；不要自行扫描私有目录。

按层区分问题：

- CLI 不可用或命令缺失：请用户在已安装 APP 中检查更新或修复命令行组件。
- `OFFLINE`：Server 不可达，保留账号会话；不要改写为登录失败。
- 鉴权/切号错误：按 [auth-and-account.md](auth-and-account.md) 处理。
- 同名或投影冲突：按 [installation-conflicts.md](installation-conflicts.md) 处理。
- 云端条目尚未下载：本地列表与 APP 账号清单可能暂时不同，先看同步状态和 APP 下载提示；不自行重建同名 Skill。状态来自本机记录，不代表当前网络或 Server 已确认。
- 同步返回问题项：逐项说明已完成、仍失败及待确认的范围。需要手动同步 / 重试时按 [local-skills.md](local-skills.md) 的写入边界执行；遇账号变化先重新验证，正在同步时不要绕锁。
- `env status` 返回 `VALIDATION_FAILED` / `NOT_FOUND`，或 `data.complete` 为 `false`：这是本地 Skill 记录的读取/身份校验失败，不是钥匙缺失。核对 `--skill-id` 是否取自 `skill list` 的 `id`，把 `error.message` 或 `data.skipped` 的脱敏原因转述给用户，由用户在 APP 中检查该 Skill；不要让用户重填 Key，也不要改读其他目录或凭据文件。按 [credentials-runtime.md](credentials-runtime.md) 处理。
- 程序运行时报错缺少某把钥匙（环境变量）：按 [credentials-runtime.md](credentials-runtime.md) 的“运行时发现缺少钥匙”处理——未声明的变量用 `skillhub env request --skill-id "<local-skill-id>" --key "<KEY>" --json` 登记，告诉用户在 APP 中确认并填写，用户确认后再重试；已声明但缺失的变量直接请用户在 APP 中填写或选择来源。不要读取 `.env`、枚举环境或向用户索取值。
- `run` 报“有多个来源可选”：多个团队都提供了该变量，请用户在 APP 中选择用哪把钥匙；不要替用户选择。
- 包校验、权限或不安全会话错误：停止，不通过 Shell 权限或手动文件操作绕过。

诊断摘要可以包含版本、平台、稳定错误码和 Agent 检测状态；不得包含 Token、密码、钥匙值、团队钥匙或私有存储内容。

## 提交反馈

CLI 支持经确认的文字反馈：

```sh
skillhub feedback submit preflight --type "<bug|usage|feature|other>" --content "<text>" --json
skillhub feedback submit apply --type "<same-type>" --content "<same-text>" --operation-id "<uuid>" --plan-digest "<64-hex>" --json
skillhub feedback status --operation-id "<uuid>" --json
```

可选的 `--contact "<text>"` 和 `--include-diagnostics` 必须在 preflight/apply 保持完全一致。预检只返回字数、范围、`operationId` 和 `planDigest`，不回显正文或联系方式。向用户展示提交范围并取得明确确认后，再原样使用两个标识执行 apply。

提交响应中断或返回 `OPERATION_OUTCOME_UNKNOWN` 时，先使用同一 `operationId` 查询；不能换新 id 重投。CLI 不支持图片，需要粘贴/拖入附件时打开 APP 反馈窗口。不要直接调用 Server 或自行上传文件。
