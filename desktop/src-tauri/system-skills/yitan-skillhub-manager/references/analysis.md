# Skill 分析

分析属于当前 APP 账号的 Server 操作。开始前用 `skillhub auth status --refresh --json` 验证账号。当前命令是：

```sh
skillhub skill analyze "<local-skill-id>" --preflight --json
skillhub skill analyze "<local-skill-id>" --apply --plan-digest "<64-hex>" --json
```

## 流程

1. 查询目标 Skill、内容版本和当前 Profile；只有当前账号拥有且已对应 Server 记录的普通 Skill 可以分析。
2. 运行 preflight，核对账号、目标、Profile 和内容摘要。不得包含钥匙值、Token、团队钥匙或不属于目标 Skill 的文件。
3. 向用户展示范围并取得明确确认，再把 `planDigest` 原样用于 apply。
4. 请求期间账号或内容变化时丢弃结果；`ACCOUNT_CHANGED` 或 `PLAN_STALE` 后重新验证并预检。
5. 本版分析是同步请求，没有分析任务状态查询命令。连接中断或 `OPERATION_OUTCOME_UNKNOWN` 时在 APP/Skill 详情中复核，不能自动重复提交。

本次分析失败与“没有 Profile”是不同状态。失败时保留已有有效 Profile，明确告诉用户旧资料仍在；只有 Server 返回新的有效 Profile 才替换展示。重新分析仍需确认上传范围。
