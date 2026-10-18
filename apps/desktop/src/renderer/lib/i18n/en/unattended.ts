/**
 * Unattended task plan strings (MC-001 panel) — English dictionary.
 */
export const en = {
  "unattended.title": "Unattended task plans",
  "unattended.intro":
    "Write a bounded list of session creations (title + first message per entry), approve it yourself, then run it — each operation creates a session and sends its first message. What you approve is the list itself; running only passes the grant id, the host fetches the content.",
  "unattended.hint":
    "⚠️ Approving is authorizing: running really creates sessions and sends messages on this machine, with no per-item approval prompt. The agent cannot reach this (it can neither issue nor run this grant) — only you can click these two buttons. The list is bounded: it stops at the count cap.",
  "unattended.projectLabel": "Project the operations run in",
  "unattended.projectNone": "(none selected)",
  "unattended.operationsLabel": "Operations",
  "unattended.addOperation": "Add one",
  "unattended.removeOperation": "Remove this one",
  "unattended.operationTitleLabel": "Title",
  "unattended.operationTitlePlaceholder": "Session title (a non-default title = don't reuse a shell, create a new row)",
  "unattended.operationPromptLabel": "First message",
  "unattended.operationPromptPlaceholder": "First message (empty = create the session only)",
  "unattended.ttlLabel": "Grant TTL (minutes)",
  "unattended.maxCountLabel": "Count cap",
  "unattended.approve": "Approve plan",
  "unattended.approving": "Approving…",
  "unattended.run": "Run",
  "unattended.running": "Running…",
  "unattended.grantActive": "Approved, not expired",
  "unattended.grantExpired": "Grant expired — approve again",
  "unattended.reset": "Clear",
  "unattended.runReport": "Done: {done}/{total} created.",
  "unattended.runStopped": "Stopped at {at} ({code}) — a refusal halts the run, no silent retry.",
  "unattended.pendingLabel": "Pending / resumable plans (across restarts)",
  "unattended.refresh": "Refresh",
  "unattended.pendingEmpty": "No pending plans",
  "unattended.pendingEmptyDesc": "Once you approve a plan it shows up here — it survives restarts, and you can resume or explicitly abandon it.",
  // 【MC-029 剩余项】Archive health (structured diagnosis): bad content and unreadable file
  // are different problems with different recovery steps.
  "unattended.archiveHealth.corrupt": "The plan archive is corrupt (content unreadable) — the reason and recovery steps below come from the archive core.",
  "unattended.archiveHealth.unreadable": "The plan archive cannot be read (permissions or disk error) — this is not corrupt content; fix read access first.",
  "unattended.archiveHealth.recovery":
    "Recovery: find unattended-plans.json under <data root>/appControl/ — repair the JSON (or back it up and delete it), then restart. Writes to the archive are disabled, so the original file will not be overwritten.",
  "unattended.planKind.resumable": "Resumable",
  "unattended.planKind.waiting_approval": "Waiting approval",
  "unattended.planKind.completed": "Completed",
  "unattended.pendingProgress": "{done}/{total} created",
  "unattended.resume": "Resume remaining",
  "unattended.resuming": "Resuming…",
  "unattended.abandon": "Abandon",
  "unattended.problem.noOperations": "At least one operation is required — an empty plan cannot be granted.",
  "unattended.problem.emptyOperation": "Operation {id} is empty: fill in a title or a first message.",
  "unattended.problem.maxCountBelow": "The count cap ({max}) cannot be lower than the number of operations ({count}).",
  "unattended.problem.ttlOutOfRange": "TTL must be between 1 and 30 minutes.",
} as const;
