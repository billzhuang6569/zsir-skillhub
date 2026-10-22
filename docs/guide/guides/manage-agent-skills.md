---
title: 多个 Agent 的 Skills 如何整理、查看版本和安装
description: 用一探 SkillHub 在 macOS / Windows 上统一管理 Claude Code、ChatGPT（Codex）、Gemini CLI 等多个 Agent 的 Skills：导入到一个托管位置、查看三段式版本与修改状态、一次安装到多个 Agent，并查看每个 Agent 的安装位置与状态。本机操作不需要登录。
sidebar: { order: 1 }
---

把每个 Skill 导入到 SkillHub 的托管位置，再用「安装到 Agent」在各工具目录放置由 SkillHub 维护的投影。版本由内置 Git 历史记录，列表显示三段式编号与「已修改」状态；导入、查看版本、安装到 Agent 都在本机完成，无需登录。

## 为什么使用托管位置

同一份 Skill 复制到多个 Agent 后，容易分不清哪份是新版本。SkillHub 保留一份可编辑的托管源，Agent 目录里的投影由它维护，版本与安装状态围绕托管源记录。不要直接修改投影，后续对齐可能覆盖这种手工修改。

## 前提

- 安装与你系统和芯片匹配的 [桌面版](../getting-started/install-app.md)。
- 已安装目标 Agent；目录存在不代表 Agent 已安装，未适配当前平台的 Agent 不显示。
- 本机操作无需登录，账号同步、团队共享与商店投稿需要账号。
- 可选使用随 APP 提供的 `skillhub` CLI，它继承 APP 当前空间与账号。

## 导入到一个托管位置

1. 「我的 Skills → 导入 Skill」，选择含 `SKILL.md` 的文件夹或 ZIP。
2. 阅读预检，核对名称、描述与目标位置。遇到同名且不归 SkillHub 管理的目录，不会默认覆盖，先决定取消、改名或接管。
3. 确认后进入托管目录，默认本机版本为 `0.1.0`。

```sh
skillhub skill discover --json
skillhub skill import preflight --path "/path/to/my-skill" --json
skillhub skill import apply --path "/path/to/my-skill" --plan-digest "<预检返回的planDigest>" --json
```

`discover` 只读列出尚未托管的 Skill；执行必须使用本次预检摘要。

## 查看版本和修改

编号只接受 `0.0.0`–`9.9.9` 三段单个数字，不带 `v` 或后缀。自动编号递增，例如 `0.1.9` 后为 `0.2.0`；相同内容不会重复编号。

```sh
skillhub skill history --skill-id "<local-skill-id>" --json
skillhub skill diff --skill-id "<local-skill-id>" --working --json
skillhub skill snapshot --skill-id "<local-skill-id>" --message "新增中英双语输出" --json
```

在 APP 编辑，或先 `prepare-edit`，仅修改返回的 `workingCopyPath`，完成后执行返回的 `finishCommand`。恢复历史版本不会删除历史；有未保存修改时先处理，不能静默丢弃。

## 安装到多个 Agent

详情中选择已检测到的 Agent 并安装；同一个 Skill 可以安装到多个工具。目标同名内容归属不明时先报冲突。

```sh
skillhub skill install preflight --skill-id "<local-skill-id>" --agent codex --agent claude --json
skillhub skill install apply --skill-id "<local-skill-id>" --agent codex --agent claude --plan-digest "<planDigest>" --json
skillhub skill show --skill-id "<local-skill-id>" --json
```

列表图标和「所有Agent」筛选可查看安装情况；Windows 路径显示为实际绝对路径。

| agentStates | 含义 |
| --- | --- |
| `installed` | 投影已验证属于这个 Skill |
| `notInstalled` | 精确投影位置不存在 |
| `conflict` | 同名位置存在，归属不能确认，不覆盖 |
| `unknown` | 权限或路径异常，不能安全检查 |

停用只移除某个 Agent 的投影；卸载移除全部投影，两者都保留托管源。删除另走回收站或账号删除流程。

## 历史演示与边界

原指南记录过 macOS Apple Silicon、v0.28.1、未登录的 CLI 演示：导入演示 Skill 得到 `0.1.0`，安全编辑后保存为 `0.1.1`，安装到 Codex 后读回 `installed`，最后卸载并移入可恢复回收站。演示未覆盖图形界面或 Windows 全流程，本页不把它扩展为本次验证结果。

当时同机检测也证明：OpenCode 的目录存在但没有 APP/CLI 证据时，仍判为未安装。当前支持范围见 [能力列表](../reference/agent-capabilities.md)。

## 常见问题

### 不登录能管理吗

可以，本机导入、版本与 Agent 安装不需要账号。

### 改哪一份文件

改托管工作副本。用 APP 编辑或安全编辑会话，不直接改 Agent 投影。

### 密钥会随 Skill 带出去吗

SkillHub 单独管理的个人钥匙不会写入 Skill 包；硬编码在正文、脚本或其他 Skill 文件中的秘密仍属于内容，分享前必须检查。

### 保存成功就同步了吗

本机保存不等于账号同步或团队、商店发布成功。分别查看对应状态。

继续阅读 [Mac 与 Windows 同步](sync-skills-mac-windows.md)、[团队共享](share-skills-with-team.md) 或 [商店](marketplace.md)。
