/**
 * Agent profiles page (components/settings/workflows/AgentProfilesView +
 * agentProfileGroups). Keys: `settings.agentProfiles.*`.
 *
 * Deliberately separate from the `profile*` keys under `settings.workflows.*`:
 * those live on the canvas and the node inspector ("Save as profile", "Apply a
 * profile…"), this batch lives only on this page.
 */
export const en = {
  // ── tab + left column ──
  "settings.workflows.tabProfiles": "Agent profiles",
  "settings.agentProfiles.byType": "By node type",
  "settings.agentProfiles.draftBadge": "unsaved",

  // ── right column ──
  "settings.agentProfiles.emptyGroup": "No profiles under this type yet.",
  "settings.agentProfiles.newInGroup": "New profile of this type",
  "settings.agentProfiles.brokenFiles": "{n} profile files could not be read",
} as const;
