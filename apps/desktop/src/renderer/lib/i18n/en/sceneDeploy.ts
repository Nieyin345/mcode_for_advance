/**
 * Scene deployment (Settings → Scene deploy). Keys: `sceneDeploy.*`.
 * The zh catalog is the MessageId source; this must cover every key it declares.
 */
export const en = {
  /* ── nav + page ── */
  "sceneDeploy.nav": "Scene deploy",
  "sceneDeploy.title": "Scene deploy",
  "sceneDeploy.intro":
    "Paste a scene declaration (SceneSpec), see what it will build and in what order, which steps won't run, then approve and deploy. Approval is for exactly this plan — change one byte of the declaration after approving and the grant is void, so preview and approve again.",

  /* ── declaration input ── */
  "sceneDeploy.specLabel": "Scene declaration (SceneSpec, JSON)",
  "sceneDeploy.specPlaceholder": "Paste a SceneSpec's JSON here…",
  "sceneDeploy.specHint": "A declaration only says what you want — no credentials or absolute paths. The host decides actual execution against its capability inventory after you approve.",

  /* ── action buttons ── */
  "sceneDeploy.preview": "Preview",
  "sceneDeploy.previewing": "Previewing…",
  "sceneDeploy.approve": "Approve",
  "sceneDeploy.approving": "Approving…",
  "sceneDeploy.deploy": "Deploy",
  "sceneDeploy.deploying": "Deploying…",
  "sceneDeploy.reset": "Clear",

  /* ── stage hints ── */
  "sceneDeploy.stage.empty": "Paste a declaration, then click Preview.",
  "sceneDeploy.stage.approved": "This plan is approved (grant valid until {expiresAt}). Click Deploy to run it.",
  "sceneDeploy.stage.approvedExpired": "The approval grant has expired — preview and approve again.",
  "sceneDeploy.stage.needsApproval": "After reviewing the plan, click Approve — nothing runs without a grant.",
  "sceneDeploy.emptySpec": "Paste a declaration first.",
  "sceneDeploy.invalidJson": "This text is not valid JSON: {message}",

  /* ── plan preview ── */
  "sceneDeploy.deploymentId": "Deployment id: {id}",
  "sceneDeploy.planTitle": "Change plan",
  "sceneDeploy.planSceneId": "Scene {id}",
  "sceneDeploy.planDigest": "Plan digest {digest}",
  "sceneDeploy.stepOrder": "Step {order}",
  "sceneDeploy.stepWillRun": "Will run",
  "sceneDeploy.stepWillNotRun": "Won't run",
  "sceneDeploy.serviceLabel": "Service entry: {label}",
  "sceneDeploy.noServiceLabel": "No single service entry (needs resolution first)",
  "sceneDeploy.dependsOn": "Depends on: {ids}",
  "sceneDeploy.hold.needsResolution": "This resource kind has no single entry — it must first be resolved via \"{hint}\"; this layer doesn't guess an entry, so it won't run.",
  "sceneDeploy.hold.needsResolutionNoHint": "This resource kind has no single entry — it must be resolved first; this layer doesn't guess an entry, so it won't run.",
  "sceneDeploy.hold.payloadProjectionHeader": "The declaration is missing required fields for this service's real input, so it can't be projected into a dispatchable payload (this layer won't dispatch half-baked input):",
  "sceneDeploy.hold.dependency": "Step \"{id}\" it depends on won't run, so this step won't either.",

  /* ── validation problems ── */
  "sceneDeploy.problemsTitle": "The declaration is invalid — fix the following first:",
  "sceneDeploy.problemLine": "{path}: {message}",

  /* ── capability preflight ── */
  "sceneDeploy.preflightTitle": "Capability preflight",
  "sceneDeploy.preflightChecking": "Preflighting…",
  "sceneDeploy.preflightOk": "All required capabilities are present ({n} checked).",
  "sceneDeploy.preflightMissing": "Required capabilities are missing — deployment will be blocked:",
  "sceneDeploy.preflightOptional": "These optional capabilities are missing (deployment still proceeds, just one piece short):",
  "sceneDeploy.gapMissing": "Missing \"{kind} / {id}\": {detail}",
  "sceneDeploy.gapIncompatible": "\"{kind} / {id}\" is not applicable: {detail}",
  "sceneDeploy.preflightUnavailable": "Capability preflight is unavailable right now: {error}",

  /* ── results ── */
  "sceneDeploy.approveRefused": "Approval refused: {reason}",
  "sceneDeploy.applyRefused": "Deployment refused: {reason}",
  "sceneDeploy.resultTitle": "Deployment result",
  "sceneDeploy.deployStatus.deploying": "Deploying",
  "sceneDeploy.deployStatus.active": "Completed",
  "sceneDeploy.deployStatus.partial": "Partially completed",
  "sceneDeploy.deployStatus.failed": "Failed",
  "sceneDeploy.acceptancePassed": "Acceptance passed",
  "sceneDeploy.acceptanceFailed": "Acceptance not passed",
  "sceneDeploy.acceptanceExpected": "Expected: {ids}",
  "sceneDeploy.acceptanceObserved": "Read back: {ids}",
  "sceneDeploy.acceptanceMissing": "Missing: {ids}",
  "sceneDeploy.stepStatus.pending": "Pending",
  "sceneDeploy.stepStatus.running": "Running",
  "sceneDeploy.stepStatus.done": "Done",
  "sceneDeploy.stepStatus.failed": "Failed",
  "sceneDeploy.stepStatus.compensated": "Compensated",
  "sceneDeploy.stepError": "Error: {error}",
  "sceneDeploy.stepCompensation": "Compensation: {reason}",
  "sceneDeploy.readbackUnverifiable": "Could not be independently read back: {ids}",
  "sceneDeploy.digestMismatch": "The local preview and the host's returned plan digest disagree (this shouldn't happen) — trusting the host, please re-check.",
} as const;
