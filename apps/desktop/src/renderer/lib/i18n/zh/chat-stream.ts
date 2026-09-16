/**
 * chat-stream area messages. Keys follow the area's prefix convention.
 * zh is the source of truth for `MessageId`.
 */
export const zh = {
  // ── MessageTimeline ──
  "chatStream.timeline.current": "当前",
  "chatStream.timeline.noText": "(无文本内容)",
  "chatStream.timeline.attachmentLine": "[附件] {text}",

  // ── MessageBlocks: batch tool group ──
  "chatStream.opCount": "{n} 个操作",

  // ── Chat stream · 方案A「脉络」: turn summary / reply mark ──
  "chatStream.stepCount": "{n} 步",
  "chatStream.filesChanged": "改 {n} 个文件",
  "chatStream.waitingModel": "等待模型…",

  // ── 运行台账（无框形态）台头 ──
  "chatStream.ledgerRunning": "运行中",
  "chatStream.tokensUsed": "{n} tokens",
  "chatStream.filesChangedShort": "{n} 文件",

  // ── RenderErrorBoundary: per-segment render-failure fallback ──
  "chatStream.renderError": "此内容渲染出错，已跳过（其余内容不受影响）",

  // ── MessageBlocks: thinking / tool cards ──
  "chatStream.thinking": "思考",
  "chatStream.tool.input": "输入",
  "chatStream.tool.result": "结果",
  "chatStream.lineCount": "{n} 行",
  "chatStream.emptyPlaceholder": "(空)",
  "chatStream.truncatedSuffix": "(已截断)",

  // ── MessageBlocks: compact summary ──
  "chatStream.compact.manual": "已手动压缩对话历史",
  "chatStream.compact.auto": "已自动压缩对话历史",
  "chatStream.compact.freed": "· 释放 {n} tokens",

  // ── 工作流的一张步骤卡(见 `components/chat/WorkflowStepCard.tsx`)──
  "chatStream.workflowStep.success": "已完成",
  "chatStream.workflowStep.failed": "失败",
  // 「未运行」而不是「跳过」:用户看到的因果是"上游没成,所以这一步没跑"。
  "chatStream.workflowStep.skipped": "未运行",
  // 和上面那句**必须分得开** —— 它是"用户在岔路口选了别的路",不是"哪一步炸了"。
  // 两句混用的话,用户会去翻一个根本没跑的节点的日志,而那里什么也没有。
  "chatStream.workflowStep.unselected": "没走这条路",
  "chatStream.workflowStep.cancelled": "已取消",
  "chatStream.workflowStep.empty": "这一步没有产出文本。",
  // 这一步的开销。`{cost}` 在引擎没报花费时是 "—"（不是 $0.00）。
  "chatStream.workflowStep.usage": "花了 {tokens} tokens · {cost}",
  // 「过程」= 这一步在那个隐藏子会话里干了什么(工具调用 + 中间说的话)。见
  // `WorkflowStepCard` 与 `@contracts/runtime` 的 `WorkflowNodeTranscriptEvent`。
  "chatStream.workflowStep.process": "过程",
  "chatStream.workflowStep.processSteps": "{n} 条",
  // 过程只在内存里、有容量上限(见 `RuntimeManager` 的 `NODE_TRANSCRIPT_LIMIT`)——
  // 说清楚是"不在了"而不是摆一个点开是空的入口让人以为坏了。
  "chatStream.workflowStep.processGone": "这一步的过程已经不在内存里了(只留最近跑过的若干步)。",

  // ── 岔路口那张卡(见 `components/chat/BranchChoiceCard.tsx`)──
  // 它和上面的结果卡**长得不一样**:按钮点下去之前,这次运行**没有结束** —— 所以它
  // 是活的,而不是一张"跑完了"的卡。用户原话:「需要用户提出意见,然后发送,然后继续」。
  "chatStream.workflowChoice.prompt": "这一步你来定。选一条继续:",
  "chatStream.workflowChoice.comment": "还想补充点什么？（可以不填）",
  "chatStream.workflowChoice.confirm": "继续",
  // **每个岔路口都自带的一条出路:不做选择。** 界面上给的,不是图上的一条边。
  "chatStream.workflowChoice.stop": "就到这儿",
  // 回头会让同一个岔路口被问好几次,每轮一张卡。这是卡片右上角那个小标。
  "chatStream.workflowChoice.round": "第 {n} 轮",
  "chatStream.workflowChoice.chosen": "你选了「{label}」",
  "chatStream.workflowChoice.stopped": "你让它停在这儿了",
  // 点了一张**已经过期**的卡(那次运行早就跑完或被取消了)。**不是报错** —— 用户点
  // 历史里一张旧卡是正常会发生的事,所以只在他点的那张卡上说一句,不弹框。
  "chatStream.workflowChoice.stale": "这条选择已经不适用了（那一步已经跑完或被取消）。",

  // ── 「运行前先问我」那个弹窗（对话节点上的开关，见 `AskChoiceDialog`）──
  // 它问的不是"往哪条路走"，而是"这一步现在要不要跑、怎么跑" —— 所以弹在**屏幕中间**，
  // 而不是像岔路口那样只摆一张卡（卡也照摆：它是这一问留下的记录）。
  "chatStream.workflowAsk.title": "这一步要不要跑？",
  "chatStream.workflowAsk.desc": "「{title}」跑之前先问你一句。",
  "chatStream.workflowAsk.confirm": "就按这个来",
  // 关掉弹窗**不等于放弃** —— 聊天里那张卡还在，点它一样能选。
  "chatStream.workflowAsk.dismiss": "先放一放",

  // ── MessageBlocks: images ──
  "chatStream.image.browserScreenshot": "浏览器截图",
  "chatStream.image.userImage": "用户图片",
  "chatStream.imageRenderedAbove": "[图片已在上方显示]",

  // ── MessageBlocks: image gallery ──
  "chatStream.gallery.screenshotAlt": "截图 {n}/{total}",
  "chatStream.gallery.prev": "上一张",
  "chatStream.gallery.next": "下一张",
  "chatStream.gallery.imageN": "第 {n} 张",

  // ── MessageBlocks: attachment chip ──
  "chatStream.attachment.viewImage": "查看图片",
  "chatStream.attachment.viewContent": "查看内容",
  "chatStream.attachment.collapseImage": "收起图片",
  "chatStream.attachment.collapseContent": "收起内容",

  // ── Markdown ──
  "chatStream.copyCode": "复制代码",
  "chatStream.code.expand": "展开",
  "chatStream.code.collapse": "收起",

  // ── FileLink ──
  "chatStream.fileLink.clickToOpen": "点击打开文件",
  "chatStream.fileLink.noMatch": "未找到匹配文件",
  "chatStream.fileLink.matchCount": "{n} 个匹配 · 选择打开",

  // ── DiffView / Write card diff labels ──
  "chatStream.diff.noChanges": "(无变化)",
  "chatStream.diff.newFile": "新文件",
  "chatStream.diff.vsPreTurn": "与本轮开始前的差异",
  "chatStream.diff.newFileContent": "新文件内容",

  // ── TurnFilesCard ──
  "chatStream.turnFiles.titleLong": "本轮修改了 {n} 个文件",
  "chatStream.turnFiles.titleShort": "修改 {n} 个文件",
  "chatStream.turnFiles.created": "创建 {n}",
  "chatStream.turnFiles.modified": "修改 {n}",
  "chatStream.turnFiles.rewindLong": "撤销本轮",
  "chatStream.turnFiles.rewindShort": "撤销",
  "chatStream.turnFiles.rewinding": "撤销中…",
  "chatStream.turnFiles.rewoundCheck": "已撤销 ✓",
  "chatStream.turnFiles.rewoundBadge": "已撤销",
  "chatStream.turnFiles.rewindLatestTitle": "把本轮所有文件恢复为轮开始前的状态",
  "chatStream.turnFiles.rewindHistoryTitle":
    "把该历史轮次的文件改动恢复为当时修改前的状态(可能影响后续轮次)",
  "chatStream.turnFiles.confirmTitle": "撤销本轮修改",
  "chatStream.turnFiles.confirmDescLatest": "将把本轮修改的文件恢复为轮开始前的状态。",
  "chatStream.turnFiles.confirmDescHistory1": "撤销历史轮次会把该轮修改的文件恢复到当时修改前的状态，",
  "chatStream.turnFiles.confirmDescHistory2": "可能影响后续轮次对同一文件的修改。确定继续吗？",
  "chatStream.turnFiles.reviewDiff": "在编辑器中审查改动",
  "chatStream.turnFiles.locateTitle": "在文件树中定位此文件",
  "chatStream.turnFiles.createdThisTurn": "本轮新建",
  "chatStream.turnFiles.modifiedThisTurn": "本轮修改",
  "chatStream.turnFiles.noChanges": "无变化",

  // ── Activity rail + console (聊天区右缘) ──
  "chatStream.activity.close": "关闭",
  "chatStream.activity.now": "现在",
  "chatStream.activity.emptyGroup": "这项筛选下没有内容",
  "chatStream.activity.tabAll": "全部",
  // 收放聚簇（方案 B）——圆钮 + 按紧急度伸出的文字横条
  "chatStream.activity.cluster.aria": "活动",
  "chatStream.activity.cluster.running": "{n} 个子代理运行中",
  "chatStream.activity.cluster.failed": "{n} 个子代理失败",
  "chatStream.activity.cluster.waiting": "等待你的回答",
  "chatStream.activity.cluster.tasks": "任务 {done}/{total}",
  "chatStream.activity.cluster.plans": "{n} 计划",
  "chatStream.activity.cluster.noPlans": "无计划",
  "chatStream.activity.cluster.openPlans": "打开计划",
  // 节点名（活动台台头 / 节点页签）
  "chatStream.activity.node.tasks": "任务",
  "chatStream.activity.node.subagents": "子代理",
  "chatStream.activity.node.plans": "计划",
  "chatStream.activity.node.bookmarks": "书签",
  // 分组标题与筛选 chip
  "chatStream.activity.groupRunning": "运行中",
  "chatStream.activity.groupSettled": "已结束",
  "chatStream.activity.groupCompleted": "已完成",
  "chatStream.activity.groupFailed": "失败",
  "chatStream.activity.groupInProgress": "进行中",
  "chatStream.activity.groupPending": "待办",
  "chatStream.activity.groupToday": "今天",
  "chatStream.activity.groupEarlier": "更早",
  "chatStream.activity.groupStale": "已失效",
  // 子代理面板
  "chatStream.activity.subagentsSubRunning": "{running} 个运行中 · {ended} 个已结束",
  "chatStream.activity.subagentsSubIdle": "{n} 个 · 全部已结束",
  "chatStream.activity.unitAgents": "个",
  "chatStream.activity.labelRunning": "运行中",
  "chatStream.activity.labelCumulative": "累计",
  "chatStream.activity.subagentsFooter": "条形为该代理的真实起止，运行中的延伸到「现在」",
  "chatStream.activity.noDescription": "(无描述)",
  "chatStream.activity.viewSubagent": "查看子代理详情",
  // 任务面板
  "chatStream.activity.tasksSubtitle": "{done}/{total} 已完成 · 剩余 {rest} 项",
  "chatStream.activity.tasksDoneSuffix": "已完成",
  "chatStream.activity.tasksRest": "剩余 {n} 项",
  "chatStream.activity.tasksFooter": "任务全部完成时该节点自动收起",
  "chatStream.activity.priorityHigh": "高",
  "chatStream.activity.priorityMedium": "中",
  "chatStream.activity.priorityLow": "低",
  // 计划面板
  "chatStream.activity.plansSubtitle": "共 {n} 份，最新排在最上",
  "chatStream.activity.unitPlans": "份",
  "chatStream.activity.latestChip": "最新",
  "chatStream.activity.openPlan": "打开",
  "chatStream.activity.plansFooter": "点击任一份在计划面板中打开",
  "chatStream.activity.planFallback": "(计划 {n})",
  "chatStream.activity.viewPlan": "点击查看完整计划内容",
  // 书签面板
  "chatStream.activity.bookmarksSub": "{n} 个书签",
  "chatStream.activity.bookmarksSubStale": "{n} 个 · {stale} 个已失效",
  "chatStream.activity.unitBookmarks": "个",
  "chatStream.activity.bookmarksFooter": "选中正文可添加；失效的书签只灰掉，不删除",
  "chatStream.subagent.statusRunning": "运行中",
  "chatStream.subagent.statusCompleted": "已完成",
  "chatStream.subagent.statusFailed": "失败",
  "chatStream.subagent.statusKilled": "已终止",

  // ── Message bookmarks (selection toolbar / capsule / timeline) ──
  "chatStream.bookmark.add": "添加书签",
  "chatStream.bookmark.askSideChat": "发送到子会话",
  "chatStream.bookmark.copied": "已复制",
  "chatStream.bookmark.capsuleTitle": "书签（{n} 个）",
  "chatStream.bookmark.sectionTitle": "书签 · {n} 个",
  "chatStream.bookmark.jumpTitle": "点击定位到原文",
  "chatStream.bookmark.remove": "删除书签",
  "chatStream.bookmark.rename": "重命名书签",
  "chatStream.bookmark.renamePlaceholder": "书签名称",
  "chatStream.bookmark.stale": "原消息已移除",
  "chatStream.bookmark.addedToast": "已添加书签",

  // ── ChatPane: streaming spinner hint ──
  "chatStream.upstreamRetry": "上游连接异常，正在重试（{attempt}/{attempts}）",

  // ── MessageBlocks: turn-incomplete warning card ──
  "chatStream.turnIncomplete.title": "任务提前中断",
  "chatStream.turnIncomplete.danglingDesc":
    "模型通道在任务中途返回了空响应，本轮未完成。直接发送「继续」可从中断处恢复。",
  "chatStream.turnIncomplete.emptyDesc":
    "模型通道未返回任何回复文本，本轮没有产出。建议重发或切换模型。",
  "chatStream.turnIncomplete.unfinishedDesc":
    "模型的收尾文本停在未写完的语句上，宣告的下一步没有发出。直接发送「继续」可从中断处恢复。",
  "chatStream.turnIncomplete.pendingTools": "未完成的调用：{tools}",

  // ── MessageBlocks: ExitPlanMode 审批通道故障警告 ──
  "chatStream.planApprovalBroken.title": "计划审批弹框未能弹出",
  "chatStream.planApprovalBroken.desc":
    "审批请求在传输通道中断（非用户拒绝）。模型通常已把计划写入计划文件，可直接回复「批准」或提出修改意见继续。",

  // ── EmptyThreadWelcome ──
  "chatStream.welcome.title": "开始新的会话",
  "chatStream.welcome.withProject": "在「{name}」中开始新的会话",
  "chatStream.welcome.todayUsage": "今天对话 {turns} 轮 · 消耗 {tokens} token",
} as const;
