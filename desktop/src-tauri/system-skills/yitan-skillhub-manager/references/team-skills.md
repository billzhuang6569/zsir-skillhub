# 团队 Skill

成员修改团队 Skill 后，刷新、`finish-edit` 与保存均保留团队来源，APP 显示「团队共享后修改」。详情提供「看看我改了什么」（与取得时内容比较）、「放弃我的修改」（先保存历史再恢复取得时内容）和「另存为我自己的 Skill」（新副本保留历史，原 Skill 不变）。商店来源对应「商店获取后修改」。CLI 暂不提供独立的放弃或另存命令，请引导用户在 APP 操作；团队更新时可用下文的修改保留选项。

团队版本由作者在「共享」区显式「推送更新」；保存正式版本不会自动推送。每个团队独立推进，首次共享采用当时最新正式版本。成员在团队共享、「我的 Skills」卡片右侧或详情名称旁点击循环箭头「更新到团队最新版本」。

本机有修改时，默认「保留我的修改，再更新」：复用另存逻辑生成「〈名称〉（我的修改）」，继承原头像与 AI 资料，不重复生成；原 Skill 更新后继续接收团队更新。「直接覆盖」也先保存历史，替换保留可恢复备份，已安装的 Agent 自动刷新。取消共享后显示「团队已停止共享 · 本机副本保留」，本机内容仍可用，团队钥匙不可用。

`skillhub team updates` 与 GUI 使用相同用例和团队版本 ID 判据；`local_modified` 表示团队有新版且本机有修改。CLI 的 JSON 信封默认输出，`--json` 可省略。更新预检和执行使用同一个 `--team-id`；本机修改时先征求用户选择，再在预检与执行都带 `--preserve-local`（默认建议）或 `--overwrite-local`。不带选择会阻止替换。未指定团队时，已获取的 Skill 使用其来源团队；新获取使用可访问团队 ID 排序后的第一个团队。

所有团队操作先执行：

```sh
skillhub auth status --refresh --json
```

账号未通过 Server 验证时停止。团队身份、成员资格、Skill 归属和权限只信任 CLI/Server 返回值，不能使用上次会话中的团队信息。

当前 CLI 提供团队浏览、安装、更新查询和团队分享管理：

```sh
skillhub team list --json
skillhub team skills "<team-uuid>" --json
skillhub team show "<server-skill-uuid>" --json
skillhub team updates --json
skillhub team install "<server-skill-uuid>" --preflight --json
skillhub team install "<server-skill-uuid>" --apply --plan-digest "<64-hex>" --json
skillhub team share preflight --local-skill-id "<local-skill-id>" --team-id "<team-uuid>" --json
skillhub team share apply --local-skill-id "<local-skill-id>" --team-id "<team-uuid>" --plan-digest "<64-hex>" --json
skillhub team share status --local-skill-id "<local-skill-id>" --team-id "<team-uuid>" --json
skillhub team unshare preflight --local-skill-id "<local-skill-id>" --team-id "<team-uuid>" --json
skillhub team unshare apply --local-skill-id "<local-skill-id>" --team-id "<team-uuid>" --plan-digest "<64-hex>" --json
```

## 浏览与安装

- 先确认团队和目标 Skill，名称相同时用稳定 id 区分。
- 安装前展示版本、来源和本地冲突；团队安装把安全校验后的包导入 SkillHub，本版不在同一步选择 Agent 投影。同名处理见 [installation-conflicts.md](installation-conflicts.md)。
- `team updates` 只检查由当前 APP 账号获取的团队版本。账号不匹配或共享已撤销时停止；本机有修改时必须明确选择处理方式。离线不能当作无更新，也不能据旧缓存覆盖本机内容。
- 展示 preflight 后取得明确确认，再把其 `planDigest` 原样用于 apply。
- 请求期间若账号变化，丢弃下载和结果，重新验证账号。

## 分享与取消分享

只有当前账号拥有的非系统 `local` Skill 可以分享；不能转分享团队/Marketplace 来源或 Manager Skill。先运行 share preflight：

- `serverPreparation: import` 表示 apply 会先为当前账号建立 Server 资产。
- `upload_version` 表示 apply 会先上传当前本地固定版本。
- `blocked_version_conflict` 或 `canApply: false` 时停止；同版本不同包必须先生成新本地版本，不能覆盖 Server 历史。
- 需要导入/上传时，本地 Git 工作副本必须已快照且无未保存修改。

向用户展示 Server 准备动作、版本和目标团队；当前 share preflight 公开返回 `packageSha256` 时可展示该固定包校验值，但其他安装预检没有公开的指纹不得自行扫描补齐。取得明确确认后才 apply。`team share status` 查询的是 Server 持久化的真实分享状态，不是虚构的后台队列进度。若 apply 返回 `OPERATION_OUTCOME_UNKNOWN`，先用同一 Skill/团队运行 status，确认前不重复写入。取消分享也要先预检、确认、apply，再用 status 复核 `shared: false`。

公开 CLI 分享命令一次只处理一个 Skill，没有 batch 参数。用户要求处理多项时，逐项预检，以稳定 ID 汇总可执行范围和失败原因，经授权后逐项使用各自的 planDigest；状态变化则重新预检，切号停止后续操作。分别报告成功、失败和结果待确认，不把部分成功报成整批成功。

分享不会转移作者所有权，也不能把个人/团队凭据装入共享包。
