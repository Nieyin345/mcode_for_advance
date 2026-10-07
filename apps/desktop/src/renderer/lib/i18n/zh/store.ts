/**
 * store area messages. Keys follow the area's prefix convention.
 * zh is the source of truth for `MessageId`.
 */
export const zh = {
  // ── event-ingest toasts (sessionStore.ingestEvent → pushToast) ──
  "store.toast.backgroundTaskDone": "后台任务完成",
  "store.toast.backgroundTaskDoneBody": "子代理任务已结束",
  "store.toast.agentQuestion": "Agent 有问题要问你",
  "store.toast.toolApprovalNeeded": "需要审批工具调用",
  "store.toast.planApprovalPending": "计划待审批",
  "store.toast.planApprovalPendingBody": "查看并批准执行计划",
  "store.toast.errorOccurred": "发生错误",
  "store.toast.sessionLabel": "会话",
  "store.toast.turnComplete": "回合完成",
  "store.toast.turnCompleteBody": "Agent 已完成本轮任务",
  "store.toast.outputTruncated": "输出可能被截断",
  "store.toast.outputTruncatedBody": "本轮输出已达到长度上限，回复可能不完整；请检查结果并继续。",
  "store.toast.turnIncomplete": "任务提前中断",
  // 复制对话失败。正文给的是主进程抛上来的那句具体原因(引擎不支持 / 会话文件不在了),
  // 因为那是用户唯一能据此做点什么的信息。
  "store.toast.persistFailed": "存对话记录失败(这一轮可能没保存下来)",
  "store.toast.settingSaveFailed": "设置没能保存",
  // 关闭标签时被守卫拦下的未保存文件 —— 编辑器没有自动保存,静默关掉就是丢改动。
  "store.toast.ideCloseBlockedTitle": "有文件没关：内容还没保存",
  "store.toast.ideCloseBlockedBody": "{names} 有未保存的修改，已保留。保存或撤销后即可关闭。",
  "store.toast.ideCloseBlockedMany": "{count} 个文件有未保存的修改，已保留。保存或撤销后即可关闭。",
  "store.toast.historyLoadFailed": "读取对话记录失败，请重新打开对话重试",
  "store.toast.createChatFailed": "新建对话失败",
  "store.toast.forkFailed": "复制对话失败",
  // 发送被主进程拒绝(不是模型报错):原因是写给用户的中文短句时带上,否则只给通用说明。
  "store.toast.sendFailed": "消息未发送：{reason}",
  "store.toast.sendFailedGeneric": "消息发送失败，详情见日志",
} as const;
