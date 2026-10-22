---
title: Agent 能力列表
description: 按平台列出当前可检测和安装 Skill 的 Agent。
sidebar: { order: 1 }
---

来源：`desktop/src-tauri/src/lib.rs` 的 `AGENT_DEFINITIONS`。下表描述代码支持的安装证据，不代表每个安装方式都已完成实机验收。

| Agent 与稳定 key | macOS | Windows | 其他平台代码路径 |
| --- | --- | --- | --- |
| Claude Code `claude` | CLI 或 Claude Code APP | CLI | CLI 或 desktop 标记 |
| ChatGPT `codex` | Codex CLI、ChatGPT 或 Codex APP | Codex CLI 或匹配的 Microsoft Store 包 | CLI 或 desktop 标记 |
| WorkBuddy `workbuddy` | WorkBuddy AI APP | 默认安装位置或登记的 WorkBuddy 可执行文件 | 不支持 |
| 豆包工作 `doubao` | DoubaoWork APP | 不支持 | 不支持 |
| OpenCode `opencode` | CLI 或 APP | CLI | CLI 或 desktop 标记 |
| OpenClaw `openclaw` | CLI 或 APP | CLI | CLI 或 desktop 标记 |
| Gemini CLI `gemini` | CLI | CLI | CLI 或 desktop 标记 |
| Trae 国际版 `trae` | Trae APP | 不支持 | 不支持 |

其他平台列仅反映源码分支，不承诺提供对应桌面安装包。

## Skill 目录

`~` 表示当前用户目录；Windows 界面显示解析后的绝对路径。

| key | macOS | Windows |
| --- | --- | --- |
| claude | `~/.claude/skills` | `~/.claude/skills` |
| codex | `~/.codex/skills` | `~/.codex/skills` |
| workbuddy | `~/.workbuddy-ai/skills` | `~/.workbuddy/skills` |
| doubao | `~/.agents/skills` | 不开放 |
| opencode | `~/.config/opencode/skills` | `~/.config/opencode/skills` |
| openclaw | `~/.openclaw/skills` | `~/.openclaw/skills` |
| gemini | `~/.gemini/skills` | `~/.gemini/skills` |
| trae | `~/.trae/skills` | 不开放 |

目录存在不算安装证据；`skillhub agent list --json` 分别返回检测状态和目录状态。读取证据失败可能显示检测不完整，不能断言没安装。

`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`OPENCODE_CONFIG_DIR` 指向非默认根时会标记目录未确认，阻止默认目录的新读写。GUI 与终端可能看到不同环境变量，需分别核对。

**支持安装 Skill 不等于支持本机 AI 推理**。后者仅支持指定版本的 Claude Code，见 [本机推理](../ai-and-avatars/local-claude.md)。
