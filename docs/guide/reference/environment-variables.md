---
title: Server 环境变量
description: 当前 Server 配置 schema 中全部环境变量的默认值与用途。
sidebar: { order: 3 }
---

事实源为 `server/src/config-schema.ts`；`server/.env.example` 是示例，不覆盖 schema 默认值。下表覆盖 schema 的全部输入变量。`未设置` 表示可省略，`必填` 表示无默认值；空串、false 与未设置含义不同。布尔值接受 true/false 或 1/0。

为避免把官方部署细节当作自部署示例，固定官方地址用“内置官方预设”表示，内置诊断路径用语义描述；不是让你把这些文字填入配置。回环地址也以语义表示，实际安装请保留向导生成值。示例基址 `https://skills.example.com`，示例邮箱 `admin@example.com`。

## 基础与存储

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `MIN_CLIENT_VERSION` | 未设置 | 严格 SemVer，空串视为未设置，对外为 null |
| `DATABASE_URL` | 必填 | PostgreSQL 连接串，非空，保密 |
| `JWT_SECRET` | 必填 | 至少 16 字符；生产至少 32 字符随机值 |
| `JWT_EXPIRES_IN_SECONDS` | 604800 | 会话秒数，300–63072000（2 年）；官方推荐 31536000，配合 APP 会话续期 |
| `PORT` | 3001 | 监听端口 |
| `HOST` | IPv4 回环地址 | IPv4 监听地址；Compose 按容器网络设置 |
| `TRUSTED_PROXIES` | IPv4 回环地址 | 可信代理地址或 CIDR，逗号分隔，不能信任所有来源 |
| `NODE_ENV` | development | development、production 或 test |
| `SKILLHUB_PROFILE` | selfhost | selfhost 或 yitan-official；生产必须显式设置 |
| `PUBLIC_BASE_URL` | HTTP 回环地址的 3001 端口 | 生产必须显式设置；非回环必须 HTTPS，可带前缀 |
| `INSTANCE_ADDITIONAL_BASE_URLS` | 空列表 | 逗号分隔的附加基址，不得重复或包含主基址 |
| `CORS_ORIGIN` | `http://localhost:1420,tauri://localhost` | 官方允许来源；自部署仍拒绝带 Origin 的请求 |
| `SKILL_CARD_STORAGE_DIR` | `/opt/skillhub/data/skill-cards` | 卡片绝对目录，切换 S3 后保留 |
| `MEDIA_STORAGE_DIR` | `/opt/skillhub/data/media` | 媒体绝对目录，切换 S3 后保留 |
| `STORAGE_DEFAULT` | filesystem | filesystem 或 s3，只影响默认新写入 |
| `S3_ENDPOINT` | 未设置 | HTTPS 服务 endpoint；回环或可信 Compose 单标签可 HTTP |
| `S3_REGION` | 未设置 | 地域，仅小写字母、数字、短横线 |
| `S3_BUCKET` | 未设置 | bucket 名，3–63 字符 |
| `S3_PREFIX` | 空串 | 相对对象前缀，不带首尾斜杠 |
| `S3_ACCESS_KEY_ID` | 未设置 | 对象存储访问标识，保密 |
| `S3_SECRET_ACCESS_KEY` | 未设置 | 对象存储密钥，保密 |
| `S3_FORCE_PATH_STYLE` | false | 按供应商要求启用路径式寻址 |
| `AVATAR_STYLE_ORIGIN` | 内置官方预设 | 头像风格库信任基址，同 PUBLIC_BASE_URL 校验 |
| `CATALOG_ORIGIN` | 内置官方预设 | 自部署核验官方商店来源的信任基址 |
| `CATALOG_TOKEN_TTL_DAYS` | 30 | 官方商店专用登录有效天数，1–90；仅一探官方服务使用 |

设置任一 S3 必需项或默认选 s3 时，endpoint、region、bucket、access key、secret key 五项必须齐全。改变 endpoint/bucket/prefix 会改变 namespace；先完成 [复制与改指](../self-host/object-storage.md#复制校验后改指)。

## 密码账号与注册

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `AUTH_MODE` | legacy | legacy、dual、yitan；官方 OIDC 模式由部署档约束 |
| `LOCAL_REGISTRATION_ENABLED` | true | false 强制关闭本地注册 |
| `REGISTRATION_MODE` | selfhost 为 invite，官方为 open | 环境输入只接受 open/invite；界面另外支持 closed |
| `REGISTRATION_INVITE_CODE` | 未设置 | 注册邀请码；selfhost invite 无码时关闭注册 |
| `AUTH_LEGACY_MIGRATION_ALLOWLIST` | 空列表 | 旧账号显式关联的本地用户 UUID，不接受邮箱 |
| `AUTH_LEGACY_MIGRATION_SESSION_SECONDS` | 600 | 旧账号关联的短时会话，60–900 秒 |
| `AUTH_LOGIN_ATTEMPTS_PER_15_MIN` | 10 | 账号与 IP 组合登录限制，1–1000 |
| `AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN` | 100 | IP 登录总限制，10–10000，不小于上一项 |
| `AUTH_REGISTER_ATTEMPTS_PER_HOUR` | 5 | 注册尝试限制，1–1000 |
| `AUTH_YITAN_EXCHANGE_ATTEMPTS_PER_15_MIN` | 30 | 官方登录交换尝试，1–1000 |
| `AUTH_YITAN_BACKCHANNEL_ATTEMPTS_PER_MINUTE` | 300 | 官方注销回传尝试，10–10000 |

显式注册环境配置优先于界面；邀请码最多 512 字符，生产设置非空邀请码时至少 16 字符。不要混用注册邀请码与一次性初始化码。

## OIDC 与 Web 账号字段

这些是 schema 保留的官方认证合同，不能据此宣称自部署已支持任意通用 OIDC。普通自部署使用本地邮箱密码，不需要配置本节。

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `YITAN_OIDC_ISSUER` | 内置官方预设 | issuer URL，不以斜杠结尾 |
| `YITAN_OIDC_JWKS_URL` | 内置官方预设 | 签名公钥地址 |
| `YITAN_OIDC_AUDIENCE` | skillhub-api | API audience |
| `YITAN_OIDC_ALLOWED_AZP` | skillhub-desktop,skillhub-web | 允许的客户端，非空、去重 |
| `YITAN_OIDC_CLOCK_TOLERANCE_SECONDS` | 5 | 时钟容差，0–60 秒 |
| `YITAN_OIDC_MAX_TOKEN_AGE_SECONDS` | 600 | token 最大年龄，300–900 秒 |
| `YITAN_OIDC_LINK_MAX_AUTH_AGE_SECONDS` | 600 | 关联时最大认证年龄，60–900 秒 |
| `YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE` | skillhub-desktop,skillhub-web | 注销回传 audience |
| `YITAN_OIDC_LOGOUT_MAX_TOKEN_AGE_SECONDS` | 120 | 注销 token 最大年龄，30–300 秒 |
| `YITAN_TEST_BACKCHANNEL_ENABLED` | false | 隔离测试注销回传开关 |
| `YITAN_TEST_OIDC_ISSUER` | 内置官方测试预设 | 测试 issuer |
| `YITAN_TEST_OIDC_JWKS_URL` | 内置官方测试预设 | 测试签名公钥地址 |
| `YITAN_TEST_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE` | skillhub-desktop-test | 测试 audience |
| `WEB_ADMIN_EMERGENCY_PASSWORD_LOGIN_ENABLED` | false | Web 管理密码入口开关，自部署无需开启 |
| `YITAN_WEB_CLIENT_ID` | skillhub-web | Web OIDC 客户端 |
| `YITAN_WEB_CLIENT_SECRET` | 未设置 | 16–512 字符；只留 Server |
| `YITAN_WEB_REDIRECT_URI` | 内置官方预设 | 登录回调 URL |
| `YITAN_WEB_POST_LOGOUT_REDIRECT_URI` | 内置官方预设 | 注销后跳转 URL |
| `YITAN_WEB_SUCCESS_URL` | 内置官方预设 | 登录成功页 URL |
| `YITAN_WEB_OIDC_TRANSACTION_SECONDS` | 300 | 登录事务有效期，120–600 秒 |
| `YITAN_WEB_OIDC_TOKEN_TIMEOUT_MS` | 5000 | token 请求超时，1000–15000 毫秒 |

## AI 与头像

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_API_BASE_URL` | 未设置 | AI 基址；生产要求 HTTPS |
| `AI_API_KEY` | 未设置 | 供应商密钥，与基址完整配置时覆盖界面设置 |
| `AI_MODEL` | kimi-k3 | 模型名，不代表供应商都支持该模型 |
| `AI_PROTOCOL` | openai-responses | openai、anthropic 或 openai-responses |
| `AI_RATE_LIMIT_PER_MINUTE` | 6 | 分钟调用限制，1–60 |
| `AI_GLOBAL_DAILY_LIMIT` | 200 | 初始实例每日次数，1–100000 |
| `AI_PER_USER_DAILY_LIMIT` | 50 | 初始个人每日次数，1–100000 |
| `AI_MAX_CONCURRENT` | 2 | 最大并发，1–20 |
| `AI_MAX_TOKENS` | 4096 | 输出 token 上限，512–8192 |
| `AI_TIMEOUT_MS` | 30000 | 请求超时，1000–120000 毫秒 |
| `FAL_KEY` | 未设置 | 16–512 字符，环境优先；自部署也可测试后在界面保存 |
| `SKILL_AVATARS_ENABLED` | false | 官方头像开关；selfhost 根据有效 fal Key 判断生成可用性 |
| `SKILL_AVATAR_MODEL_READS` | selfhost 为 variants，官方为 legacy | 头像读取模型，legacy 或 variants |
| `SKILL_AVATAR_DAILY_LIMIT` | 200 | 每日头像数量限制，1–10000 |
| `SKILL_AVATAR_WORKER_CONCURRENCY` | 4 | worker 并发步骤，1–32 |
| `SKILL_AVATAR_GENERATE_CONCURRENCY` | 1 | 付费生成阶段并发，1–16，不大于 worker 并发 |
| `PICEM_BASE_URL` | 内置官方 Picem 预设 | 固定字面量，非任意图床 endpoint |
| `PICEM_API_KEY` | 未设置 | 至少 32 字符，官方媒体适配器凭据 |
| `TOPIC_IMAGE_HOSTS` | 内置官方图片主机预设 | 专题允许图片主机，非空、逗号分隔裸域名 |

AI 并发至少为 2 时，头像生成并发不能超过 AI 并发减一；AI 并发为 1 时后台头像提示词工作等待。环境日额度必须为正，界面策略可设 0 禁止消费；见 [AI 接口](../ai-and-avatars/ai-api.md)。

## 钥匙、配额与其他字段

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `CREDENTIAL_KEK_BASE64` | 未设置 | 32 字节密钥的规范 base64；生产必填高熵值 |
| `CREDENTIAL_KEK_VERSION` | 1 | 当前密钥版本，1–1000000 |
| `CREDENTIAL_KEK_KEYRING_JSON` | `{}` | 旧版本密钥映射，不能重定义当前版本 |
| `CREDENTIAL_WRITES_PER_HOUR` | 30 | 团队钥匙写入限制，1–1000 |
| `RUNTIME_ENV_FETCHES_PER_MINUTE` | 60 | 运行时钥匙获取限制，1–1000 |
| `CREDENTIAL_MAX_VALUE_BYTES` | 16384 | 单值字节上限，1–65536 |
| `SKILL_MAX_PER_USER` | 50 | 每用户 Skill 上限，1–10000 |
| `SKILL_MAX_VERSIONS_PER_SKILL` | 30 | 每 Skill 版本上限，1–1000 |
| `SKILL_MAX_STORAGE_BYTES_PER_USER` | 262144000 | 每用户存储字节，20 MiB–100 GiB |
| `SKILL_VERSION_WRITES_PER_HOUR` | 30 | 版本写入限制，1–1000 |
| `MIGRATION_WRITES_PER_HOUR` | 1200 | 迁移 POST 预算，1–100000 |
| `LIBRARY_CARD_UPLOADS_PER_HOUR` | 240 | 卡片上传限制，1–10000 |
| `LIBRARY_CARD_DOWNLOADS_PER_MINUTE` | 120 | 卡片下载限制，1–10000 |
| `MARKETPLACE_DOWNLOADS_PER_MINUTE` | 60 | 商店下载限制，1–1000 |
| `FEEDBACK_ATTEMPTS_PER_HOUR` | 10 | 反馈提交限制，1–1000 |
| `APP_UPDATE_MANIFEST_PATH` | app-update-manifest.json | 更新清单路径；普通自部署无需改动 |
| `ADMIN_AGENT_RELEASE_SUMMARY_PATH` | 内置诊断摘要绝对路径 | 管理诊断读取字段，普通自部署无需配置 |
| `ADMIN_GATEWAY_LOG_PATH` | 内置网关日志绝对路径 | 管理诊断读取字段，普通自部署无需配置 |

配置历史 keyring 时必须保留当前 KEK，不能删除仍有密文引用的旧 Key。备份必须包含 `.env` 与历史密钥；修改这些字段前先完成 [备份验证](../self-host/backup-restore-upgrade.md#验证)。
