# 钥匙（环境变量）与安全运行

SkillHub 把 Skill 运行时需要的机密环境变量（API Key、Token、凭据）叫作“钥匙”；`OUTPUT_DIR`、`FAL_MODEL` 这类配置不是钥匙，SkillHub 不管理它们，怎么传给程序由 Skill 作者决定。钥匙的变量名、缺失状态和授权状态可以展示；值本身不可以进入 Agent 上下文、聊天、日志、Skill 文件、版本包或通用 CLI JSON。

## 状态

```sh
skillhub env status --json
skillhub env status --skill-id "<local-skill-id>" --json
```

通过它查询每把钥匙的变量名、是否必需、是否缺失及来源状态。填写个人值、选择团队来源、编辑值或授权撤销，都必须在 APP 中完成；CLI 没有任何钥匙值写入或授权命令。唯一的写入是下文的 `env request`，它只登记变量名。

## 解析顺序

`skillhub run` 与 APP 的“需要的钥匙”状态使用同一固定顺序：

1. 用户在 APP 中显式选择的来源（个人或某个团队）优先；显式选择的团队来源失效时直接报错，不会静默改用个人值。
2. 未显式选择时，有个人值就用个人值：先看该 Skill 自己保存的值（`source` 为 `override`），再看用户账号级钥匙库里的同名钥匙（`source` 为 `vault`；在任一 Skill 填过一次，所有声明了同名变量的 Skill 都能用）。一把钥匙可以有多个变量名（别名，如 `FAL_KEY` / `FAL_API_KEY`）：Skill 声明的是别名时仍以它声明的名字注入，`env status` 行的 `viaKey` 给出钥匙库里的主名。同一个变量名可以存多把钥匙：第一把是默认（不带标签），其余每把都带标签（如「公司」），Skill 未指定时用默认那把，用户在 APP 中为某个 Skill 选了带标签的那把时就用它（仍以 Skill 声明的名字注入）。由带标签的那把提供时，`env status` 行会多出 `variant`（如 `V1`）与 `label`（如 `公司`）两个字段；授权与停用按每一把分别记录，`NEEDS_CONSENT` 报错里会写成 `FAL_KEY · 公司`。
3. 没有个人值、且恰好一个团队为该变量提供了可用值时，自动采用该团队值（`env status` 中 `selection` 为 `automatic_team`）。
4. 多个团队都提供了可用值时，需要用户在 APP 中选择一次（`authorization` 为 `needs_choice`；`run` 以 `NEEDS_CHOICE:` 开头报“有多个来源可选”）。
5. 都没有时，需要用户在 APP 中填写（必需变量缺失时 `run` 以 `MISSING_KEY:` 开头失败并给出变量名；可选变量不注入）。

每次 `skillhub run` 的结果（只含变量名、原因代码与退出码，不含值）会记在本机，APP 据此在 Skill 列表显示「上次运行失败」；`env status` 中每个 Skill 的 `lastRun` 是同一条记录（没有记录时为 `null`）。

不要替用户选择来源，也不要据此向用户索取值。

### 向用户解释时的说法

APP 里统一叫“钥匙”，Skill 详情中的区块叫“需要的钥匙”。向用户转述 `env status` 时使用与 APP 一致的词，不要说“来源”“用户自建”“个人值”：

| `env status` 字段 | 对用户说 |
| --- | --- |
| 变量可用，`source` 为 `vault` 或 `override` | 可用，正在使用：你的钥匙 |
| 变量可用，`source` 为 `team`（含 `selection: automatic_team`） | 可用，正在使用：XX 团队的钥匙 |
| `authorization` 为 `needs_choice` | 需要选择用哪把钥匙 |
| 必需变量缺失（N 个） | 需要填写 N 把钥匙 |
| `authorization` 为 `needs_consent` | 等待授权 |

请用户到 SkillHub APP 中该 Skill 的“需要的钥匙”里点“填写”或“选择”；要把钥匙共享给团队，到 APP 的“钥匙”页操作。

### 首次使用确认（NEEDS_CONSENT）

商店或团队来源的 Skill 第一次使用用户钥匙库里的某把钥匙时，需要用户在 APP 中确认；用户自己的 Skill 不需要。此时 `env status` 中该变量的 `authorization` 为 `needs_consent`（该 Skill 的 `needsConsent` 列出变量名、`ready` 为 `false`），`skillhub run` 以 `NEEDS_CONSENT:` 开头的错误失败并列出变量名。APP 会弹出授权窗，请用户确认后重试。CLI 没有任何授权命令，不要尝试绕过，也不要因此向用户索取值；用户拒绝后不要反复重试。

`<local-skill-id>` 必须原样取自 `skillhub skill list --json` 或 `skill show` 返回的 `id`（受管目录名）。不要用 Skill 的显示名、投影名、Server 资产编号或 `.skillhub.json` 里的 UUID 代替；这三类编号分别属于不同身份域，可以合法地互不相同。

### 怎样理解结果

- `env status` 是元数据状态：它只说明本机记录了哪些变量名、哪些有个人值或团队来源、团队授权是否仍有效。它不是供应商连通性探测，也不证明某次业务请求会成功；业务是否成功只能按目标程序自己的输出判断。
- `ok: true` 时以 `data.complete` 为准：`false` 表示有本地记录无法安全读取而被省略，`data.skipped` 给出被省略的目录名与脱敏原因，`skillCount` 不是完整清单。此时不要把被省略的 Skill 判定为“未配置”，请用户在 APP 中检查它们。
- `ok: false` 且 `error.code` 为 `VALIDATION_FAILED` / `NOT_FOUND`，是查询失败，不是凭据丢失。`NOT_FOUND` 同时覆盖“受管目录不存在”与“目录存在但缺少 `.skillhub.json`”两种情况；`VALIDATION_FAILED` 常见原因是 Skill 目录或 Profile 不是安全的普通文件、Profile JSON 损坏、Profile 身份无效。应报告“状态查询失败”并给出 `error.message` 的脱敏原因；禁止据此推断 Key 缺失、让用户重新输入 Key，或改读其他目录、私有存储和凭据文件。
- `env status` 与 `skillhub run` 各自独立校验：仅凭状态查询错误不能断言 `run` 会失败，也不能据此推断凭据丢失；反之，坏 Profile、账号撤权等共同故障会让两者都失败。运行是否成功只以目标程序自己的输出判断。

## 运行时发现缺少钥匙

如果用户要求运行的程序因缺少某把钥匙（环境变量）而失败（例如报错指明缺少 `FAL_KEY`），而该变量尚未出现在 `env status` 的清单中，按下列协议处理。只登记像钥匙的名字（API Key、Token、凭据）；`OUTPUT_DIR` 这类配置项不要登记，请提示用户按 Skill 作者的说明设置：

1. 登记需求（只写变量名，不读、不写任何值；未登录或游客身份也可用；重复登记是幂等的）：

   ```sh
   skillhub env request --skill-id "<local-skill-id>" --key "<KEY>" [--reason "<简短说明>"] --json
   ```

   `--key` 必须是 `^[A-Z][A-Z0-9_]{0,99}$` 形式的变量名；`--reason` 可选，单行、不超过 200 字，且不得包含任何值或形如 `KEY=<token>`、`token: <token>` 的内容（会被拒绝）。成功时 `data.alreadyDeclared` 表示该变量是否早已声明。
2. 告诉用户：请在 SkillHub APP 中确认该 Skill 需要这个变量并填写或选择来源。
3. 用户确认已在 APP 中完成后，再用同一运行入口重试一次。

整个过程中：不读取 `.env` 或其他文件中的值，不执行 `env`、`printenv` 或任何环境枚举，不向用户索取值，也不把值写进命令、`--reason`、聊天或 Skill 文件。变量已在清单中但仍缺失时，不需要 `env request`，直接请用户在 APP 中填写或选择来源。

## 已支持的运行协议

当需要带着某个 Skill 的钥匙启动用户明确要求的进程时，把目标可执行程序和参数直接放在 `--` 后：

```sh
skillhub run <skill-id> -- <program> [args...]
```

SkillHub 会在账号最终复核后直接启动该子进程，只把已授权值注入子进程环境；CLI 不输出 Shell `export`，也不把值留在当前 Shell。因此直接运行脚本（不经 `skillhub run`）时当前 Shell 看不到这些变量，这是合同的正常结果，不是凭据丢失；正确做法是把用户明确要求运行的实际程序放到 `--` 后，而不是补读旧开发目录、`.env` 文件、私有存储或重新索取 Key。目标程序的正常 stdout/stderr 仍会直接返回，因此只能执行用户明确要求且属于该 Skill 的实际程序；不得执行 `env`、`printenv`、Shell/解释器包装的环境枚举或其他读取全部环境的命令。命令失败、退出非零或账号变化时停止，不得改用已废弃的环境导出模式。

所有受 SkillHub 管理的 Skill（无论是否声明了钥匙）在 Agent 投影中都带有运行入口说明；没有声明依赖的 Skill 通过该入口运行时不会注入任何值。Agent 投影会按平台给出固定入口：macOS 使用 SkillHub 私有 runtime launcher，Windows 使用会等待后台 CLI 进程并透传输出和退出码的 `%USERPROFILE%\.skillhub\runtime\bin\skillhub.cmd`。应直接采用投影生成的对应命令，不要自行猜测安装路径、绕过 Windows wrapper，或改用 PATH 中的同名程序。

团队钥匙必须由 Runtime 在当次运行中校验当前账号、团队成员资格和授权。它不属于个人 Skill，不能在编辑、Fork、打包、快照、分享或发布时复制。
