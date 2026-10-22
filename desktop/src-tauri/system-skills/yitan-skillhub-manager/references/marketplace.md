# Marketplace

不要直接请求 Server 或下载包；全部通过公开 CLI 获取、校验和安装。

## 搜索与查看

```sh
skillhub marketplace search --query "<关键词>" --json
skillhub marketplace search --category "<分类>" --label "<标签>" --agent "<agent-key>" --sort latest --page 1 --page-size 20 --json
skillhub marketplace show "<server-skill-uuid>" --json
```

- 搜索支持 `--query`、`--category`、`--label`、`--agent`、`--sort latest|downloads`、`--page` 和 `--page-size`；只传实际需要的过滤条件。
- 根据关键词、作者和兼容 Agent 展示候选，避免仅凭同名自动选择。
- 公开搜索和查看可以在 Guest 状态使用；若 CLI 返回需要账号，以其错误码为准。
- 安装前展示 Server 当前批准的版本、来源、兼容性和本地冲突；不要虚构历史版本选择能力。

## 安装与更新

```sh
skillhub marketplace updates --json
skillhub marketplace install "<server-skill-uuid>" --preflight --json
skillhub marketplace install "<server-skill-uuid>" --apply --plan-digest "<64-hex>" --json
```

1. Marketplace 浏览、更新列表和安装都可在 Guest 状态使用。`updates` 将本地固定版本/包哈希与 Server 当前批准包比较；只有 `canUpdate: true` 才进入返回的安装预检命令。
2. 若存在同名、个人修改、来源变化或版本回退，同时按 [installation-conflicts.md](installation-conflicts.md) 处理。
3. 向用户展示预检，并在需要覆盖/冲突决策时取得明确确认。
4. 使用预检返回的计划标识执行，不能把搜索结果中的 URL 当成可信安装源。
5. 执行后重新查询本地版本和投影状态。

下载包只有在 Server/Desktop 安全校验和哈希验证通过后才能安装。失败时保留原安装和个人修改；不要手动解压、替换或重试来源不明的包。

已有 Marketplace Skill 有本地修改、缺少旧版包哈希或来源不一致时，更新必须停止并保留本地内容。安全更新使用 `marketplace install` 的预检/apply 流程，原固定包进入可恢复备份后才替换。本版不支持指定非当前的 Marketplace 历史包。
