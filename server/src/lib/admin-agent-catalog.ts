import type { AgentScope } from './admin-agent-key.js'
import { publicUrl } from './public-url.js'

export type AgentApiOperation = {
  operationId: string
  method: 'GET' | 'POST'
  path: string
  scope: 'valid-key' | AgentScope
  description: string
  source: string
  freshness: string
  responseFields: readonly string[]
  authentication: 'agent-key'
  readOnly: boolean
  requestFields: readonly string[]
  parameters: readonly string[]
  errors: readonly number[]
  retry: string
  pagination: string
  timeUnits: string
  example: string
}

export const AGENT_API_VERSION = '1.0.0'
const DIAGNOSTIC_WINDOW_PARAMETERS = [
  'from: ISO 8601 UTC，可选，默认最近 15 分钟',
  'until: ISO 8601 UTC，可选，默认当前时间',
  'status: 400–599，可选',
  'limit: 1–500，可选，默认 100',
] as const
const AGENT_API_DEFINITIONS = [
  { operationId: 'agent.capabilities', method: 'GET', path: '/api/admin/v1/capabilities', scope: 'valid-key', description: '查看此 Key 当前可调用的接口和限制', source: '当前 Server 接口目录', freshness: '实时', responseFields: ['apiVersion', 'scopes', 'expiresAt', 'operations'] },
  { operationId: 'agent.overview', method: 'GET', path: '/api/admin/v1/overview', scope: 'ops:read', description: '查看服务版本、进程运行时间和数据库就绪状态', source: '运行中 Server 和迁移表', freshness: '请求时采集', responseFields: ['server', 'database'] },
  { operationId: 'agent.releases', method: 'GET', path: '/api/admin/v1/releases', scope: 'ops:read', description: '查看 Server 发布元数据与 APP 清单状态', source: '打包元数据和 APP 清单', freshness: '请求时读取；历史校验缺证据时为 unknown', responseFields: ['server', 'app', 'deploymentEvidence'] },
  { operationId: 'agent.migrations', method: 'GET', path: '/api/admin/v1/migrations', scope: 'ops:read', description: '查看最近迁移状态，不返回 SQL 或错误日志', source: 'Prisma 迁移表', freshness: '请求时查询，最多 50 条', responseFields: ['expected', 'recent', 'truncated'] },
  { operationId: 'agent.jobs', method: 'GET', path: '/api/admin/v1/jobs', scope: 'ops:read', description: '查看头像任务数量和最早待处理时间', source: '头像任务表', freshness: '请求时查询；无心跳证据时为 unknown', responseFields: ['avatars', 'workerHeartbeat'] },
  { operationId: 'agent.storage', method: 'GET', path: '/api/admin/v1/storage', scope: 'ops:read', description: '查看固定逻辑区域的数量及未知磁盘容量', source: '数据库聚合', freshness: '请求时查询；不扫描全盘', responseFields: ['counts', 'disk', 'integrityEvidence'] },
  { operationId: 'agent.errors', method: 'GET', path: '/api/admin/v1/errors', scope: 'ops:logs:read', description: '查看安全错误指纹的有界聚合，不返回原始异常', source: '诊断事件表', freshness: '请求时查询；只覆盖记录窗口', responseFields: ['groups', 'truncated', 'capture'] },
  { operationId: 'agent.logs', method: 'GET', path: '/api/admin/v1/logs', scope: 'ops:logs:read', description: '分页查看安全诊断事件；不含普通成功请求', source: '诊断事件表', freshness: '请求时查询；事件可能因队列丢弃或清理缺失', responseFields: ['events', 'nextCursor', 'capture'] },
  { operationId: 'agent.request', method: 'GET', path: '/api/admin/v1/requests/:requestId', scope: 'ops:logs:read', description: '按请求 ID 关联应用事件和最近网关记录', source: '诊断事件表与有界网关日志', freshness: '请求时查询；无记录不证明请求不存在', responseFields: ['application', 'gateway', 'coverage'] },
  { operationId: 'agent.gateway', method: 'GET', path: '/api/admin/v1/gateway', scope: 'ops:logs:read', description: '查看最近网关拒绝与覆盖范围', source: '专用网关 JSON 日志', freshness: '只读取当前及一份未压缩轮转文件', responseFields: ['events', 'scannedBytes', 'truncated'] },
] as const

const REVIEW_BINDING = ['expectedVersionId: UUID', 'expectedPackageSha256: lowercase SHA-256', 'expectedStatus: submitted(start) / under_review(approve,reject)']
const MARKETPLACE_AGENT_DEFINITIONS: readonly {
  operationId: string; method: 'GET' | 'POST'; path: string; scope: AgentScope; description: string; parameters: readonly string[]; requestFields: readonly string[]; responseFields: readonly string[]
}[] = [
  { operationId: 'marketplace.listing.source', method: 'POST', path: 'listings/:id/source', scope: 'marketplace:review', description: '更新或清空来源网址，生成新的已审核版本；不修改历史快照', parameters: ['id: Skill UUID'], requestFields: ['sourceUrl: HTTP/HTTPS URL，最多 2048 字符；null/空串清空', 'expectedUpdatedAt: 最近读回的 listing.updatedAt'], responseFields: ['sourceUrl', 'versionId', 'updatedAt'] },
  { operationId: 'marketplace.publish', method: 'POST', path: 'skills/publish', scope: 'marketplace:publish', description: '管理员上传 ZIP 并直接上架；沿用包安全校验与审核快照', parameters: [], requestFields: ['clientOperationId: UUID，同时作为新 Skill ID', 'name: 可移植目录名', 'version: 三段单数字，默认 0.1.0', 'profile: displayName,description,category,labels(2–5 个固定标签),triggerScenarios,sourceUrl（可选 HTTP/HTTPS，最多 2048 字符，不含账号密码；null/空白清空，省略保留）；来源参与幂等校验', 'compatibleAgents: 支持的 Agent 数组', 'envDependencies: 仅 key/description/required，无秘密值', 'packageBase64: 完整 ZIP', 'packageSha256: lowercase SHA-256'], responseFields: ['skillId', 'versionId', 'submissionId', 'packageSha256', 'sourceUrl', 'created'] },
  { operationId: 'marketplace.publish.read', method: 'GET', path: 'skills/:id', scope: 'marketplace:publish', description: '读回本签发管理员直发的 Skill 身份、包指纹与状态', parameters: ['id: 首次提交的 clientOperationId'], requestFields: [], responseFields: ['skillId', 'versionId', 'version', 'packageSha256', 'sourceUrl', 'submissionId', 'status'] },
  { operationId: 'marketplace.submissions', method: 'GET', path: 'submissions', scope: 'marketplace:review', description: '读取普通投稿审核队列', parameters: ['search,category,status,order,page,pageSize: 沿用后台队列参数'], requestFields: [], responseFields: ['items', 'total', 'page', 'pageSize', 'totalPages'] },
  { operationId: 'marketplace.submission', method: 'GET', path: 'submissions/:id', scope: 'marketplace:review', description: '读取投稿固定资料和版本', parameters: ['id: submission UUID'], requestFields: [], responseFields: ['id', 'skillId', 'version', 'status', 'skill'] },
  { operationId: 'marketplace.inspection', method: 'GET', path: 'submissions/:id/package-inspection', scope: 'marketplace:review', description: '完整检查投稿包，获取审核版本、SHA-256 与全部可读文件', parameters: ['id: submission UUID'], requestFields: [], responseFields: ['submissionId', 'versionId', 'packageSha256', 'files', 'readableTextBytes'] },
  ...(['start', 'approve', 'reject'] as const).map((action) => ({ operationId: `marketplace.review.${action}`, method: 'POST' as const, path: `submissions/:id/${action}`, scope: 'marketplace:review' as const, description: `复用原投稿审核状态转换：${action}`, parameters: ['id: submission UUID'], requestFields: [...REVIEW_BINDING, ...(action === 'reject' ? ['reviewNote: 必填拒绝原因，1–2000 字符'] : action === 'approve' ? ['note: 可选，最多 2000 字符'] : [])], responseFields: ['id', 'skillId', 'version', 'status', 'reviewNote'] })),
  { operationId: 'marketplace.listing', method: 'GET', path: 'listings/:id', scope: 'marketplace:review', description: '读取上架记录的完整管理详情：审核快照资料、当前版本 SKILL.md、投稿与版本记录、所属专题和近 30 天下载/安装', parameters: ['id: Skill UUID'], requestFields: [], responseFields: ['listing', 'skill', 'author', 'currentVersion', 'submissions', 'topics', 'metrics'] },
  { operationId: 'marketplace.listing.skillMd', method: 'GET', path: 'listings/:id/submissions/:submissionId/skill-md', scope: 'marketplace:review', description: '读取某次投稿审核快照中的 SKILL.md', parameters: ['id: Skill UUID', 'submissionId: submission UUID'], requestFields: [], responseFields: ['submissionId', 'versionId', 'version', 'sourceContent'] },
  { operationId: 'marketplace.listing.withdraw', method: 'POST', path: 'listings/:id/withdraw', scope: 'marketplace:review', description: '把在架 Skill 从商店下架并通知作者；已安装用户保留本机副本', parameters: ['id: Skill UUID'], requestFields: ['reason: 必填下架原因，1–500 字符', 'expectedUpdatedAt: 最近读回的 listing.updatedAt'], responseFields: ['listingId', 'status', 'withdrawnAt', 'withdrawnBy', 'withdrawnReason', 'updatedAt'] },
  { operationId: 'marketplace.listing.restore', method: 'POST', path: 'listings/:id/restore', scope: 'marketplace:review', description: '恢复管理员下架的 Skill；作者自己删除的不能恢复', parameters: ['id: Skill UUID'], requestFields: ['expectedUpdatedAt: 最近读回的 listing.updatedAt'], responseFields: ['listingId', 'status', 'updatedAt'] },
  { operationId: 'marketplace.topics', method: 'GET', path: 'topics', scope: 'marketplace:topics:write', description: '有界读取专题资料与关联顺序', parameters: ['page,pageSize'], requestFields: [], responseFields: ['items', 'page', 'pageSize', 'nextPage'] },
  { operationId: 'marketplace.topic', method: 'GET', path: 'topics/:id', scope: 'marketplace:topics:write', description: '读回专题及 updatedAt，供保存前比对与失败恢复；contentMarkdown 为空的旧专题读回合成正文（导语 + 每个关联一行嵌入）', parameters: ['id: topic UUID'], requestFields: [], responseFields: ['id', 'slug', 'title', 'description', 'introContent', 'contentMarkdown', 'coverImageUrl', 'status', 'featured', 'sortOrder', 'updatedAt', 'items'] },
  { operationId: 'marketplace.topic.save', method: 'POST', path: 'topics/save', scope: 'marketplace:topics:write', description: '原子创建/编辑专题；文章形态以 contentMarkdown 为唯一来源派生关联与导语，旧形态沿用 listingIds + introContent；已文章化专题的旧形态保存返回 409 TOPIC_ARTICLE_REQUIRES_UPGRADE', parameters: [], requestFields: ['id: 首次请求前生成的稳定 UUID', 'expectedUpdatedAt: 新建为 null；更新为最近读回的 UTC 时间戳', 'title: 1–120 字符', 'description: 最多 500 字符，可为空', 'contentMarkdown: 文章正文，≤ 60000 字符，Markdown 子集 + 独占段落的 [name](skill:<uuid>) 嵌入；带它时不得同时带 listingIds / introContent（400 TOPIC_DERIVED_FIELD）', 'introContent: 仅旧形态，最多 12000 字符，可为空', 'coverImageUrl: 已获授权的永久图片 URL，可为空', 'slug: 新建时可选，1–80 字符；更新保持原 slug', 'status: draft(default)/published/archived', 'featured: boolean，默认 false', 'sortOrder: -10000..10000，默认 0', 'listingIds: 仅旧形态，有序 Skill UUID 数组，最多 100；published 不可为空'], responseFields: ['id', 'slug', 'status', 'updatedAt', 'contentMarkdown', 'introContent', 'warnings'] },
  { operationId: 'marketplace.topic.cover', method: 'POST', path: 'topics/cover', scope: 'marketplace:topics:write', description: '复用现有 Picem 内容幂等上传；不发布专题或删除旧图', parameters: [], requestFields: ['mimeType: image/jpeg,image/png,image/webp', 'dataBase64: 1 byte–5 MB'], responseFields: ['url'] },
]

export const AGENT_API_OPERATIONS: readonly AgentApiOperation[] = Object.freeze([
  ...AGENT_API_DEFINITIONS.map((operation) => ({
    ...operation,
    authentication: 'agent-key' as const,
    readOnly: true as const,
    requestFields: [],
    parameters: operation.operationId === 'agent.request' ? ['requestId: 32 位小写十六进制路径参数']
      : operation.scope === 'ops:logs:read'
        ? operation.operationId === 'agent.logs' ? [...DIAGNOSTIC_WINDOW_PARAMETERS, 'cursor: 绑定当前 Key 与查询窗口的下一页游标'] : [...DIAGNOSTIC_WINDOW_PARAMETERS]
        : [],
    errors: operation.scope === 'ops:logs:read' ? [400, 401, 403, 410, 429, 503] : [401, 403, 429, 503],
    retry: '429 按 Retry-After 秒数等待；503 先检查公开 /ready，确认依赖恢复后再试。',
    pagination: operation.operationId === 'agent.migrations' ? '最多最近 50 条；truncated=true 表示还有更早记录，不提供翻页。'
      : operation.operationId === 'agent.logs' ? '默认最近 15 分钟、100 条；最长 24 小时、500 条；nextCursor 绑定 Key。'
        : operation.scope === 'ops:logs:read' ? '只返回有界最近记录；网关最多扫描 4 MiB。' : '无分页；只返回当前固定范围的摘要。',
    timeUnits: '时间戳为 ISO 8601 UTC；uptimeSeconds 和 Retry-After 为秒。',
    example: `const key = process.env.SKILLHUB_AGENT_KEY; const response = await fetch(${JSON.stringify(publicUrl(operation.path.replace(':requestId', '<32-hex-request-id>')))}, { headers: { Authorization: 'Bearer ' + key } });`,
  })),
  ...MARKETPLACE_AGENT_DEFINITIONS.map((operation): AgentApiOperation => ({
    ...operation,
    path: `/api/admin/v1/marketplace/${operation.path}`,
    authentication: 'agent-key', readOnly: operation.method === 'GET',
    source: '现有 Marketplace 业务数据与不可变版本', freshness: '请求时读取或事务写入',
    errors: [400, 401, 403, 404, 409, 413, 428, 429, 503],
    retry: '结果未知先按稳定业务 ID 读回；409 不盲目重写。新建沿用原 ID；专题更新需读回 updatedAt；审核需核对版本、SHA-256 和状态。429 遵守 Retry-After。',
    pagination: operation.path === 'topics' ? 'page 默认 1，pageSize 默认 50、最大 100，nextPage 不为空时继续；专题最多 100 个关联。' : operation.path === 'submissions' ? 'page 默认 1，pageSize 默认 50、最大 100；totalPages 表示总页数。' : '包最大 20 MB，JSON body 最大 30 MB；封面最大 5 MB；包检查沿用服务端完整审核上限。',
    timeUnits: '时间戳/expectedUpdatedAt 为 ISO 8601 UTC；Retry-After 为秒。',
    example: `const key = process.env.SKILLHUB_AGENT_KEY;${operation.method === 'POST' ? '\nconst payload = { /* 按请求字段填写；ID 在首次提交前生成并保存。上传来源示例：profile: { ...其他资料, sourceUrl: \\\"https://github.com/example/skill\\\" }；编辑来源示例：sourceUrl: null, expectedUpdatedAt: \\\"读回时间\\\" */ };' : ''}\nconst response = await fetch(${JSON.stringify(publicUrl(`/api/admin/v1/marketplace/${operation.path.replace(':id', '<uuid>')}`))}, { method: '${operation.method}', headers: { Authorization: 'Bearer ' + key${operation.method === 'POST' ? ", 'Content-Type': 'application/json'" : ''} }${operation.method === 'POST' ? ', body: JSON.stringify(payload)' : ''} });`,
  })),
])

export const ADMIN_KEY_OPERATIONS = Object.freeze([
  { operationId: 'admin.agentKeys.list', method: 'GET', path: '/api/marketplace/admin/agent-keys', auth: 'web-admin-session', description: '列出非秘密 Key 元数据并取得写操作 CSRF 令牌', parameters: ['cursor: 可选 Key UUID，用于读取下一页'], requestFields: [], responseFields: ['keys', 'truncated', 'nextCursor', 'csrfToken', 'availableScopes'], errors: [400, 401, 403, 503], retry: '503 可稍后重试。', pagination: '按创建时间与 ID 倒序，每页最多 100 把；nextCursor 不为空时可读取下一页。', timeUnits: 'createdAt、revokedAt、lastUsedAt 为 ISO 8601 UTC。', example: "await fetch('/api/marketplace/admin/agent-keys?cursor=<nextCursor>', { credentials: 'include' })" },
  { operationId: 'admin.agentKeys.create', method: 'POST', path: '/api/marketplace/admin/agent-keys', auth: 'web-admin-session+csrf', description: '创建 Key；完整秘密只返回一次', parameters: [], requestFields: ['name: 1–80 字符', 'scopes: availableScopes 的非空、不重复子集；ops:logs:read 需同时选 ops:read', 'clientOperationId: UUID', 'X-SkillHub-CSRF', 'Origin'], responseFields: ['key', 'created', 'secretAvailable', 'secret: 仅首次创建响应'], errors: [400, 401, 403, 503], retry: '结果未知时只用同一 clientOperationId 重试；重复创建不会重放 secret。', pagination: '不适用。', timeUnits: '新鲜管理员会话上限 10 分钟；createdAt 为 ISO 8601 UTC。', example: "const csrf = await (await fetch('/api/marketplace/admin/agent-keys', { credentials: 'include' })).json(); await fetch('/api/marketplace/admin/agent-keys', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-SkillHub-CSRF': csrf.csrfToken }, body: JSON.stringify({ name: 'Cloud audit', scopes: ['ops:read'], clientOperationId: crypto.randomUUID() }) })" },
  { operationId: 'admin.agentKeys.revoke', method: 'POST', path: '/api/marketplace/admin/agent-keys/:id/revoke', auth: 'web-admin-session+csrf', description: '幂等撤销 Key', parameters: ['id: Key UUID 路径参数'], requestFields: ['X-SkillHub-CSRF', 'Origin'], responseFields: ['key'], errors: [400, 401, 403, 404, 503], retry: '同一 ID 重复撤销安全；确认结果后再更新云端 secret。', pagination: '不适用。', timeUnits: '新鲜管理员会话上限 10 分钟；revokedAt 为 ISO 8601 UTC。', example: "await fetch('/api/marketplace/admin/agent-keys/<key-id>/revoke', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-SkillHub-CSRF': '<csrf-from-list>' }, body: '{}' })" },
  { operationId: 'admin.agentApiDocs', method: 'GET', path: '/api/marketplace/admin/agent-api-docs', auth: 'web-admin-session', description: '查看当前部署的 API 目录', parameters: [], requestFields: [], responseFields: ['apiVersion', 'baseUrl', 'agentOperations', 'adminOperations', 'existingAdminOperations', 'publicOperations', 'authentication', 'errors'], errors: [401, 403], retry: '读取失败后可刷新；不要把旧页面静态目录当作已部署接口。', pagination: '无分页。', timeUnits: '随当前 Server 版本更新。', example: "await fetch('/api/marketplace/admin/agent-api-docs', { credentials: 'include' })" },
] as const)

export const EXISTING_ADMIN_OPERATIONS = Object.freeze([
  ...['dashboard', 'users', 'listings', 'analytics', 'metrics', 'categories', 'topics', 'comments', 'submissions'].map((resource) => ({ method: 'GET', path: `/api/marketplace/admin/${resource}`, auth: 'web-admin-session', description: '现有商店后台接口；Agent Key 不可调用' })),
  ...[
    ['GET', 'submissions/:id'], ['GET', 'submissions/:id/package'], ['GET', 'submissions/:id/package-inspection'],
    ['POST', 'submissions/:id/start'], ['POST', 'submissions/:id/approve'], ['POST', 'submissions/:id/reject'],
    ['POST', 'skills/publish'], ['GET', 'skills/:id'], ['POST', 'listings/:id/source'],
    ['POST', 'announcements'], ['POST', 'categories'], ['PATCH', 'categories/:id'],
    ['POST', 'topics/save'], ['POST', 'topics/generate'], ['POST', 'topics/cover'],
    ['POST', 'topics'], ['PATCH', 'topics/:id'], ['PUT', 'topics/:id/items'],
    ['PATCH', 'listings/:skillId/editorial'], ['PATCH', 'listings/:skillId/category'], ['PATCH', 'comments/:id'],
  ].map(([method, resource]) => ({ method, path: `/api/marketplace/admin/${resource}`, auth: 'web-admin-session', description: '现有商店后台接口；Agent Key 不可调用' })),
])

export function permittedAgentOperations(scopes: readonly string[]): AgentApiOperation[] {
  return AGENT_API_OPERATIONS.filter((operation) => operation.scope === 'valid-key' || scopes.includes(operation.scope))
}
