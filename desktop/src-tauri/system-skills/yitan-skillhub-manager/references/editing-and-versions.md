# 编辑与版本

修改由 SkillHub 管理的 Skill 时，必须使用安全编辑会话；不得直接编辑 Agent 投影。

已关联账号的 Skill 需要保持原账号登录，才能完成编辑、保存或恢复；登出或切换账号后先恢复正确会话，不要更改所有权字段绕过检查。未关联账号的本机 Skill 仍按本机流程操作。

## 已支持的编辑协议

当用户提供可靠的 `SKILL.md` 路径：

```sh
skillhub skill prepare-edit --skill-path "<目标 SKILL.md 绝对路径>" --json
```

只有 Skill id 时：

```sh
skillhub skill prepare-edit --skill-id "<skill-id>" --json
```

然后：

1. 只修改响应中的 `workingCopyPath`。公开响应不会提供 Agent 投影路径；不要自行寻找或修改投影。
2. 完成用户要求的修改和相关验证。
3. 仅当响应中的 `finishCommand` 以公开 `skillhub skill finish-edit` 开头时执行它；否则停止并提示用户更新或修复 SkillHub。
4. 也可以使用响应中的 `sessionId` 调用：

   ```sh
   skillhub skill finish-edit "<session-id>" --json
   ```

5. 根据完成结果报告是否变化、来源是否保留、版本号及确认状态。`finish-edit --json` 保留 `promotedToPersonal: false`，并返回 `sourceKept: true`。本机保存成功不代表账号同步或团队发布成功。

如果目标来自团队或 Marketplace，修改后仍保留来源与更新通道，APP 显示「团队共享后修改」或「商店获取后修改」。只有用户在 APP 显式选择「另存为我自己的 Skill」才创建独立个人副本，原 Skill 保持不变。若误改投影，重新 `prepare-edit` 让 SkillHub reconciliation，不要自行复制。

已加入当前账号库的托管源在本机编辑后可能自动同步到其他设备；`finish-edit` 的本机成功不等于已发布正式 Server 版本或团队已共享。需要确认传播时查询 `skillhub sync status --json` 并在 APP 核对，不能从本机版本号猜测云端结果。

## 历史、差异与恢复

```sh
skillhub skill history --skill-id "<local-skill-id>" --json
skillhub skill diff --skill-id "<local-skill-id>" --working --json
skillhub skill diff --skill-id "<local-skill-id>" --from "<40-hex-commit>" --to "<40-hex-commit>" --json
skillhub skill snapshot --skill-id "<local-skill-id>" --message "<版本说明>" --json
skillhub skill snapshot --skill-id "<local-skill-id>" --message "<版本说明>" --version "0.1.1" --json
skillhub skill restore-version preflight --skill-id "<local-skill-id>" --hash "<40-hex-commit>" --json
skillhub skill restore-version apply --skill-id "<local-skill-id>" --hash "<40-hex-commit>" --plan-digest "<64-hex>" --json
```

`history` 和 `diff` 只读。`snapshot` 只在用户明确要求保存当前内容时执行；已有相同内容的本机编号可以只补充保存意图，不创建重复 Git 提交。执行后再查询历史复核。

版本号只接受三段单个数字（`0.0.0` 至 `9.9.9`），不能包含 `v`、字母、后缀或多位数字。自动分配默认从 `0.1.0` 开始，按全部历史编号上界递增：`0.1.9` → `0.2.0`、`0.9.9` → `1.0.0`；新分配的手动 `--version` 必须高于已用编号且不得占用保留编号。`9.9.9` 后停止创建新编号，不能循环、覆盖历史或自行放宽格式。已编号的相同内容重复保存不应创建新编号。

APP 在导入、下载落地和维护已有条目时，为安全的已保存内容补齐本机编号；同步操作与已有历史内容相同时复用该内容的本机编号，否则初始化本机记录。此过程不改历史 Git 对象，不自动保存工作区修改，也不创建正式版本或云端保存回执。列表中的编号表示已保存版本；有未保存修改时另显示「已修改」。不要手工批改 sidecar 代替 APP 维护。

`versionStatus: pending` 表示当前本机保存待账号确认；`local` 表示只有本机记录（包括自动初始化的编号和离线旧快照），不会仅因存在本机编号就自动提交保存意图。历史 `unversioned` 记录可能只是同步或恢复操作；当前 Skill 若缺少可核验编号，应结合 `versionProblem` 核对故障，不能宣称正常完成。同步回执、正式版本 ID 和 Git commit 是不同身份，不能根据同名版本号或相同内容推断正式身份。修改团队或 Marketplace 来源后，本人编号与上游正式编号可以不同，保留上游信息，不改上游记录。响应不确定时先查询状态；不得靠相同版本标签或包哈希宣称正式发布成功。

若当前未确认的保存被 `VERSION_LABEL_CONFLICT` 拒绝，可以对同一内容再次 `snapshot`，改用自动编号或更高的手填号；新意图会重新参与同步，不改写旧 Git 内容或降低编号上界。已确认版本不能通过此入口改号。

新版 Server 会拒绝带 `v` 或 `personal` 后缀的新版本写入；提示升级 APP，不要让用户手改 Profile、数据库或 Git 历史绕过校验。旧 Server 尚不支持版本回执时，以实际返回能力为准，本机记录不能标记为云端已确认。

`restore-version` 会从已有 Git 历史恢复指定快照，但不改写、删除或重排旧历史，也不降低版本编号上界。预检若报告当前工作副本有未保存修改，`canApply` 必须为 false；先让用户选择快照或安全编辑，不能用 Git 命令丢弃修改。恢复后重新查询 `history` 与 `diff`，按实际回执报告当前版本，不给恢复内容冒用下一版本号。系统 Manager 本身不能进入编辑、快照或恢复流程。

同一个 Git hash 可能对应多个正式版本回执。此时从 `history` 选择准确的 `receiptId`，在 `restore-version preflight` 和 `restore-version apply` 两次调用中均添加 `--receipt-id "<receipt-id>"`，并使用该预检返回的 `planDigest`。缺少身份时的歧义错误不能靠版本标签或内容哈希猜测解决。

## 声明需要的钥匙（环境变量）

帮用户编写或修改 Skill 时，如果程序需要 API Key、Token 等钥匙，在 `SKILL.md` frontmatter 的 `metadata.skillhub.env` 中声明变量名，让 SkillHub、其他 Agent 和使用者都能读到。只声明钥匙；`OUTPUT_DIR` 之类的配置不要写进去，SkillHub 不管理配置，自动检测也只收录名字像钥匙的变量：

```yaml
---
name: zsir-imagegen
description: ...
metadata:
  skillhub:
    env:
      - key: FAL_KEY
        required: true
        description: fal.ai API Key
        obtain: https://fal.ai/dashboard/keys
---
```

- `key` 必填，只能用大写字母、数字和下划线，并以大写字母开头（最长 100 个字符）；最多声明 100 项，不能重复。
- `required` 默认 `true`；可选的变量写 `required: false`。
- `description` 最多 200 个字符、单行；`obtain` 只能是 `https://` 链接，仅作展示，不会被自动打开。
- 只写变量名和说明，**绝不写入值**；值由用户在 SkillHub APP 中填写。顶层 `env` 不会被识别；`metadata` 下的其它键保持原样，不要改动或删除。
- 声明无效时导入和发布都会明确报错，不会被静默忽略；按报错修正后再继续。
- 作者在 APP 发布或创建新版本前会看到「已声明 / 检测到但未声明 / 已声明但未检测到」的确认清单，勾选后 SkillHub 只改写这一块。代码读取了新变量时，在同一次安全编辑会话里同步补上声明。
