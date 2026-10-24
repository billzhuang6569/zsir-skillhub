# 版本与更新

区分以下版本，不能把它们合并为一个模糊的“SkillHub 版本”：APP、CLI、Manager Skill、CLI JSON 协议、Server 能力和当前平台最新 APP。

Manager 版本是随 APP 分发的系统组件标识，不是用户 Skill 的历史版本链；完整性修复由 APP 执行。不要因为组件版本带前缀就改用户投影或自行重编号。

## 查询

- CLI 自身版本始终可用：`skillhub --version`。
- 使用 `skillhub status --json` 查询 APP/CLI 版本、CLI 协议、平台/架构和 Manager Skill 完整性。该命令不验证 Server 账号。
- 使用 `skillhub update check --json` 查询当前平台是否存在 APP 更新。

如果本机旧版本没有对应命令，只能在已安装 APP 的更新界面检查；不要直接拼接更新 API 或下载地址。

## 更新边界

团队 Skill 的版本由作者逐团队推送，作者保存正式版本不会自动改变团队。`skillhub team updates` 与 GUI 按团队版本 ID 和本机 `sourceVersionId` 判断；旧 Server 没有版本 ID 时回退到已获取版本号。团队共享、「我的 Skills」卡片右侧和详情名称旁的循环箭头是成员更新入口。本机有修改时默认另存「〈名称〉（我的修改）」再更新；复制继承头像和 AI 资料，已安装的 Agent 自动刷新。取消共享后显示「团队已停止共享 · 本机副本保留」，停止提示更新，团队钥匙不可用。

- CLI 和 Manager Skill 与 APP 同包发布，没有独立 CLI 更新通道。
- `update check` 只返回是否可用、当前版本，以及有更新时的最新版本、说明和发布时间；它不返回下载 URL 或签名。
- 检查更新是只读操作；CLI 本版不执行下载安装或重启，必须交给 APP 并由用户确认。
- Server 不可达时报告离线，不把“无法检查”解释为“已经是最新版”。
- 更新后重新运行版本/账号查询，确认 APP、CLI、Manager Skill 和协议组合相容。
