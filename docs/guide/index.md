---
title: SkillHub 使用文档
description: 从管理本机 Skills 开始，选择官方服务或部署自己的服务器。
sidebar: { order: 0 }
---

SkillHub 把多个 Agent 的 Skills 放到统一的托管位置，管理版本、安装状态、账号同步与团队共享。

| 使用方式 | 适合谁 | 数据与服务 | 从这里开始 |
| --- | --- | --- | --- |
| 一探官方 | 希望直接使用账号服务 | 官方提供账号、同步、团队与商店；AI、头像按服务状态提供 | [登录一探账号](official/login.md) |
| 仅本机 | 只需要本机整理与运行 | 无业务服务器；本机 Skills 和个人钥匙 | [选择使用方式](getting-started/choose-mode.md) |
| 自部署 | 希望自己管理账号与存储 | 自己维护 Server，可选配置 AI、头像与对象存储 | [在自己电脑上部署](self-host/local-deployment.md) |

## 快速开始

- [下载安装](getting-started/install-app.md)
- [三种使用方式怎么选](getting-started/choose-mode.md)
- [第一次打开 APP](getting-started/first-open.md)
- [官方提供的服务](official/services.md)

## 自部署

- [部署位置怎么选](self-host/deployment-location.md)
- [在自己电脑上部署](self-host/local-deployment.md)
- [云服务器准备](self-host/cloud-preparation.md)
- [已有网关与 Tailscale Serve](self-host/existing-gateway.md)
- [一条命令安装](self-host/one-command-install.md)
- [初始化管理员](self-host/create-admin.md)
- [在 APP 中连接](self-host/connect-app.md)
- [邀请成员](self-host/invite-members.md)
- [备份、恢复与升级](self-host/backup-restore-upgrade.md)
- [可选 S3 与 OSS](self-host/object-storage.md)
- [故障排查](self-host/troubleshooting.md)

## AI 与头像

- [AI 接口](ai-and-avatars/ai-api.md)
- [本机 Claude Code 与额度](ai-and-avatars/local-claude.md)
- [fal.ai Key](ai-and-avatars/fal-key.md)
- [风格选择与切换](ai-and-avatars/avatar-styles.md)

## 功能指南

- [多个 Agent 的 Skills 如何整理、查看版本和安装](guides/manage-agent-skills.md)
- [Mac 与 Windows 如何使用同一套 Skills](guides/sync-skills-mac-windows.md)
- [团队如何共享 Skills 并避免泄漏个人密钥](guides/share-skills-with-team.md)
- [我的 Skills](guides/my-skills.md)
- [导入已有 Skill](guides/import-skill.md)
- [商店浏览、安装与发布](guides/marketplace.md)
- [钥匙](guides/keys.md)
- [CLI 与 skillhub run](guides/cli-run.md)

## 账号与数据

- [在官方与自部署之间切换](account-and-data/switch-spaces.md)
- [迁移 Skill](account-and-data/migrate-skills.md)
- [商店专用登录](account-and-data/store-login.md)

## 参考

- [Agent 能力列表](reference/agent-capabilities.md)
- [兼容矩阵](reference/compatibility.md)
- [Server 环境变量](reference/environment-variables.md)
- [CLI 命令](reference/cli-commands.md)
- [常见问题](reference/faq.md)
- [捐款说明](reference/donations.md)
