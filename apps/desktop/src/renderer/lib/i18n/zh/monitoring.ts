/**
 * 设置 → 运行监控（components/monitoring/MonitoringPanel）。
 * Keys: `monitoring.*`。概览卡、失败摘要、最近运行列表（含节点定案明细）的文案。
 */
export const zh = {
  // 概览卡的四个数,跟着 `@contracts/ipc` 的 `MonitoringOverview` 走:收口了多少次、
  // 成几败几、平均一次跑多久。
  "monitoring.totalRuns": "运行总数",
  "monitoring.succeeded": "成功",
  "monitoring.failed": "失败",
  "monitoring.avgDuration": "平均耗时",
  // 概览答不出"最近为什么败",所以单独一句(时刻进 title)。
  "monitoring.lastError": "最近一次失败",
  "monitoring.recent": "最近运行",
  "monitoring.empty": "还没有运行记录。",
  "monitoring.nodeCount": "{n} 个节点",
  "monitoring.loadFailed": "监控数据读不出来：{error}",
  // 展开区里节点的定案状态(`MonitoringNodeSummary.status` 透传 `NodeOutcomeStatus`;
  // 认不出的值原样显示,这张表只兜契约里的集合)。
  "monitoring.nodeStatus.success": "成功",
  "monitoring.nodeStatus.failed": "失败",
  "monitoring.nodeStatus.cancelled": "已取消",
  "monitoring.nodeStatus.skipped": "已跳过",
  "monitoring.nodeStatus.unselected": "未选中",
} as const;
