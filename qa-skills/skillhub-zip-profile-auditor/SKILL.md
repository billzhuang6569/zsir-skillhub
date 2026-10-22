---
name: SkillHub Profile 审计
description: 检查 SkillHub Profile 是否完整保留 Skill 的名称、用途、分类、标签与版本信息。
category: 自动化与集成
version: 1.0.0
labels: [Profile, ZIP, 审计]
---

# SkillHub Profile 审计

用于验证 ZIP 导入路径和 AI Profile 生成链路。导入后，应能在 SkillHub 卡片和详情面板中读取生成后的 Profile，并保留原始 `SKILL.md`。

## 审计输出

- Profile 已生成并包含服务端 ID。
- 本地 Git 至少有一条初始导入记录。
- 原始 Skill 内容未被 sidecar 元数据覆盖。
