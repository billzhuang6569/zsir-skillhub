import { useState } from 'react'
import { useStore, type LocalSkill, type Team } from '../store/index.js'
import { apiUnshareSkill, ApiError, sameSpace } from '../lib/api.js'
import { userMessage } from '../lib/user-message.js'
import ConfirmModal from './ConfirmModal.js'
import { toast } from './Toast.js'

export default function UnshareSkillDialog({ skill, team, onClose }: { skill: LocalSkill; team: Team; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const confirm = async (): Promise<void> => {
    const { activeSpace, currentUser } = useStore.getState()
    if (!navigator.onLine) { toast('当前离线，请联网后取消共享', 'error'); return }
    if (!activeSpace || !currentUser || !skill.serverId || busy) return
    setBusy(true)
    const current = (): boolean => sameSpace(activeSpace, useStore.getState().activeSpace)
      && currentUser.id === useStore.getState().currentUser?.id
    try {
      await apiUnshareSkill(skill.serverId, team.id, activeSpace)
      if (!current()) return
      const state = useStore.getState()
      state.setSkills(state.skills.map(item => {
        if (item.serverId !== skill.serverId) return item
        const sharedTo = { ...item.sharedTo }
        delete sharedTo[team.id]
        return { ...item, sharedTo }
      }))
      state.setTeamSkills(team.id, (state.teamSkills[team.id] ?? []).filter(item => item.serverId !== skill.serverId), null)
      if (state.sheet?.kind === 'skill' && state.sheet.skillId === skill.id) state.closeSheet()
      window.dispatchEvent(new CustomEvent('skillhub:refresh-team-shares', { detail: { unsharedTeamId: team.id, unsharedSkillId: skill.serverId } }))
      toast(`已从「${team.name}」取消共享`)
      onClose()
    } catch (error: unknown) {
      if (!current()) return
      toast(error instanceof ApiError && error.status === 403 ? '无法取消共享：作者身份或团队权限已变化'
        : error instanceof ApiError && error.status === 404 ? '该 Skill 已取消共享或已删除' : userMessage(error), 'error')
      window.dispatchEvent(new Event('skillhub:refresh-team-shares'))
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return <ConfirmModal title={`从「${team.name}」取消共享「${skill.name}」？`}
    description="团队成员将无法再安装，也不会再收到更新；已经安装的成员会保留现有副本，但这个 Skill 运行时不再使用团队钥匙；你自己的 Skill 不受影响，之后可以重新共享。"
    confirmLabel="取消共享" destructive busy={busy} onCancel={onClose} onConfirm={() => void confirm()} />
}
