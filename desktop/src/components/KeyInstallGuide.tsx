import { useEffect, useState } from 'react'
import { useStore, type LocalSkill } from '../store/index.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { KeyRequirementList, useSkillKeyPolicy } from './SkillKeys.js'
import { canManageSkillAsset } from '../lib/ui-helpers.js'
import {
  KEY_GUIDE_EVENT,
  keyGuideSummary,
  keyRowStatus,
  keyViewerRole,
  rememberKeyGuideShown,
  type KeyGuideRequest,
} from '../lib/skill-keys.js'

/**
 * First-install guide (#255): after a Marketplace or team install that
 * declares keys, one dialog lists every key with its state. All ready →
 * 「已就绪」 and one click to close; keys that need a value are filled inline.
 * It opens once per Skill (remembered locally) and can be reached again from
 * the list badge and the Skill's 「需要的钥匙」 section.
 */
export default function KeyInstallGuide() {
  const [skillId, setSkillId] = useState<string | null>(null)
  const skill = useStore((state) => skillId ? state.skills.find((item) => item.id === skillId) ?? null : null)
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)

  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<KeyGuideRequest | undefined>).detail
      if (!detail?.skillId) return
      rememberKeyGuideShown(detail.skillId)
      setSkillId(detail.skillId)
    }
    window.addEventListener(KEY_GUIDE_EVENT, open)
    return () => window.removeEventListener(KEY_GUIDE_EVENT, open)
  }, [])

  // Another account never inherits an open guide.
  useEffect(() => { setSkillId(null) }, [accountUserId])

  if (!skill || !skill.localPath || skill.envDeps.length === 0) return null
  return <KeyInstallGuideDialog skill={skill} onClose={() => setSkillId(null)} />
}

function KeyInstallGuideDialog({ skill, onClose }: { skill: LocalSkill; onClose: () => void }) {
  const currentUser = useStore((state) => state.currentUser)
  const replaceSkill = useStore((state) => state.replaceSkill)
  const policy = useSkillKeyPolicy(skill)
  const role = keyViewerRole({ canManage: canManageSkillAsset(skill), signedIn: Boolean(currentUser), teamSkill: skill.acquisitionSource === 'team' || Boolean(skill.teamSharedFrom) })
  const statuses = skill.envDeps.map((dependency) => keyRowStatus(
    policy.rows.find((row) => row.key === dependency.key),
    policy.loading && policy.rows.length === 0,
    Boolean(policy.error),
  ))
  const summary = keyGuideSummary(statuses)
  const title = `「${skill.displayName}」需要的钥匙`

  return <FocusTrapDialog className="modal-layer above-sheet" label={title} onEscape={onClose}>
    <div className="modal-card key-guide-card">
      <div className="modal-head">
        <div><span className="eyebrow">安装完成</span><h2>{title}</h2></div>
        <button type="button" className="ico-btn" onClick={onClose} aria-label="关闭钥匙引导"><Icon name="x" size={16} /></button>
      </div>
      <p className={`key-guide-summary${summary.allReady ? ' ready' : ''}`} role="status">
        {summary.allReady && <Icon name="check" size={14} />}
        {policy.loading && policy.rows.length === 0 ? '正在检查钥匙…' : policy.error ? '钥匙状态读取失败' : summary.title}
        {policy.error && <button type="button" className="link-button" onClick={policy.reload}>重试</button>}
      </p>
      <KeyRequirementList skill={skill} role={role} policy={policy} replaceSkill={(updated) => replaceSkill(skill.id, updated)} variant="guide" />
      <div className="modal-actions">
        {summary.allReady
          ? <button type="button" className="btn btn-primary" onClick={onClose}>完成</button>
          : <button type="button" className="btn btn-ghost" onClick={onClose}>稍后再说</button>}
      </div>
    </div>
  </FocusTrapDialog>
}
