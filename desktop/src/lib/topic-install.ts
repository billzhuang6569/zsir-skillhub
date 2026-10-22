// Pure helpers for the desktop topic article (#213): which store Skill an embed shows, and
// what 全部安装 does with each one. The page runs the actual join through joinMySkills.
import type { LocalSkill } from '../store/index.js'
import { marketplaceAction } from './marketplace-state.ts'
import type { TopicArticle } from './topic-article.ts'

export type InstallAllResult = 'running' | 'done' | 'failed' | 'joined' | 'needs-update' | 'stopped'
export const INSTALL_ALL_TEXT: Record<InstallAllResult, string> = {
  running: '安装中…', done: '已加入', failed: '安装失败', joined: '已在我的 Skills', 'needs-update': '有更新，请单独确认', stopped: '已停止（账号已切换）',
}

/** 全部安装 installs a Skill, or skips it because it is already joined / its update needs its own confirmation. */
export function installAllPlan(skill: LocalSkill): 'install' | 'joined' | 'needs-update' {
  const action = marketplaceAction(skill)
  if (action.update) return 'needs-update'
  return action.joined ? 'joined' : 'install'
}

/** Store Skills by lowercase listing id (= Skill.serverId); an embed id that is missing here is withdrawn or unknown. */
export function topicSkillMap(skills: readonly LocalSkill[]): Map<string, LocalSkill> {
  return new Map(skills.flatMap(skill => skill.serverId ? [[skill.serverId.toLowerCase(), skill] as const] : []))
}

/** The article's public Skills in first-occurrence order (the 全部安装 list). */
export function articleSkills(article: TopicArticle, skills: ReadonlyMap<string, LocalSkill>): LocalSkill[] {
  return article.skillIds.flatMap(id => { const skill = skills.get(id); return skill ? [skill] : [] })
}
