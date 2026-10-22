---
title: 导入已有 Skill
description: 将文件夹、ZIP 或 Agent 目录里的 Skill 纳入托管。
sidebar: { order: 5 }
---

1. 准备包含 `SKILL.md` 的文件夹或 ZIP，检查内容不含真实密钥。
2. 在「我的 Skills」点击「导入 Skill」，选择文件。
3. 阅读名称、描述与冲突预检。Agent 目录有同名内容时，不要在未核对前覆盖。
4. 确认导入，在详情中检查文件和版本，再选择安装到 Agent。

发现 Agent 目录中未托管内容，可运行 `skillhub skill discover --json`，确认后再导入。Agent 被标记为目录未确认时，先修正覆盖配置，不能向猜测的默认目录写入。

没有 AI 服务不影响文件导入，自部署会保留显式元数据并标记未分析。导入与账号同步、商店发布不是同一个步骤。

已托管 Skill 的更新使用编辑和保存版本，不重复导入同一目录。需要 CLI 时见 [命令参考](../reference/cli-commands.md)。
