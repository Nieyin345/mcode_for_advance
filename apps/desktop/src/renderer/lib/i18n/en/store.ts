/** English mirror of `zh/store.ts`. */
export const en = {
  // ── event-ingest toasts (sessionStore.ingestEvent → pushToast) ──
  "store.toast.backgroundTaskDone": "Background task finished",
  "store.toast.backgroundTaskDoneBody": "A subagent task has finished",
  "store.toast.agentQuestion": "The agent has a question for you",
  "store.toast.toolApprovalNeeded": "Tool call needs approval",
  "store.toast.planApprovalPending": "Plan awaiting approval",
  "store.toast.planApprovalPendingBody": "Review and approve the plan",
  "store.toast.errorOccurred": "Error occurred",
  "store.toast.sessionLabel": "Session",
  "store.toast.turnComplete": "Turn complete",
  "store.toast.turnCompleteBody": "The agent has finished this turn",
  "store.toast.outputTruncated": "Output may be truncated",
  "store.toast.outputTruncatedBody": "This turn reached the output limit. The response may be incomplete; review it and continue if needed.",
  "store.toast.turnIncomplete": "Task ended early",
  "store.toast.persistFailed": "Couldn't save the conversation (this turn may not be stored)",
  "store.toast.historyLoadFailed": "Couldn't load the conversation history. Reopen the chat to retry.",
  "store.toast.createChatFailed": "Couldn't create the conversation",
  "store.toast.forkFailed": "Couldn't duplicate the conversation",
  "store.toast.sendFailed": "Message not sent: {reason}",
  "store.toast.sendFailedGeneric": "Message failed to send; see the log for details",
} as const;
