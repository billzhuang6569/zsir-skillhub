---
title: 在官方与自部署之间切换
description: 切换服务空间时保留原数据并隔离账号、钥匙与同步状态。
sidebar: { order: 1 }
---

1. 在设置中选择一探官方、仅本机或自部署服务器。
2. 自部署先测试地址并完成登录；官方通过系统浏览器登录；仅本机无需账号。
3. 确认切换，待界面加载目标空间后再操作。

空间隔离账号资料、云库身份、同步状态、整理器、个人钥匙与授权。不同服务器使用同一个邮箱，甚至同一个用户 UUID，也不会合并数据或权限。

当前只保存一个活动业务会话。返回旧空间需要重新登录，原本机数据保留。切换不删除文件、不自动复制数据，也不会让已安装到 Agent 的投影消失。

CLI 在 APP 未运行时可用 `skillhub server use official`、`skillhub server use local` 或 `skillhub server use https://skills.example.com`；它只切换为目标游客，不登录、不迁移。APP 运行时请从设置页切换。

实例换地址时用 APP 的身份验证和「改用新地址」流程；不能仅凭相同邮箱或服务器声称的 ID 合并空间。见 [连接说明](../self-host/connect-app.md) 与 [迁移当前范围](migrate-skills.md)。
