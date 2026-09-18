/** English mirror of `zh/chat-stream.ts`. */
export const en = {
  // ── MessageTimeline ──
  "chatStream.timeline.current": "Current",
  "chatStream.timeline.noText": "(no text)",
  "chatStream.timeline.attachmentLine": "[Attachment] {text}",

  // ── MessageBlocks: batch tool group ──
  "chatStream.opCount": "{n} operations",

  // ── Chat stream · Plan A (spine): turn summary / reply mark ──
  "chatStream.stepCount": "{n} steps",
  "chatStream.filesChanged": "{n} files changed",
  "chatStream.waitingModel": "Waiting for model…",

  // ── Running ledger (borderless form) header ──
  "chatStream.ledgerRunning": "Running",
  "chatStream.tokensUsed": "{n} tokens",
  "chatStream.filesChangedShort": "{n} files",

  // ── RenderErrorBoundary: per-segment render-failure fallback ──
  "chatStream.renderError": "This item failed to render and was skipped (everything else is unaffected)",

  // ── MessageBlocks: thinking / tool cards ──
  "chatStream.thinking": "Thinking",
  "chatStream.tool.input": "Input",
  "chatStream.tool.result": "Result",
  "chatStream.lineCount": "{n} lines",
  "chatStream.emptyPlaceholder": "(empty)",
  "chatStream.truncatedSuffix": "(truncated)",

  // ── MessageBlocks: compact summary ──
  "chatStream.compact.manual": "History compacted manually",
  "chatStream.compact.auto": "History compacted automatically",
  "chatStream.compact.freed": "· Freed {n} tokens",

  // ── A workflow step card (see `components/chat/WorkflowStepCard.tsx`) ──
  "chatStream.workflowStep.success": "Done",
  "chatStream.workflowStep.failed": "Failed",
  // "Not run" rather than "Skipped": what the user sees is the cause — an
  // upstream step failed, so this one never ran.
  "chatStream.workflowStep.skipped": "Not run",
  // Must stay distinct from the line above — this one means "you picked a different
  // path at the fork", not "something upstream blew up".
  "chatStream.workflowStep.unselected": "Not taken",
  "chatStream.workflowStep.cancelled": "Cancelled",
  // "Queued": the node entered the run queue but hasn't started yet (the
  // workflow.node.queued event, see `renderer/lib/workflowQueued.ts`). Kept
  // distinct from "running" — a queued node burns no tokens.
  "chatStream.workflowStep.queued": "Queued",
  "chatStream.workflowStep.empty": "This step produced no text.",
  // What this step cost. `{cost}` is "—" when the engine reported no cost (not $0.00).
  "chatStream.workflowStep.usage": "{tokens} tokens · {cost}",
  // The button on a failed card — resume from this step (see RetryNodeDialog).
  "chatStream.workflowStep.retry": "Try again",
  // The dialog. `desc` states the re-run scope; `scope` says who the note is
  // for — users assume it instructs the whole graph, which is the easy mix-up.
  "chatStream.workflowRetry.title": "Resume from this step",
  "chatStream.workflowRetry.desc":
    "This step and everything downstream of it will run again. Steps that already succeeded are kept.",
  "chatStream.workflowRetry.ph":
    "What went wrong? e.g. \"no network this time, use the local copy\"",
  "chatStream.workflowRetry.scope": "Only this step will see this note.",
  "chatStream.workflowRetry.confirm": "Run again",
  "chatStream.workflowRetry.stale":
    "This card no longer applies — that run may have finished, or this chat already has a workflow running.",
  // "过程" = what this step actually did inside its hidden sub-session (tool calls plus
  // the narration between them). See WorkflowStepCard / WorkflowNodeTranscriptEvent.
  "chatStream.workflowStep.process": "Process",
  "chatStream.workflowStep.processSteps": "{n} blocks",
  "chatStream.workflowStep.processGone":
    "This step's process is no longer in memory (only the most recent steps are kept).",
  // Execution metadata for this step (NodeExecutionRecord): which executor ran it, how long.
  "chatStream.workflowStep.execution": "Executor {kind} · {duration}",
  // External artifacts this step produced (NodeArtifact). file / directory get "Open";
  // data references are listed without an action.
  "chatStream.workflowStep.artifacts": "Artifacts",
  "chatStream.workflowStep.open": "Open",

  // ── The fork card (see `components/chat/BranchChoiceCard.tsx`) ──
  // Deliberately unlike the result cards above: until the button is pressed, the run
  // has NOT finished — so this card is live, not a "it's done" card.
  "chatStream.workflowChoice.prompt": "This step is yours to decide. Pick one to continue:",
  "chatStream.workflowChoice.comment": "Anything to add? (optional)",
  "chatStream.workflowChoice.confirm": "Continue",
  // Every fork carries this one built in: don't pick. It's a UI affordance, not an edge.
  "chatStream.workflowChoice.stop": "Stop here",
  // A loop-back asks the same fork again, one card per round. This is the small chip.
  "chatStream.workflowChoice.round": "Round {n}",
  "chatStream.workflowChoice.chosen": "You picked “{label}”",
  "chatStream.workflowChoice.stopped": "You stopped here",
  // Pressing a STALE card (that run already finished or was cancelled). NOT an error —
  // clicking an old card in history is a normal thing to do, so say it on the card
  // itself instead of popping a dialog.
  "chatStream.workflowChoice.stale": "This choice no longer applies (that run already finished or was cancelled).",

  // ── The "ask me before running" dialog (a switch on conversation nodes, see
  //    `AskChoiceDialog`). It asks "should this step run at all", not "which way
  //    do we go" — so it pops up centered instead of just sitting in the stream
  //    (the card is still there: it is the record of what was asked).
  "chatStream.workflowAsk.title": "Run this step?",
  "chatStream.workflowAsk.desc": "“{title}” is about to run — checking with you first.",
  "chatStream.workflowAsk.confirm": "Go with this",
  // Closing the dialog is **not** giving up: the card is still in the chat.
  "chatStream.workflowAsk.dismiss": "Later",

  // ── The right-panel run board (see `components/chat/WorkflowBoardPanel.tsx`) ──
  // It watches the SAME thing as the cards above, but at a different time: a card is
  // only drawn once a step has settled, while the board is readable mid-run — so every
  // string here has to hold up in the "still running" tense.
  "chatStream.workflowBoard.title": "Workflow",
  "chatStream.workflowBoard.runningSection": "Running",
  "chatStream.workflowBoard.doneSection": "Finished",
  // Clears the Finished group from the BOARD only — the cards, transcripts and usage
  // stay in the conversation and the archive.
  "chatStream.workflowBoard.clearDone": "Clear finished from the board (records stay in the chat)",
  // Before anything has been dispatched. NOT "no runs" — someone opening this wants to
  // know what happens next.
  "chatStream.workflowBoard.emptyTitle": "This graph hasn't run yet",
  "chatStream.workflowBoard.emptyHint":
    "Send a message in the chat and it starts walking from the main node.",
  // The transcript of a step that is still going. "Waiting for it to say something" is
  // truer than "nothing here": it IS working, it just hasn't emitted anything yet.
  "chatStream.workflowBoard.nodeWaiting": "Still running — nothing to show yet.",
  "chatStream.workflowBoard.awaiting": "Waiting on you",
  // The banner at the top. Three sentences that CANNOT be merged into one: a failure
  // wants a retry, a fork wants a pick, a cancel wants the whole graph re-run.
  "chatStream.workflowBoard.haltedFailed":
    "“{title}” failed — open it to see why, and you can re-run just this step.",
  "chatStream.workflowBoard.haltedAwaiting":
    "“{title}” is waiting on you — pick a way forward on its card in the chat.",
  "chatStream.workflowBoard.haltedCancelled": "This run stopped at “{title}”.",
  // The two lines in the detail view: a fork, and the "ask me before running" switch.
  // The BUTTONS are not here — the clickable thing is the card in the chat, and this
  // just says where to go (two live buttons would make "which one" a real question).
  "chatStream.workflowBoard.awaitingHint":
    "This step stopped here for you to pick a way forward. The buttons are on its card in the chat:",
  "chatStream.workflowBoard.awaitingAsk":
    "This step checks with you before it starts. Pick on its card in the chat:",
  // Looking back after the pick: the node remembers which one you chose, what you
  // added, and which round of asking it was. `chosen` holds the option label.
  "chatStream.workflowBoard.chosen": "You picked: {label}",
  "chatStream.workflowBoard.chosenComment": "You added: {text}",
  "chatStream.workflowBoard.chosenAttempt": "round {n}",
  // The four words under the mini flow chart (WorkflowFlowLegend in WorkflowFlowMini).
  "chatStream.workflowBoard.legendDone": "Done",
  "chatStream.workflowBoard.legendRunning": "Running",
  "chatStream.workflowBoard.legendAwaiting": "Waiting on you",
  "chatStream.workflowBoard.legendFailed": "Failed",
  // ── Taking over a failed / cancelled step ──
  // Three things: **stop** it (which stops the whole graph), **talk to this step**
  // (it keeps going), **talk to the main chat** (drops into the composer for you to send).
  "chatStream.workflowBoard.takeover": "Take over this step",
  "chatStream.workflowBoard.takeoverPlaceholder": "Say something to whoever…",
  "chatStream.workflowBoard.takeoverSent": "Sent",
  "chatStream.workflowBoard.takeoverStop": "Stop this graph",
  "chatStream.workflowBoard.talkToNode": "Talk to this step",
  "chatStream.workflowBoard.talkToParent": "Put in the chat composer",

  // ── MessageBlocks: images ──
  "chatStream.image.browserScreenshot": "Browser screenshot",
  "chatStream.image.userImage": "User image",
  "chatStream.imageRenderedAbove": "[image rendered above]",

  // ── MessageBlocks: image gallery ──
  "chatStream.gallery.screenshotAlt": "Screenshot {n}/{total}",
  "chatStream.gallery.prev": "Previous",
  "chatStream.gallery.next": "Next",
  "chatStream.gallery.imageN": "Image {n}",

  // ── MessageBlocks: attachment chip ──
  "chatStream.attachment.viewImage": "View image",
  "chatStream.attachment.viewContent": "View content",
  "chatStream.attachment.collapseImage": "Collapse image",
  "chatStream.attachment.collapseContent": "Collapse content",

  // ── Markdown ──
  "chatStream.copyCode": "Copy code",
  "chatStream.code.expand": "Expand",
  "chatStream.code.collapse": "Collapse",

  // ── FileLink ──
  "chatStream.fileLink.clickToOpen": "Click to open file",
  "chatStream.fileLink.noMatch": "No matching files found",
  "chatStream.fileLink.matchCount": "{n} matches · pick one to open",

  // ── DiffView / Write card diff labels ──
  "chatStream.diff.noChanges": "(no changes)",
  "chatStream.diff.newFile": "New file",
  "chatStream.diff.vsPreTurn": "Diff vs pre-turn",
  "chatStream.diff.newFileContent": "New file content",

  // ── TurnFilesCard ──
  "chatStream.turnFiles.titleLong": "Modified {n} files this turn",
  "chatStream.turnFiles.titleShort": "{n} files changed",
  "chatStream.turnFiles.created": "{n} created",
  "chatStream.turnFiles.modified": "{n} modified",
  "chatStream.turnFiles.rewindLong": "Undo this turn",
  "chatStream.turnFiles.rewindShort": "Undo",
  "chatStream.turnFiles.rewinding": "Undoing…",
  "chatStream.turnFiles.rewoundCheck": "Undone ✓",
  "chatStream.turnFiles.rewoundBadge": "Undone",
  "chatStream.turnFiles.rewindLatestTitle": "Restore all files from this turn to their pre-turn state",
  "chatStream.turnFiles.rewindHistoryTitle":
    "Restore this past turn's file changes to their pre-edit state (may affect later turns)",
  "chatStream.turnFiles.confirmTitle": "Undo this turn's changes",
  "chatStream.turnFiles.confirmDescLatest": "Files changed this turn will be restored to their pre-turn state.",
  "chatStream.turnFiles.confirmDescHistory1": "Undoing a past turn restores its changed files to their pre-edit state,",
  "chatStream.turnFiles.confirmDescHistory2": "which may affect later turns that edited the same files. Continue?",
  "chatStream.turnFiles.reviewDiff": "Review changes in the editor",
  "chatStream.turnFiles.locateTitle": "Reveal this file in the file tree",
  "chatStream.turnFiles.createdThisTurn": "Created this turn",
  "chatStream.turnFiles.modifiedThisTurn": "Modified this turn",
  "chatStream.turnFiles.noChanges": "No changes",

  // ── Activity rail + console (chat right edge) ──
  "chatStream.activity.close": "Close",
  "chatStream.activity.now": "now",
  "chatStream.activity.emptyGroup": "Nothing in this filter",
  "chatStream.activity.tabAll": "All",
  // Collapsing cluster (方案 B) — round button + urgency-grown text bar
  "chatStream.activity.cluster.aria": "Activity",
  "chatStream.activity.cluster.running": "{n} subagents running",
  "chatStream.activity.cluster.failed": "{n} subagents failed",
  "chatStream.activity.cluster.waiting": "Waiting for your answer",
  "chatStream.activity.cluster.tasks": "Tasks {done}/{total}",
  "chatStream.activity.cluster.plans": "{n} plans",
  "chatStream.activity.cluster.noPlans": "No plans",
  "chatStream.activity.cluster.openPlans": "Open plans",
  // Node names (console header / node tab strip)
  "chatStream.activity.node.tasks": "Tasks",
  "chatStream.activity.node.subagents": "Subagents",
  "chatStream.activity.node.plans": "Plans",
  "chatStream.activity.node.bookmarks": "Bookmarks",
  // Group headers and filter chips
  "chatStream.activity.groupRunning": "Running",
  "chatStream.activity.groupSettled": "Settled",
  "chatStream.activity.groupCompleted": "Completed",
  "chatStream.activity.groupFailed": "Failed",
  "chatStream.activity.groupInProgress": "In progress",
  "chatStream.activity.groupPending": "Pending",
  "chatStream.activity.groupToday": "Today",
  "chatStream.activity.groupEarlier": "Earlier",
  "chatStream.activity.groupStale": "Stale",
  // Subagents panel
  "chatStream.activity.subagentsSubRunning": "{running} running · {ended} settled",
  "chatStream.activity.subagentsSubIdle": "{n} · all settled",
  "chatStream.activity.unitAgents": "total",
  "chatStream.activity.labelRunning": "running",
  "chatStream.activity.labelCumulative": "total",
  "chatStream.activity.subagentsFooter": "Bars are each agent's real span; running ones reach “now”",
  "chatStream.activity.noDescription": "(no description)",
  "chatStream.activity.viewSubagent": "View subagent transcript",
  // Tasks panel
  "chatStream.activity.tasksSubtitle": "{done}/{total} done · {rest} left",
  "chatStream.activity.tasksDoneSuffix": "done",
  "chatStream.activity.tasksRest": "{n} left",
  "chatStream.activity.tasksFooter": "This node hides itself once every task is done",
  "chatStream.activity.priorityHigh": "High",
  "chatStream.activity.priorityMedium": "Med",
  "chatStream.activity.priorityLow": "Low",
  // Plans panel
  "chatStream.activity.plansSubtitle": "{n} plans, newest first",
  "chatStream.activity.unitPlans": "plans",
  "chatStream.activity.latestChip": "Latest",
  "chatStream.activity.openPlan": "Open",
  "chatStream.activity.plansFooter": "Click any plan to open it in the plan panel",
  "chatStream.activity.planFallback": "(Plan {n})",
  "chatStream.activity.viewPlan": "Click to view the full plan",
  // Bookmarks panel
  "chatStream.activity.bookmarksSub": "{n} bookmarks",
  "chatStream.activity.bookmarksSubStale": "{n} · {stale} stale",
  "chatStream.activity.unitBookmarks": "total",
  "chatStream.activity.bookmarksFooter": "Select text to add one; stale bookmarks are dimmed, never deleted",
  "chatStream.subagent.statusRunning": "Running",
  "chatStream.subagent.statusCompleted": "Completed",
  "chatStream.subagent.statusFailed": "Failed",
  "chatStream.subagent.statusKilled": "Terminated",

  // ── Message bookmarks (selection toolbar / capsule / timeline) ──
  "chatStream.bookmark.add": "Add bookmark",
  "chatStream.bookmark.askSideChat": "Send to sub-session",
  "chatStream.bookmark.copied": "Copied",
  "chatStream.bookmark.capsuleTitle": "Bookmarks ({n})",
  "chatStream.bookmark.sectionTitle": "Bookmarks · {n}",
  "chatStream.bookmark.jumpTitle": "Click to jump to the message",
  "chatStream.bookmark.remove": "Remove bookmark",
  "chatStream.bookmark.rename": "Rename bookmark",
  "chatStream.bookmark.renamePlaceholder": "Bookmark name",
  "chatStream.bookmark.stale": "Message removed",
  "chatStream.bookmark.addedToast": "Bookmark added",

  // ── ChatPane: streaming spinner hint ──
  "chatStream.upstreamRetry": "Upstream connection issue — retrying ({attempt}/{attempts})",

  // ── MessageBlocks: turn-incomplete warning card ──
  "chatStream.turnIncomplete.title": "Task ended early",
  "chatStream.turnIncomplete.danglingDesc":
    "The model channel returned an empty response mid-task, so this turn ended unfinished. Send “Continue” to resume from where it stopped.",
  "chatStream.turnIncomplete.emptyDesc":
    "The model channel returned no reply text this turn. Try resending or switching models.",
  "chatStream.turnIncomplete.unfinishedDesc":
    "The model's final text stops mid-sentence — the next step it announced never ran. Send “Continue” to resume from where it stopped.",
  "chatStream.turnIncomplete.pendingTools": "Unfinished calls: {tools}",

  // ── MessageBlocks: turn-notice system card (budget stop / model fallback / structured output invalid) ──
  "chatStream.turnNotice.budgetTitle": "Turn budget reached",
  "chatStream.turnNotice.fallbackTitle": "Automatic model fallback",
  "chatStream.turnNotice.structuredTitle": "Structured output failed validation",

  // ── MessageBlocks: ExitPlanMode approval-channel failure ──
  "chatStream.planApprovalBroken.title": "Plan approval prompt failed to show",
  "chatStream.planApprovalBroken.desc":
    "The approval request broke in transit (not a user rejection). The plan is usually saved to the plan file — reply to approve it or request changes.",

  // ── EmptyThreadWelcome ──
  "chatStream.welcome.title": "Start a new chat",
  "chatStream.welcome.withProject": "Start a new chat in {name}",
  "chatStream.welcome.todayUsage": "{turns} turns today · {tokens} tokens used",
} as const;
