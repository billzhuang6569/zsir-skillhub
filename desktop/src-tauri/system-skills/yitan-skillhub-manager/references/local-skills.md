# 本地 Skill 管理

Agent 目录中的 SkillHub 项是投影，SkillHub 托管源才是可编辑资产。不要直接复制、覆盖、移动或递归删除投影与托管目录。

## 查询与发现

```sh
skillhub skill list --json
skillhub skill list --query "<关键词>" --json
skillhub skill show --skill-id "<local-skill-id>" --json
skillhub skill discover --json
skillhub skill discover --agent "<agent-key>" --json
skillhub agent list --json
```

`discover` 只读取已经检测到的 Agent 目录；当前平台没有适配的 Agent 应从结果中省略，目录存在本身不能证明 Agent 已安装。

`skill list` 的每个 Skill 与 `skill show` 的 `skill` 都返回稳定 Agent key 组成的 `installedAgents`，以及当前平台已适配 Agent key 对应的 `agentStates`：

- `installed`：目标是指向该受管 Skill 的旧版精确链接，或通过 SkillHub marker 与内容摘要验证的当前投影。
- `notInstalled`：该 Agent 的精确投影位置不存在；可能是从未安装，也可能是停用或卸载后的结果，不得臆测历史原因。
- `conflict`：同名位置存在，但不能证明属于这个 Skill；不得当作已安装，也不得直接覆盖。
- `unknown`：无法安全检查状态；保留现场并先排查权限或路径异常。

这些字段只说明 Skill 的投影状态，不证明对应 Agent APP/CLI 已安装；Agent 检测仍以 `skillhub agent list --json` 为准。不要扫描或猜测其他目录来补状态。

本地 `skill list` 不是完整账号云端清单。APP 可能先显示账号条目，再在后台下载文件；本地还查不到某条目不等于账号数据丢失，应结合 APP 和下列同步状态核对。

## APP 云端列表的多选与筛选

「我的 Skills → SkillHub 云端」支持 Shift 连续选择、Windows Control / macOS Command 非连续选择；Mac Control-click 保留右键行为。右键选中集合可批量共享到团队或从账号删除，多选菜单不提供打开文件夹。单选右键同样可从账号删除。操作前核对选中数量与逐项预检，操作后读取成功、失败、跳过和待确认结果；待确认不代表失败，不要盲目重复共享或删除。切换筛选会清空列表选择，已开始的批次仍按冻结范围继续显示结果。

「所有Agent」下拉只列本机真实检测到的 Agent，以图标和名称显示。选择后按安装关联筛选，损坏安装仍保留便于修复，并与搜索、目录及「所有 / 团队共享」取交集。检测失败会保留本次会话最近成功结果，不能据此声称某 Agent 未安装。上述是 APP 操作，不代表 CLI 已新增多 Skill 批量参数。

## 账号同步

```sh
skillhub sync status --json
skillhub sync --json
skillhub sync --retry --json
```

`sync status` 只读取当前会话的本机同步记录，不执行上传、下载，也不替代 Server 账号验证。需要联网操作时先按账号文档验证当前账号。`sync` 与 APP 共用同步引擎；`--retry` 请求重试，不能理解为无条件覆盖冲突。它们没有 preflight / apply：先说明会同步当前账号的变更，取得已有或本次明确授权后执行，再查询状态并检查逐项问题，不把 `ok: true` 等同于所有条目完成。

登录后加入当前账号的 Skill，其编辑和导入可能继续同步到其他设备；游客、其他账号遗留或来源不明的本机文件不会仅因存在而自动加入当前账号，应通过 APP 明确加入。切号时停止原账号任务，重新查询状态，不复用旧条目关联。遇正在同步的冲突先等现有同步结束，不绕开锁或反复启动命令。

## 导入与安装到 Agent

```sh
skillhub skill import preflight --path "<目录或 zip>" --json
skillhub skill import preflight --path "<目录或 zip>" --skill-id "<local-skill-id>" --json
skillhub skill import apply --path "<同一路径>" --plan-digest "<64-hex>" --json

skillhub skill install preflight --skill-id "<local-skill-id>" --agent "<agent-key>" --json
skillhub skill install apply --skill-id "<local-skill-id>" --agent "<agent-key>" --plan-digest "<64-hex>" --json
```

多个 Agent 需要为每个目标重复 `--agent`。如果 preflight 报告真实冲突，先让用户选择；只有用户明确要求替换时，apply 才添加 `--replace-conflicts`。导入 apply 必须重复 preflight 使用的 `--skill-id`（若有）。

## 删除与回收站

```sh
skillhub skill delete preflight --skill-id "<local-skill-id>" --json
skillhub skill delete apply --skill-id "<local-skill-id>" --plan-digest "<64-hex>" --json
skillhub skill trash list --json
skillhub skill trash restore preflight --trash-id "<uuid>" --json
skillhub skill trash restore apply --trash-id "<uuid>" --plan-digest "<64-hex>" --json
```

CLI 删除只把托管 Skill、其受管投影和关联的本机钥匙覆盖文件移入本机回收站，不永久删除。已同步到当前登录账号的 Skill 不能只从这台电脑删除（下次同步会重新下载）：preflight 返回 `accountSynced: true`、`canApply: false` 时不要执行 apply，请用户在 SkillHub APP 使用账号删除入口。账号删除随后传播到其他设备，离线设备下次联网处理，可在设置中的账号回收站恢复；CLI `trash` 管理的是本机回收站，不能代替账号恢复。

账号删除只移除自己的账号副本，不删除作者资产、不自动取消团队共享或下架商店。账号已删除而本机待清理时，先查询状态，不能把它当作账号删除失败而盲目重试。恢复 preflight 会检查所有恢复目标；目标被占用时停止并处理 `CONFLICT`。公开 `trash-id` 是 CLI 返回的 UUID，不能自行从路径推导。部分旧收编备份只能在 APP 恢复。

## 取消 SkillHub 托管

在 APP 的「管理 Skill」中选择「取消 SkillHub 托管」（旧版菜单名为「交给工具自行管理…」）。对于当前账号同步的 Skill，所选 Agent 获得独立副本，SkillHub 原件仍在账号中并继续同步，不会因此新增账号条目；Agent 里的独立副本此后不跟随 SkillHub 更新。同一菜单中的「在所有 Agent 停用」只移除各 Agent 的受管投影，SkillHub 托管源、配置、版本与账号条目都保留。当前没有对应公开 CLI 操作，应转 APP，不自行复制目录或删除同步原件。

## 启用、停用与卸载投影

```sh
skillhub skill enable preflight --skill-id "<local-skill-id>" --agent "<agent-key>" --json
skillhub skill enable apply --skill-id "<local-skill-id>" --agent "<agent-key>" --plan-digest "<64-hex>" --json
skillhub skill disable preflight --skill-id "<local-skill-id>" --agent "<agent-key>" --json
skillhub skill disable apply --skill-id "<local-skill-id>" --agent "<agent-key>" --plan-digest "<64-hex>" --json
skillhub skill uninstall preflight --skill-id "<local-skill-id>" --json
skillhub skill uninstall apply --skill-id "<local-skill-id>" --plan-digest "<64-hex>" --json
```

`enable` 只针对一个 Agent；若预检明确列出冲突，只有用户确认覆盖后才能在 apply 加 `--replace-conflicts`。`disable` 只移除指定 Agent 的受管投影；`uninstall` 移除该 Skill 的所有受管投影，不删除 SkillHub 托管源。执行后用 `skill show` 复核目标 Agent：启用/安装应为 `installed`，停用应为 `notInstalled`，卸载后所有 Agent 都应为 `notInstalled`；再用 `agent list` 独立复核 Agent 检测状态。

## 变更流程

上述导入、安装、删除和恢复都以 CLI 返回的预检为准：

1. 查询目标与当前状态。
2. 获取预检计划，检查目标 Skill、Agent、来源、冲突、文件范围和可恢复性。
3. 向用户展示计划；覆盖、批量、删除、恢复或来源变化必须取得明确确认。
4. 只执行 CLI 返回的计划标识/摘要；若返回 `PLAN_STALE`，重新预检。
5. 执行后重新查询，而不是只相信进程退出。

删除普通 Skill 应进入回收站。系统 Manager 不能停用、卸载、删除、Fork 或导入为普通 Skill。

同名、上游和个人修改冲突的判断见 [installation-conflicts.md](installation-conflicts.md)。编辑内容见 [editing-and-versions.md](editing-and-versions.md)。
