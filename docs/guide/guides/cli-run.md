---
title: CLI 与 skillhub run
description: 使用随 APP 提供的命令行检查状态、预检变更与运行 Skill。
sidebar: { order: 8 }
---

CLI 使用 APP 当前空间与账号，没有独立登录。先运行：

```sh
skillhub --version
skillhub status --json
skillhub auth status --refresh --json
skillhub agent list --json
```

若提示找不到 `skillhub`，先启动已安装的 APP，在设置的 Agent 区域查看 CLI 初始化状态与命令路径；若提示安装有问题，按错误说明处理后点「重新检查」，再打开新的终端窗口重试。不要覆盖其他程序占用的同名命令。

只读状态可能来自本机，`--refresh` 才请求账号验证。网络失败不代表本机数据已经丢失。

## 先预检再执行

导入、安装、删除等命令区分 preflight 与 apply。先读预检结果，再传它返回的 `planDigest`，不复用过期摘要。结果不确定时先查询状态，避免直接重试写操作。

```sh
skillhub skill import preflight --path "/path/to/my-skill" --json
skillhub skill import apply --path "/path/to/my-skill" --plan-digest "<planDigest>" --json
```

## 运行

格式为 `skillhub run <skill-id> -- <program> [args...]`。先进入该 Skill 脚本所需的目录，再运行具体程序，例如它确有 `scripts/main.py` 时：

```sh
skillhub run "<skill-id>" -- python scripts/main.py
```

程序及参数由你明确提供，CLI 不猜入口。它只将当前空间已声明、授权的钥匙注入子进程；不修改全局 Shell，也不把值打印出来。缺少钥匙或授权时回 APP 处理，再重新运行。

不要用打印整个环境的程序验证钥匙，避免将值暴露到终端或日志。退出或切换空间不能收回已经交给运行中程序的环境变量。

完整命令与退出码见 [CLI 参考](../reference/cli-commands.md)。
