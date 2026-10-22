import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { EMPTY_COPY } from '../src/lib/state-copy.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const page = readFileSync(resolve(desktopRoot, 'src/pages/MarketplacePage.tsx'), 'utf8')
const styles = readFileSync(resolve(desktopRoot, 'src/pages/MarketplacePage.css'), 'utf8')
const store = readFileSync(resolve(desktopRoot, 'src/store/index.ts'), 'utf8')
const card = readFileSync(resolve(desktopRoot, 'src/components/SkillCard.tsx'), 'utf8')
const api = readFileSync(resolve(desktopRoot, 'src/lib/api.ts'), 'utf8')
const sidebar = readFileSync(resolve(desktopRoot, 'src/components/Sidebar.tsx'), 'utf8')
const storeUi = readFileSync(resolve(desktopRoot, 'src/components/store/StoreUI.tsx'), 'utf8')
const storeCss = readFileSync(resolve(desktopRoot, 'src/components/store/StoreUI.css'), 'utf8')
const storeFeed = readFileSync(resolve(desktopRoot, 'src/components/store/StoreFeed.tsx'), 'utf8')

test('Marketplace loads a real public catalog without gating guest browsing', () => {
  assert.match(page, /apiGetMarketplace\(\{/)
  assert.match(page, /apiGetMarketplaceSkill\(skill\.serverId\)/)
  assert.match(page, /getLocalSkills\(\)/)
  assert.match(page, /mergeMarketplaceSkill/)
  assert.doesNotMatch(page, /mock|demo|即将上线/i)
  assert.match(api, /preserveSessionOn401: true/)
})

test('Marketplace supports search, stable Skill directories, sorting, filters and card/list views', () => {
  assert.match(page, /aria-label="搜索 Skill 商店"/)
  assert.match(page, /const MARKETPLACE_DIRECTORIES =/)
  assert.match(page, /\{ value: '协作与办公', label: '办公' \}/)
  assert.match(page, /\{ value: '开发与工程', label: '编程' \}/)
  assert.match(page, /setKnownCategories/)
  // Phase 2: 场景分类 options come from /marketplace/categories, with the page facet and directories as fallback.
  assert.match(page, /result\.categories\?\.length/)
  assert.match(page, /apiGetMarketplaceCategories\(\)/)
  assert.match(api, /categories\?: string\[\]/)
  assert.match(page, /aria-label="Skill 商店目录"/)
  // The Agent filter is back per #209 §C, built only from the platform's detected agents (never AGENT_KEYS).
  assert.match(page, /\{ id: 'agent', label: 'Agent', value: catalog\.agent, options: \[\{ value: '', label: '所有 Agent' \}/)
  assert.match(page, /agentCapabilities\.map\(\(agent\) => agent\.key\)/)
  assert.match(page, /visibleReviewCompatibleAgents/)
  assert.doesNotMatch(page, /import \{[^}]*AGENT_KEYS/)
  // Sort tabs replaced 按最新 / 按热门 with the five design-system sorts.
  assert.match(storeFeed, /role="radiogroup" aria-label="Skill 商店排序"/)
  assert.match(page, /sorts=\{visibleSorts\(capabilities\)\}/)
  assert.match(page, /apiGetMarketplaceHome/)
  assert.match(page, />精选专题</)
  // 「查看全部」 from 精选 Skills presets 全部技能 to featured listings only.
  assert.match(page, /openCatalog\(\{ featured: true, sort: 'popular' \}\)/)
  assert.match(page, /type MarketplaceView = 'card' \| 'list'/)
  assert.match(page, /skillhub:marketplace-view/)
  assert.match(storeFeed, /aria-label="卡片视图"/)
  assert.match(storeFeed, /aria-label="列表视图"/)
  // The topic page keeps the existing card / row rendering.
  assert.match(page, /marketplace-skill-list/)
  // Page-number pagination was replaced by the lazy feed (加载更多 / 已显示全部).
  assert.doesNotMatch(page, /aria-label="Skill 商店分页"/)
})

test('Marketplace shows the filtered count and refreshes when its sidebar entry is selected', () => {
  // The count is now the 「共 N 个」 title line fed by the feed snapshot.
  assert.match(page, /if \(snapshot\.total !== null\) setTotal\(snapshot\.total\)/)
  assert.match(page, /· 共 <span className="tsh-num">\{formatStoreCount\(total\)\}<\/span> 个/)
  assert.match(page, /skillhub:refresh-marketplace/)
  assert.match(page, /else if \(mode === 'catalog'\) setCatalogRefresh\(\(value\) => value \+ 1\)/)
  assert.match(sidebar, /item\.view === 'marketplace'.*skillhub:refresh-marketplace/)
  assert.doesNotMatch(page, /刷新 Skill 商店/)
  assert.doesNotMatch(page, /<h2>公开 Skill<\/h2>/)
  assert.doesNotMatch(page, /className="marketplace-intro"/)
})

test('Marketplace keeps public, author, and admin surfaces separate and fully stateful', () => {
  // Tabs come from storeTabs (首页 / 全部技能 / 我的 / 审核队列); 「我的」 is the former 我的提交 panel.
  assert.match(page, /storeTabs\(\{ signedIn: Boolean\(currentUser\), admin: isMarketplaceAdmin \}\)/)
  assert.match(page, /<h2>我的提交<\/h2>/)
  assert.match(page, /item\.listing/)
  assert.match(page, /item\.latestSubmission/)
  assert.match(page, /apiWithdrawMarketplaceSubmission/)
  assert.match(page, /apiUnpublishMarketplaceSkill/)
  assert.match(page, /apiStartMarketplaceReview/)
  assert.match(page, /apiApproveMarketplaceSubmission/)
  assert.match(page, /apiRejectMarketplaceSubmission/)
  assert.match(page, /apiGetMarketplaceAdminSubmission\(submissionId\)/)
  assert.match(page, /apiGetMarketplacePackageInspection\(submissionId\)/)
  assert.match(page, /packageInspection\.versionId !== detail\.version\.id/)
  assert.match(page, /reviewPackage\.packageSha256/)
  assert.match(page, /固定安装包文件树/)
  assert.match(page, /二进制文件不回传内容/)
  assert.match(page, /reviewPackageChecked/)
  assert.match(page, /!reviewPackage \|\| !reviewPackageChecked/)
  assert.match(page, /disabled=\{Boolean\(reviewBusyId\) \|\| !reviewPackage \|\| !reviewPackageChecked\}/)
  assert.match(page, /我已检查 SHA-256/)
  assert.match(page, /'查看内容'/)
  assert.match(page, /reviewDetail\.snapshot\.skillMd/)
  assert.match(page, /reviewDetail\.snapshot\.envDependencies/)
  assert.match(page, /reviewDetail\.submitterNote/)
  assert.match(page, /aria-label="审核队列分页"/)
  assert.match(page, /REVIEW_PAGE_SIZE/)
  assert.match(api, /pageSize: String\(pageSize\)/)
  assert.match(page, /Marketplace 固定版本审核/)
  assert.match(api, /\/marketplace\/admin\/submissions\/\$\{encodeURIComponent\(submissionId\)\}/)
  assert.match(api, /\/package-inspection/)
  // Catalog loading / failure / empty copy moved to the design-system feed (skeletons, 加载失败 + 重试, 没有找到相关技能).
  // The sentences come from lib/state-copy.ts (#263).
  assert.match(storeFeed, /\{LOAD_FAILED_TITLE\}<button/)
  assert.match(storeFeed, /<strong>\{EMPTY_COPY\.storeNoResults\.title\}<\/strong>\{EMPTY_COPY\.storeNoResults\.hint\}/)
  assert.deepEqual(EMPTY_COPY.storeNoResults, { title: '没有找到相关技能', hint: '换个关键词，或清除筛选条件再试试。' })
})

test('Marketplace clears and render-gates private author and reviewer state on account changes', () => {
  assert.match(page, /const privilegeScope = `\$\{currentUser\?\.id \?\? 'guest'\}:\$\{isMarketplaceAdmin \? 'admin' : 'user'\}`/)
  assert.match(page, /const privilegedStateIsCurrent = privilegedStateScope === privilegeScope/)
  assert.match(page, /accountGenerationRef\.current \+= 1/)
  assert.match(page, /mineGenerationRef\.current \+= 1/)
  assert.match(page, /reviewGenerationRef\.current \+= 1/)
  assert.match(page, /reviewDetailGenerationRef\.current \+= 1/)
  assert.match(page, /setMineItems\(\[\]\)/)
  assert.match(page, /setReviewItems\(\[\]\)/)
  assert.match(page, /setReviewDetail\(null\)/)
  assert.match(page, /setReviewPackage\(null\)/)
  assert.match(page, /setRejecting\(null\)/)
  assert.match(page, /mode === 'mine' && privilegedStateIsCurrent && currentUser/)
  assert.match(page, /mode === 'review' && privilegedStateIsCurrent && isMarketplaceAdmin/)
  assert.match(page, /reviewDetailId && privilegedStateIsCurrent && isMarketplaceAdmin/)
  assert.match(page, /accountGeneration !== accountGenerationRef\.current/)
})

test('Marketplace detail remains usable when the local Skill scan is unavailable', () => {
  assert.match(page, /const \[detailResult, localResult\] = await Promise\.allSettled/)
  assert.match(page, /if \(detailResult\.status === 'rejected'\) throw detailResult\.reason/)
  assert.match(page, /localResult\.status === 'fulfilled'/)
  assert.match(page, /useStore\.getState\(\)\.skills\.filter\(\(candidate\) => Boolean\(candidate\.localPath\)\)/)
  assert.match(page, /openSkillSheet\(merged\.id, 'profile', action\)/)
})

test('Marketplace catalog identity never contaminates My Skills state', () => {
  assert.match(store, /marketplaceSkills: LocalSkill\[\]/)
  assert.match(store, /setMarketplaceSkills/)
  assert.match(store, /resolveSkillFromSources/)
  assert.match(page, /marketplaceSkills/)
  const outsideAcquisition = page.replace(/  const joinMySkills =[\s\S]*?  const renderCatalogSkills =/, '')
  assert.doesNotMatch(outsideAcquisition, /setSkills\(/)
  assert.match(card, /context\?: 'library' \| 'marketplace'/)
  assert.match(card, /isMarketplace\s*\?\s*skill\.authorName/)
  assert.match(card, /title="安装量"/)
  assert.match(card, /title="正在使用"/)
})

test('Marketplace keeps its compact blue controls while featured topics use readable cover art', () => {
  assert.match(styles, /background: var\(--color-surface\)/)
  assert.match(styles, /background: var\(--color-brand-tint\)/)
  assert.match(styles, /color: var\(--color-brand\)/)
  // The old cover-art topic card (blurred, masked ::after) is gone (ex-#183); the topic hero keeps one plain gradient layer.
  assert.doesNotMatch(styles, /\.marketplace-topic-card/)
  assert.match(styles, /\.marketplace-topic-hero::before\s*\{/)
  assert.match(storeCss, /prefers-reduced-motion: reduce/)
  assert.match(styles, /@media \(max-width: 720px\)/)
  assert.match(styles, /\.marketplace-catalog-controls\s*\{[^}]*margin-left: auto;/s)
  assert.match(styles, /\.marketplace-directory\s*\{/)
  assert.doesNotMatch(styles, /\.marketplace-agent-filter\s*\{/)
  assert.doesNotMatch(styles, /\.marketplace-intro\s*\{/)
})

test('the topic page uses the pastel design hero and keeps its full introduction', () => {
  assert.match(api, /export type ApiMarketplaceTopic = \{[^}]*introContent\?: string \| null/s)
  // #230: the hero follows the article design — lilac tone, mint and blush glows, dark ink, no cover image.
  assert.doesNotMatch(page, /TopicArtwork|coverImageUrl/)
  assert.match(page, /<span className="marketplace-topic-art" aria-hidden="true" \/>/)
  assert.match(page, /<span className="marketplace-topic-kicker">精选专题<\/span>/)
  assert.match(styles, /\.marketplace-topic-hero \{[^}]*min-height: 340px;[^}]*background: var\(--color-logo-lilac\);[^}]*color: var\(--color-on-pastel\);/s)
  assert.match(styles, /\.marketplace-topic-art \{[^}]*var\(--color-logo-mint\)[^}]*var\(--color-logo-blush\)/s)
  assert.match(styles, /\.marketplace-topic-hero h2 \{[^}]*font-size: 36px; line-height: 44px; font-weight: 780;/)
  assert.match(styles, /@media \(max-width: 900px\) \{\s*\.marketplace-topic-hero \{[^}]*min-height: 220px;/)
  // ex-#183: plain positive layers only.
  assert.doesNotMatch(styles, /\.marketplace-topic-[a-z-]+[^{]*\{[^}]*(backdrop-filter|mask|z-index: -)/)
  assert.doesNotMatch(styles, /\.marketplace-topic-hero-content \{[^}]*text-shadow/)
  assert.match(page, /topic\.introContent && <p className="marketplace-topic-intro"/)
  assert.match(page, />返回首页</)
  // The two-line clamp belonged to the removed cover-art card copy; topic cards now clamp in StoreUI.css.
  assert.match(storeCss, /\.tsh-topic-desc \{[^}]*-webkit-line-clamp: 2;/)
})

test('精选专题 is a 1/3-width TopicCarousel of logo-palette TopicCards with arrows only when overflowing', () => {
  // Home cards are design-system TopicCards (tone tiles + avatar stack), no blurred cover overlay (#183).
  assert.match(page, /homeTopics\.map\(\(topic, index\) => <TopicCard key=\{topic\.id \|\| topic\.slug\} topic=\{topic\} tone=\{topicTone\(index\)\}/)
  assert.doesNotMatch(page, /homeTopics\.slice\(0, 4\)/)
  assert.match(storeUi, /\{topic\.items\.length\} 个 Skill<StoreIcon name="arrow-right"/)
  assert.match(storeUi, /\{edges\.overflow && <div className="tsh-carousel-nav">/)
  assert.match(storeUi, /aria-label="上一个" disabled=\{edges\.atStart\}/)
  assert.match(storeUi, /aria-label="下一个" disabled=\{edges\.atEnd\}/)
  assert.match(storeCss, /\.tsh-carousel-track > \* \{ flex: 0 0 calc\(\(100% - 32px\) \/ 3\);/)
  assert.doesNotMatch(storeCss, /backdrop-filter/)
})

test('list rows put store badges and editorial labels beside the name and the other name on the next line', () => {
  const row = page.slice(page.indexOf('function MarketplaceSkillRow('), page.indexOf('export default function MarketplacePage()'))
  // Line 1 holds the primary name, the store badges and the editorial labels (without a repeated 精选), in that order.
  assert.match(row, /<span className="marketplace-skill-row-title"><strong[^>]*>\{title\.primary\}<\/strong><MarketplaceBadges badges=\{skill\.marketplaceBadges\} \/><EditorialLabels labels=\{editorialLabelsBesideBadges\(skill\.marketplaceEditorialLabels, skill\.marketplaceBadges\)\} limit=\{2\}\/><\/span>/)
  // Line 2 is only the secondary name, so a Skill without one stays one line tall.
  assert.match(row, /<\/span>\s*\n\s*\{title\.secondary && <small[^>]*>\{title\.secondary\}<\/small>\}\s*\n\s*<\/span>/)
  assert.equal(row.match(/<EditorialLabels/g)?.length, 1)
  // The name truncates first; labels never wrap onto a line of their own and fold into +N when narrow.
  assert.match(styles, /\.marketplace-skill-row-title \{[^}]*display: flex;[^}]*container: marketplace-row-title \/ inline-size;/)
  assert.match(styles, /\.marketplace-skill-row-title > \.editorial-labels \{[^}]*flex: none;[^}]*container-type: normal;/)
  assert.match(styles, /\.marketplace-skill-row-title \.editorial-label-line \{ flex-wrap: nowrap; \}/)
  assert.match(styles, /@container marketplace-row-title \(max-width: 380px\) \{[^@]*\.editorial-more\.narrow \{ display: inline-flex; \}/)
  assert.doesNotMatch(styles, /\.marketplace-skill-row-name > \.editorial-labels/)
})
