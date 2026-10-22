---
name: yitan-skillhub-manager
description: 管理一探 SkillHub 的账号状态、本地与团队 Skill、Marketplace、Agent 投影、版本、分析、更新检查、文字反馈和安全运行，并解答 SkillHub 的使用问题。用户要求查询、安装、导入、修改、恢复、分享、更新或排查 SkillHub 管理的 Skill 时使用；不用于未安装 SkillHub APP 的场景。
---

# SkillHub Manager

通过 SkillHub APP 随附的公开 CLI 完成 SkillHub 相关任务。APP 是唯一登录入口；CLI 自动继承 APP 当前账号，不提供第二套登录。

只调用当前用户命令搜索路径中的入口：

```sh
skillhub
```

不要拼接私有可执行路径，不读取 SkillHub 私有存储，不直接调用 Server，不接收或输出 Token。若 `skillhub` 不可用，本 Skill 的前提不成立；不要实现下载安装或 bootstrap 流程。

两类入口分工：**管理命令**（查询、导入、安装、分享、`env status` 等）一律使用上面公开 PATH 中的 `skillhub`。**运行用户授权的 Skill 程序**时，使用 SkillHub 在该 Skill 的 Agent 投影中自动生成并固定的 Runtime 启动行（macOS 的私有 runtime launcher、Windows 的 `%USERPROFILE%\.skillhub\runtime\bin\skillhub.cmd`，见 [references/credentials-runtime.md](references/credentials-runtime.md)）。这是唯一的受控例外：启动行由 SkillHub 写入并维护，不是自行猜测或拼接的私有路径；投影中没有该启动行时回到 APP，不要构造它。

## 开始任务

1. 根据用户意图只读取下方相关 reference。
2. 运行 `skillhub --help` 或对应命令族的 `--help`，确认本机版本实际开放的命令和参数；不得猜测未列出的接口。`skill`、`marketplace`、`team`、`env`、`app`、`update` 和 `sync` 均提供对应 `--help`。
3. 需要当前账号或任何团队、分析、分享能力时，先运行：

   ```sh
   skillhub auth status --refresh --json
   ```

4. 以 CLI JSON 的 `ok`、`data`、`warnings`、`nextActions` 和稳定错误码为准，不根据本地路径、旧结果或自然语言错误猜测状态。

若当前 APP 版本尚未开放完成某项任务所需的 CLI 命令，明确说明必须在已安装的 SkillHub APP 中完成；不要用 Shell、私有路径或直接 HTTP 绕过。

## 当前公开范围

- 只读：组件状态、诊断、账号验证、Agent 列表、本地 Skill 列表/详情/发现/历史/diff、钥匙（环境变量）缺失状态、Marketplace 和团队浏览与更新列表、团队分享状态、APP 更新检查和反馈状态。
- 本地写入：导入、投影安装/启用/停用/卸载、快照、恢复指定历史版本、移入回收站、从回收站恢复、安全编辑会话，以及用 `skillhub env request` 登记运行时发现缺少的钥匙名（只写变量名，不写值）。
- 账号型操作：分析本人 Skill、团队分享/取消分享会写入 Server；Marketplace/团队安装获取并校验当前固定版本包，然后写入本地。
- 账号同步：`sync status` 查询本机保存的同步状态；`sync` / `sync --retry` 会运行与 APP 相同的同步引擎，可能上传本机更改、下载账号内容或处理账号删除。已加入当前账号库的本地写入也可能随后自动同步到其他设备。
- APP 动作：打开或聚焦已安装的 SkillHub。
- 反馈：CLI 可经确认提交文字、联系方式和列明的脱敏诊断；图片附件仍必须回到 APP。
- 本版仍未开放 CLI：下载/安装 APP 更新、反馈图片、钥匙值或团队钥匙写入、来源选择与授权、指定非当前 Marketplace/团队历史包。

## 修改规则

- 查询、搜索、状态和诊断可以直接执行。
- 导入、投影安装/启停/卸载、删除、回收站恢复、历史版本恢复、Marketplace/团队安装、分析、团队分享/取消分享和反馈提交必须先获取 CLI 预检结果，向用户说明真实目标、影响范围、冲突与可恢复性。
- 取得用户对该计划的明确确认后，才可把 CLI 返回的 `planDigest` 原样交给对应 apply；`PLAN_STALE` 时重新预检，不能自动放宽范围。只有预检明确列出冲突且用户选择替换时才可使用 `--replace-conflicts`。
- `snapshot` 是追加式本地版本记录，仅在用户明确要求保存当前版本时执行；它没有 apply 或 `planDigest`。
- 命令结果不确定时停止并查询状态；不要自动重复外部写入。
- 手动同步没有 preflight / apply / planDigest；先说明当前账号及上传、下载、删除同步的影响，在用户已授权此范围后执行。只读状态查询不代表 Server 实时确认，重试前先检查同步报告。
- 不显示、转述、保存或推断钥匙值、团队钥匙、Token 和私有会话内容。

## 按任务读取

- 登录继承、当前账号、过期或切号：读 [references/auth-and-account.md](references/auth-and-account.md)。
- APP/CLI/Manager 版本和更新检查：读 [references/status-and-updates.md](references/status-and-updates.md)。
- 打开或聚焦 APP：读 [references/app-control.md](references/app-control.md)。
- 本地发现、导入、投影安装、删除与回收站：读 [references/local-skills.md](references/local-skills.md)。
- 账号库、自动同步、云端条目尚未下载或重试同步：读 [references/local-skills.md](references/local-skills.md) 和 [references/support-troubleshooting.md](references/support-troubleshooting.md)。
- 同名、来源或版本冲突：同时读 [references/installation-conflicts.md](references/installation-conflicts.md)。
- 修改、diff、快照和历史恢复：读 [references/editing-and-versions.md](references/editing-and-versions.md)。
- Marketplace 搜索、安装与更新：读 [references/marketplace.md](references/marketplace.md)。
- 团队查询、安装、更新、分享与取消分享：读 [references/team-skills.md](references/team-skills.md)。
- 分析 Skill 或处理旧 Profile：读 [references/analysis.md](references/analysis.md)。
- 钥匙状态、团队授权、安全运行，或程序因缺少某把钥匙（环境变量）失败：读 [references/credentials-runtime.md](references/credentials-runtime.md)。
- CLI 或 Agent 投影故障（检测不到、投影缺失或占用、安装后不可用、运行环境异常）：同时读 [references/support-troubleshooting.md](references/support-troubleshooting.md)、[references/local-skills.md](references/local-skills.md) 和 [references/credentials-runtime.md](references/credentials-runtime.md)。
- 健康检查、故障诊断或提交反馈：读 [references/support-troubleshooting.md](references/support-troubleshooting.md)。
- 解释 JSON、错误码或安全边界：读 [references/cli-contract-security.md](references/cli-contract-security.md)。

本 Skill 是只读系统组件。不要修改、Fork、分享、停用或删除它。
