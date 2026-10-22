---
name: SkillHub 正式版验收
description: 对一探 SkillHub 的真实导入、Agent 投影、环境变量和 Profile 读取进行可重复验收。
category: 开发与工程
version: 1.0.0
labels: [验收, Mac, SkillHub]
---

# SkillHub 正式版验收

用于发布前验证 SkillHub 不是 Demo：导入后必须生成本地 Git 历史与 `.skillhub.json`，能安装到 Claude Code 和 Codex，并能检测、保存所需环境变量。

## 运行要求

先通过 SkillHub 为本 Skill 保存 `SKILLHUB_QA_TOKEN`，并同时安装到 Claude Code 与 Codex。随后从 SkillHub 启动带环境变量注入的 Agent，执行 `node scripts/verify.mjs`。

脚本读取 `process.env.SKILLHUB_QA_TOKEN`，但输出中只包含通过/失败状态与检查项名称，绝不输出凭据值。任一验收项不满足都会立即返回非零退出码，不能以“已配置”代替真实验证。

## 验收项

1. SkillHub 管理目录中的 `.skillhub.json` 是有效 Profile sidecar，包含标题、描述、分类、标签和 `SKILLHUB_QA_TOKEN` 依赖声明。
2. 管理目录是具有可读取 `HEAD` 的本地 Git 仓库。
3. SkillHub 会从版本化的原始目录生成只读运行投影；Claude Code 与 Codex 中的条目必须精确指向同一个 `current` 投影，不能绕过环境变量提示层。
4. `~/.skillhub/envs/<账号ID>` 权限严格为 `0700`，本 Skill 的环境文件是非符号链接普通文件且权限为 `0600`，不同账号互不复用。
5. 环境文件中存在 `SKILLHUB_QA_TOKEN` 键，且 Agent 进程确实收到该变量；脚本只判断存在性，不回显其值。

自动化测试可运行 `node --test scripts/verify.test.mjs`。测试通过 `SKILLHUB_QA_HOME` 构造隔离目录，不读取或修改真实用户凭据。
