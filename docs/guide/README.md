---
title: 文档编写约定
description: 文档中心的目录、链接、锚点与事实核对规则。
sidebar: { order: 99 }
---

## 内容规则

正文按主题放在英文分组目录中，每页一个主题。文件名使用稳定的英文短横线 slug，已有文件不改名；同名页面不能分散到不同分组。`index.md` 是首页，本文件是编写约定。

每页必须有 `title`、`description`、`sidebar: { order: N }`。标题为中文，描述是一句话；顺序为非负整数。使用双引号字符串或不含 YAML 特殊字符的单行文本，不使用多行 YAML、别名或自定义 slug。

只写当前实现。设计中的功能不能写成可用步骤；不复制个人资料、真实凭据、内部地址或私有运维资料。命令中的占位符须先替换，示例域名为 `skills.example.com`，邮箱为 `admin@example.com`。本机安装示例允许精确回环地址 `127.0.0.1`，其他 IP 地址仍禁止；APP 连接必须原样复制向导地址，不换成 `localhost`，以免违反 Host 校验。

公开仓库地址统一占位为 `https://github.com/billzhuang6569/zsir-skillhub`，**#419 导出时替换 OWNER**，同时替换公开 README 中的同一占位。发布 tag 用 `<发布 tag>` 或 `<新 tag>` 表示，读者执行前替换为实际标签。

## 链接和锚点

站内链接统一为相对 `.md` 路径，可带片段，例如 [证书排查](self-host/troubleshooting.md#cert-untrusted)。同页也写文件名，不写站点部署路径。外部链接使用完整 HTTPS URL。源文件名只用行内代码注明，不链接到不随文档站导出的代码或私有资料。

本批正文统一使用 **标题自动 ID**，不使用 `{#id}`。Starlight 的 Markdown 由 Astro 处理并为标题生成 ID，见 [Astro 标题 ID 说明](https://docs.astro.build/en/guides/markdown-content/#heading-ids)。需要供 APP 长期引用的标题只用小写英文、数字和短横线，例如 `## cert-untrusted`，中文说明放在其下一段；这样不会受中文标点或渲染器版本影响。其他标题使用纯文本，避免内嵌 HTML、实体或复杂格式。

检查器对普通标题按小写、删除标点、空白转短横线生成 ID，重复 ID 按出现顺序加 `-1`、`-2`。它也识别标题末尾的显式 `{#id}`，供迁入内容校验，但这不代表渲染端已配置该扩展；改用显式语法须同时配置渲染器。不要把代码块或 HTML 注释里的示例标题当作锚点。

## 检查与后续接入

在仓库根运行：

```sh
node scripts/check-guide.mjs docs/guide
node scripts/check-guide.mjs --release docs/guide
node --test scripts/check-guide.test.mjs
```

`checkGuide(root, { release: false })` 接受文档根目录，返回 `{ ok, errors, warnings, pages }`，第二参数可省略。默认对未替换的仓库 OWNER 占位只警告；`--release`（或 `release: true`）将其视为错误，退出码为 1。每个 page 含相对 `path`、`slug`、`title` 和 `anchors` 数组，错误与警告含 `path`、`code`、`message`。后续 APP 帮助链接检查可复用该索引。检查不访问网络、不执行文档命令。

文档站接入负责把 `.md` 链接转换为站点路由、生成结构化数据、处理旧指南重定向和搜索。正文不含 JSON-LD 或其他脚本。公开仓库根 README 的许可证与贡献链接由导出阶段补齐，不在本目录伪造对应文件。
