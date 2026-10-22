# 贡献指南

欢迎通过 [Issue 与 PR](https://github.com/billzhuang6569/zsir-skillhub) 贡献。先写目标、范围、验收标准与失败场景，再建立 type/issue-slug 分支；一个 Issue 一个 PR，附变更理由、测试结果与风险，由维护者 Review 后合入 main。

## 常用命令

使用 Node 22、npm、Rust stable 与对应平台的 Tauri 2 工具链；Server 使用 PostgreSQL。组件各有 package.json，根目录不是 npm workspace。

| 组件 / 目录 | 安装与开发 | 检查 |
| --- | --- | --- |
| Desktop / desktop | npm ci；复制 skillhub.build.example.json 为 skillhub.build.json；npm run tauri:dev | npm test && npm run build |
| Rust / desktop/src-tauri | 由 Desktop 的 tauri:dev 启动 | cargo fmt --check && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings |
| Server / server | npm ci；复制 .env.example 为 .env 并配置数据库；npx prisma generate；npm run dev | npx prisma validate && npm test && npm run build |

Desktop 的 npm run dev 仅启动 Vite，原生调用须用 tauri:dev。开发实例可能共享本机运行数据，使用隔离的系统账号进行身份与凭据测试。
Server 单项测试：npx vitest run src/routes/skills.test.ts；本地生成迁移：npm run db:migrate。
PG 测试需要专用测试数据库与 SKILLHUB_PG_TEST_URL，未设置时会跳过，不能据此宣称真实数据库验收通过。
根目录运行 node --test scripts/*.test.mjs、node scripts/check-guide.mjs 与 node scripts/verify-official-channel.mjs。
依赖变化后运行 node scripts/generate-third-party-notices.mjs，并运行 node scripts/check-dependency-licenses.mjs --check（Cargo 缓存须完整）。

Web 是独立组件，由维护者另行维护，不包含在本仓库。其公开开发命令为 npm ci、npm run dev、npm test、npm run build，须在具有该组件源码的目录执行。

## 配置档与门禁

selfhost 用于自部署，yitan-official 保留官方服务的认证与配置合同。配置档由 Server 的 SKILLHUB_PROFILE 选择，与 Desktop 的 official / dev 编译渠道是两套概念。
配置测试显式覆盖两档；现有 Vitest 默认环境固定为 yitan-official，CI 的双档矩阵设置环境变量，但不代表每条路由测试都以两种配置初始化。

- 文档改动：链接及指南检查；脚本改动：相关 Node 测试。
- Desktop / Server 逻辑：对应单测与构建；配置与迁移增加 Prisma 校验和数据库场景。
- Rust / CLI / Agent 路径：Rust 三项门禁及受影响的 macOS / Windows 实机测试。
- 鉴权、团队凭据、网络、导入、迁移：按失败路径补安全回归；原生交互、账号切换和数据恢复须记录真实客户端证据。
- 依赖、字体与图标变化：更新第三方声明并核对许可证；未知来源阻塞分发。

不接受绕过权限、签名、ZIP 或 SSRF 校验，以及把真实凭据带入代码的改动。官方渠道地址与更新公钥由维护者管理，普通功能 PR 不更改这些常量或增加运行时覆盖。分发修改版遵守 [商标政策](TRADEMARK.md)。

## DCO

每个提交须附与提交作者姓名及邮箱匹配的 Signed-off-by trailer，确认下面的 Developer Certificate of Origin 1.1。使用已配置的 Git 身份执行：

```sh
git commit -s -m "fix: 描述改动"
```

签署是贡献者的声明，不要求密码学签名。不要代他人签署；PR 中每个提交都会被 CI 检查。

### Developer Certificate of Origin 1.1

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
