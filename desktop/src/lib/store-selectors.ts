import type { SkillHubStore as AppState } from '../store/index.js'

/**
 * Field selectors for the hottest components. Each returns a flat object of
 * exactly the store fields the component reads; paired with `useShallow`,
 * an unrelated store update (search text, a toast, env readiness of another
 * Skill) is shallow-equal and does not re-render the subscriber. The
 * selectors are pure so tests can pin that property deterministically.
 */
export function selectSkillCardState(state: AppState) {
  return {
    openSkillSheet: state.openSkillSheet,
    teams: state.teams,
    setSkills: state.setSkills,
    replaceSkill: state.replaceSkill,
    activeTeamId: state.activeTeamId,
    currentUser: state.currentUser,
    promptForAuth: state.promptForAuth,
    skillTitlePreference: state.skillTitlePreference,
  }
}

export function selectSkillLibraryListState(state: AppState) {
  return {
    sheet: state.sheet,
    openSkillSheet: state.openSkillSheet,
    currentUser: state.currentUser,
    teams: state.teams,
    agentCapabilities: state.agentCapabilities,
    skillTitlePreference: state.skillTitlePreference,
  }
}

export function selectSkillDetailSheetState(state: AppState) {
  return {
    skills: state.skills,
    marketplaceSkills: state.marketplaceSkills,
    setSkills: state.setSkills,
    setMarketplaceSkills: state.setMarketplaceSkills,
    replaceSkill: state.replaceSkill,
    closeSheet: state.closeSheet,
    setSheetTab: state.setSheetTab,
    currentUser: state.currentUser,
    promptForAuth: state.promptForAuth,
    teams: state.teams,
    activeTeamId: state.activeTeamId,
    view: state.view,
  }
}
