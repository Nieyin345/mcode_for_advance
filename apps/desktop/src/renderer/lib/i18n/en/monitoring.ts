/** English mirror of `zh/monitoring.ts`. */
export const en = {
  // The four overview cards follow `MonitoringOverview` in `@contracts/ipc`:
  // total settled runs, successes, failures, and the average duration.
  "monitoring.totalRuns": "Total runs",
  "monitoring.succeeded": "Succeeded",
  "monitoring.failed": "Failed",
  "monitoring.avgDuration": "Avg duration",
  // The overview totals can't say why the last run failed, so it gets its own
  // line (the timestamp goes into the title).
  "monitoring.lastError": "Last failure",
  "monitoring.recent": "Recent runs",
  "monitoring.empty": "No runs yet.",
  "monitoring.nodeCount": "{n} nodes",
  "monitoring.loadFailed": "Failed to load monitoring data: {error}",
  // Settled node statuses in the expanded row (`MonitoringNodeSummary.status`
  // passes through `NodeOutcomeStatus`; unknown values render verbatim).
  "monitoring.nodeStatus.success": "Success",
  "monitoring.nodeStatus.failed": "Failed",
  "monitoring.nodeStatus.cancelled": "Cancelled",
  "monitoring.nodeStatus.skipped": "Skipped",
  "monitoring.nodeStatus.unselected": "Unselected",
} as const;
