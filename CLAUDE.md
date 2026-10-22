# CLAUDE.md

@AGENTS.md

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
