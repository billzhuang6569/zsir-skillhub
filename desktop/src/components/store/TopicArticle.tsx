import { useCatalogOffline } from '../../lib/use-catalog-offline.js'
import { CATALOG_INSTALL_OFFLINE } from '../../lib/catalog-cache.js'
// Desktop topic article (#213, design §4.2 / §4.4): a 680px text column with the body's
// Markdown fragments, and the embedded Skill groups as the existing store cards — one
// Skill as a full-width row card, 2–3 as a grid — so 安装 / 已加入 / 更新 go through the
// page's existing join flow. A referenced Skill that is no longer public shows the
// 「此 Skill 已下架」 placeholder. Links never navigate the webview: the caller opens
// web links in the system browser.
import { useMemo, type MouseEvent } from 'react'
import type { LocalSkill } from '../../store/index.js'
import type { TopicArticle } from '../../lib/topic-article.js'
import { renderTopicMarkdown } from '../../lib/markdown.js'
import { useMediaContext } from '../../lib/media.js'
import { articleSkills, INSTALL_ALL_TEXT, installAllPlan, type InstallAllResult } from '../../lib/topic-install.js'
import { Icon } from '../Icon.js'
import { StoreSkillCard, StoreSkillRow } from './StoreUI.js'
import './TopicArticle.css'

export function MissingTopicSkill() {
  return <div className="tsh-article-missing" aria-disabled="true">
    <span className="tsh-article-missing-avatar" aria-hidden="true"><Icon name="x" size={18} /></span>
    <span><strong>此 Skill 已下架</strong><small>作者或商店管理员已把它从商店移除。</small></span>
  </div>
}

function MarkdownFragment({ source, onLink }: { source: string; onLink: (href: string) => void }) {
  const media = useMediaContext()
  const html = useMemo(() => renderTopicMarkdown(source, media), [source, media])
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    // Never let a link navigate the webview; the page opens web links in the system browser.
    event.preventDefault()
    onLink(anchor.getAttribute('href') ?? '')
  }
  // markdown-it with html:false: author text is escaped; only the renderer's own tags are emitted.
  return <div className="tsh-article-prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

type Props = {
  article: TopicArticle
  skills: ReadonlyMap<string, LocalSkill>
  busyId: string | null
  onOpen: (skill: LocalSkill) => void
  onInstall: (skill: LocalSkill) => void
  onLink: (href: string) => void
  installAll: { running: boolean; results: Readonly<Record<string, InstallAllResult>> }
  onInstallAll: () => void
}

export function TopicArticleBody({ article, skills, busyId, onOpen, onInstall, onLink, installAll, onInstallAll }: Props) {
  const offlineAt = useCatalogOffline()
  const listed = articleSkills(article, skills)
  const item = (skill: LocalSkill) => ({ skill, busy: busyId === skill.id, onOpen: () => onOpen(skill), onInstall: () => onInstall(skill) })
  const installable = listed.filter(skill => installAllPlan(skill) === 'install').length
  return <div className="tsh-article" data-topic-article="true">
    {article.segments.length === 0 && <div className="tsh-article-prose"><p>正文还是空的。</p></div>}
    {article.segments.map((segment, index) => {
      if (segment.kind === 'markdown') return <MarkdownFragment key={`m${index}`} source={segment.source} onLink={onLink} />
      return <div key={`s${segment.key}`} className={`tsh-article-cards is-${segment.ids.length}`}>
        {segment.ids.map(id => {
          const skill = skills.get(id)
          if (!skill) return <MissingTopicSkill key={id} />
          return segment.ids.length === 1 ? <StoreSkillRow key={id} {...item(skill)} /> : <StoreSkillCard key={id} {...item(skill)} />
        })}
      </div>
    })}
    {listed.length > 0 && <section className="tsh-article-end" aria-label="全部安装">
      <div>
        <strong>把这 {listed.length} 个 Skill 一次装好</strong>
        <p>逐个加入我的 Skills；已加入的跳过，有更新的请在卡片上单独确认。</p>
      </div>
      <button type="button" className="tsh-btn tsh-btn-primary" title={offlineAt ? CATALOG_INSTALL_OFFLINE : undefined} disabled={Boolean(offlineAt) || installAll.running || installable === 0} onClick={onInstallAll}>
        <Icon name="download" size={14} />{installAll.running ? '正在安装…' : installable === 0 ? '都已加入' : '全部安装'}
      </button>
      {Object.keys(installAll.results).length > 0 && <ul className="tsh-article-results" aria-live="polite">
        {listed.filter(skill => installAll.results[skill.id]).map(skill => <li key={skill.id} data-result={installAll.results[skill.id]}>
          <span>{skill.name}</span><em>{INSTALL_ALL_TEXT[installAll.results[skill.id]!]}</em>
        </li>)}
      </ul>}
    </section>}
  </div>
}
