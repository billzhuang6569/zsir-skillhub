---
title: 常见问题
description: 本机使用、空间、账号、同步和服务配置的常见解答。
sidebar: { order: 5 }
---

## 必须登录吗

本机导入、版本与安装到 Agent 不需要。账号同步、团队与投稿需要登录相应空间。

## 仅本机等于完全不联网吗

不是。APP 仍检查更新，主动打开官方商店时请求目录、图片和安装包；不启动账号同步等业务后台任务。

## 同邮箱在两个服务器上是同一账号吗

不是。空间与账号隔离，不按邮箱自动合并。见 [空间切换](../account-and-data/switch-spaces.md)。

## 自部署必须购买 AI 服务吗

不必，手工编辑与导入仍可用。可自行配置 AI 接口，或在满足条件时启用 [本机 Claude Code](../ai-and-avatars/local-claude.md)。生成头像的 fal 费用另计。

## Codex 能安装 Skill 却不能做本机分析

安装目录支持与推理隔离支持是两回事。当前 Codex CLI 不能满足关闭用户指令与账号 MCP 的隔离要求。

## 忘记自部署密码怎么办

联系实例管理员使用 [密码重置命令](../self-host/create-admin.md)，当前没有邮件找回。

## 为什么 Agent 目录存在却显示未安装

检测需要真实 APP 或 CLI 证据；目录就绪是独立状态。查看 [能力列表](agent-capabilities.md)。

## 服务端备份包括外部 S3 吗

不包括外部 bucket 的内容；本地 SeaweedFS 叠加的对象卷包括在内。见 [备份说明](../self-host/backup-restore-upgrade.md)。

## 连接测试通过代表 AI 可以用了

不代表。连接报告的 AI 与头像项只读能力状态，不进行付费请求。分别到 [AI 设置](../ai-and-avatars/ai-api.md) 与 [fal 设置](../ai-and-avatars/fal-key.md) 测试。
