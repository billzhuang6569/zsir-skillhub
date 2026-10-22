/**
 * 空态 / 错误态 / 加载态的标准文案（Tan Skillhub Design System「Empty and error copy」，#263）。
 *
 * - 空态：标题说明发生了什么，提示说明下一步（例如「没有找到相关技能」+「换个关键词，或清除筛选条件再试试。」）。
 * - 错误态：「<对象>加载失败」+ 原因，并始终配一个「重试」。
 * - 加载态：用与布局匹配的骨架屏，读屏文字用 `LOADING_COPY`，不显示 spinner。
 *
 * 页面不再内联这些句子，统一从这里取，`tests/states-motion.test.ts` 会检查。
 */

export type StateCopy = { readonly title: string; readonly hint: string }

export const RETRY_LABEL = '重试'
export const CLEAR_FILTERS_LABEL = '清除筛选'
export const LOAD_FAILED_TITLE = '加载失败'

/** 「<对象>加载失败」，有原因时追加「：原因」。对象为空时只说「加载失败」。 */
export function loadFailedMessage(subject: string, reason?: string | null): string {
  const head = `${subject}${LOAD_FAILED_TITLE}`
  const detail = reason?.trim()
  return detail ? `${head}：${detail}` : head
}

export const EMPTY_COPY = {
  // 我的 Skills
  skillsLibrary: { title: 'SkillHub 中还没有 Skill', hint: '导入包含 SKILL.md 的文件夹或 ZIP，建立可安装、可共享、可追踪版本的真实资产。' },
  skillsNoMatch: { title: '没有匹配的 Skill', hint: '换个关键词，或清除筛选条件再试试。' },
  skillsTeamScope: { title: '没有正在团队共享的 Skill', hint: '在 Skill 详情的「共享」中选择团队，共享后会显示在这里。' },
  localNoMatch: { title: '没有匹配的本地 Skill', hint: '换个关键词，或切换 Agent 工具再试试。' },
  localNone: { title: '没有散落的本地 Skill', hint: '已检测到的 AI 工具目录里没有未被 SkillHub 管理的 Skill，新放入的会自动出现在这里。' },
  localPreview: { title: '选择一个本地 Skill', hint: '在左侧查看 Agent 中尚未纳入 SkillHub 管理的 Skill。' },

  // 团队
  teamSignedOut: { title: '登录后查看团队共享', hint: '团队 Skill 与成员权限来自真实账号，登录后会自动恢复最近使用的团队。' },
  teamNone: { title: '还没有可用团队', hint: '创建或加入团队后，共享的 Skill 会在这里形成团队自己的安装目录。' },
  teamSharedUnavailable: { title: '暂时无法确认团队共享列表', hint: '本机已有内容不会被删除。检查网络后点「重试」即可恢复完整列表。' },
  teamSharedNone: { title: '这个团队还没有共享 Skill', hint: '团队成员完成共享后，Skill 会自动出现在这里。' },
  teamsOwnedNone: { title: '还没有创建团队', hint: '创建团队后可以真实共享 Skill、审批成员并管理团队信息。' },
  teamsJoinedNone: { title: '还没有加入其他团队', hint: '向团队 Owner 要团队 ID，即可申请加入。' },
  teamDetailSkillsNone: { title: '尚未共享 Skill', hint: '从 Skills 卡片的分享按钮选择此团队即可加入。' },
  teamDetailNotificationsNone: { title: '暂无团队通知', hint: '系统消息和成员申请会出现在这里。' },

  // Skill 商店
  storeNoResults: { title: '没有找到相关技能', hint: '换个关键词，或清除筛选条件再试试。' },
  storeTopicNone: { title: '这个专题暂时没有可用的 Skill', hint: '回到商店首页看看其他专题和精选 Skill。' },
  storeMineNone: { title: '还没有 Marketplace 提交', hint: '在“我的 Skills”中打开一个 Skill，即可从共享区提交审核。' },
  storeReviewNone: { title: '当前状态下没有提交', hint: '新的作者提交会自动进入待审核队列。' },

  // Skill 详情抽屉
  sheetVersionsNone: { title: '暂无版本记录', hint: '修改 Skill 内容后即可创建第一个版本记录。' },
  sheetVersionsNoneReadOnly: { title: '暂无版本记录', hint: '作者创建新版本后会显示在这里。' },
  sheetDiffNone: { title: '没有检测到可保存的内容差异', hint: '修改 Skill 文件后再创建版本。' },
  sheetShareNoTeams: { title: '还没有可共享的团队', hint: '创建或加入团队后可以共享。' },
  sheetDiscussionNone: { title: '还没有讨论', hint: '在下方写下第一条评论。' },
  sheetTreeEmpty: { title: '文件夹为空', hint: '在 Skill 文件夹中添加文件后，这里会自动列出。' },
  sheetTreeRemote: { title: '还没有下载到本机', hint: '安装到本机后可查看完整文件结构。' },
  installNoAgents: { title: '本机未检测到可安装的 Agent 工具', hint: '请先安装或完成工具配置，再回来安装。' },

  // 通知浮层
  notificationsNone: { title: '暂无通知', hint: '团队申请、审核结果和系统消息会出现在这里。' },

  // 钥匙
  keysNone: { title: '还没有钥匙', hint: '安装需要钥匙的 Skill 后，在它的详情里填写，这里就会出现。' },
} as const satisfies Record<string, StateCopy>

/** 加载态的读屏文字（视觉上是骨架屏）。 */
export const LOADING_COPY = {
  skills: '正在读取 SkillHub 与 Agent 本地目录…',
  teams: '正在读取真实团队数据…',
  teamShared: '正在读取真实团队和共享 Skill…',
  teamSharedSkills: '正在合并团队资产与本机安装状态…',
  teamDetail: '正在读取团队信息…',
  storeMine: '正在读取您的提交…',
  storeReview: '正在读取审核队列…',
  storeReviewDetail: '正在读取不可变快照和固定安装包…',
  topicArticle: '正在读取专题正文…',
  sheetSource: '正在读取 SKILL.md…',
  sheetFile: '正在读取文件…',
  sheetVersions: '正在读取版本记录…',
  sheetDiff: '正在读取版本区别…',
  sheetTree: '正在读取文件结构…',
  sheetDiscussion: '正在读取讨论…',
  installAgents: '正在检测本机 Agent…',
  keys: '正在读取钥匙…',
} as const
