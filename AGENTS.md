# SkillHub — Agent 项目指令

先读本文件、README.md、CONTRIBUTING.md 与相关 docs/guide/ 文档，以当前代码和实际测试为准。

## 项目范围

- desktop/：Tauri 2、React 18、TypeScript、Vite、Zustand 与 Rust GUI / CLI 核心。
- server/：Node 22、TypeScript ESM、Fastify 5、Prisma 5 与 PostgreSQL。
- deploy/selfhost/：通用自部署；docs/guide/：公开使用文档；qa-skills/：通用验收夹具。
- 内置 desktop/src-tauri/system-skills/ 面向终端用户，使用 MIT 许可证。

## 开发流程

在 [公开仓库](https://github.com/billzhuang6569/zsir-skillhub) 创建有目标、范围和验收标准的 Issue，一个 Issue 一个独立分支，命名为 type/issue-slug，经 PR 与 Review 合入 main。提交须符合 DCO，使用 git commit -s。不得直接推送或 force push main。
改动前说明假设，追踪调用方与测试，采用最小完整方案；保护他人修改。按 CONTRIBUTING.md 的分级门禁验证，未执行项说明原因。真实客户端验收不能由编译或单测替代。

## 编码约束

TypeScript strict；优先 type，禁止 any 与 var，使用 unknown 和类型守卫。async 函数声明明确返回类型。
Fastify handler 显式声明请求 params/body 与 FastifyReply，返回 reply.send(...)；使用 Fastify/http-errors 语义及 request.log / server.log。
Prisma schema 与 migrations 是结构真源，客户端来自 server/src/db.ts 单例。结构变更必须写 migration，不以 db:push 代替迁移。
配置集中声明与校验，样例同步 server/.env.example；新依赖必须直接支撑明确需求并核对许可证。

## 身份与安全

Desktop 使用系统浏览器 Authorization Code + PKCE S256，业务 API 使用 SkillHub JWT。selfhost 与 yitan-official 配置档分别验证。
外部身份仅按精确 issuer + subject 映射本地 UUID，禁止邮箱自动合并。受保护 API 无有效 Bearer JWT 时返回 401。
本机 sidecar 按当前账号隔离，切换账号不得复用他人的 Server Skill ID、作者权或团队状态。Server 不存明文密码。
官方渠道地址与更新公钥由维护者管理；不接受运行时覆盖或跳过签名校验。不得宣称未实现的邮箱验证或邮件找回已可用。

## 跨平台 Agent 合同

desktop/src-tauri/src/lib.rs 的 AGENT_DEFINITIONS 是能力、检测和路径真源，前端不得另写平台路径。
APP / CLI 安装证据与目录状态分开；目录存在不证明已安装。未适配平台的 Agent 从列表省略，不猜测私有目录。
Agent 变更同步 Server 兼容字段、macOS / Windows 测试，并在真实安装环境验收。

## 文档纪律与永久禁止

公开操作说明写入 docs/guide/，遵守该目录 README.md；任务进度放 Issue / PR。文档链接和已实现行为必须验证。
禁止提交真实密码、Token、私钥、签名材料、个人身份映射、数据库连接串或真实环境文件。
禁止绕过身份校验、迁移与签名规则，禁止移动已发布 tag；破坏性数据操作须有可恢复备份。
禁止提交 node_modules、Rust target、缓存、临时截图、日志或本机恢复档案。
