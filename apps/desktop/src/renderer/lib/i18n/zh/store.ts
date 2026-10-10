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
  // 撤销本轮文件改动失败(`claude.rewindTurn` 抛)。这张卡会显示「已撤销 ✓」,从前
  // store 把错误吞了、照样 resolve —— 用户看到成功、文件其实一个字节没回滚。
  "store.toast.rewindFailed": "撤销本轮改动失败(文件可能没还原)",
  "store.toast.settingSaveFailed": "设置没能保存",
  // 会话 / 项目行操作(改名、归档、删除、置顶、分组)落库失败 —— 主进程会抛
  // (`session not found` / `project not found` / zod / IO),而渲染端**没有**全局
  // unhandledrejection 监听,调用点几乎全是裸 `void storeAction(...)`。抛出去只落进
  // unhandled rejection:用户点了「删除」、那一行还在,屏幕上一个字都没有("点了没反应")。
  // 这些操作就地报出来,正文放主进程给的那句具体原因。
  "store.toast.sessionOpFailed": "操作失败",
  // 回答 Agent 提问 / 审批工具调用 / 审批计划这三处把回执递给主进程失败。三处都**故意**
  // 不撤销卡片(留着让用户重试),但从前的失败只 `console.error`:用户点了「提交」卡片
  // 纹丝不动、屏幕上一个字都没有,像按钮坏了。卡片留着是因为能重试,但也得说一句。
  "store.toast.questionReplyFailed": "回答没能送达 —— 再点一次「提交」重试",
  // 用户点「跳过」这张提问卡。跳过 = 让那一轮继续,而卡片会被就地收掉;若这条回执没送到,
  // 卡片已经没了、模型还在等 —— 用户能重试的入口一起消失了。所以这条失败要说出来
  // (与回答/审批同一处境)。
  "store.toast.questionDismissFailed": "跳过没能送达 —— 这一轮可能还在等你的答复",
  "store.toast.approvalFailed": "审批没能送达 —— 再点一次重试",
  "store.toast.planApprovalFailed": "计划审批没能送达 —— 再点一次重试",
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
