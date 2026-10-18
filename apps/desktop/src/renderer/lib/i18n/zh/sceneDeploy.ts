/**
 * 场景部署(设置 → 场景部署)。Keys: `sceneDeploy.*`。zh 是 `MessageId` 的源。
 *
 * 单独成文件(不并进 `settings.ts`):这条链是一条**独立的过程**(预览 → 批准 → 部署),
 * 它的词条自成一摊,与通用设置面板互不相干 —— 并行改设置页时也就不会争同一个文件。
 *
 * ⚠️ 用户可见字符串**一律**从这里取(硬规矩:i18n zh/en 双词典,缺 key 直接 typecheck 失败)。
 * 步骤「不会跑」的原因**不是**这里的一整句硬编码,而是结构化判据(`holdReason`)+ 这里的
 * 词条拼出来 —— 于是原因随判据分支走,不会两种原因共用一句含糊文案。
 */
export const zh = {
  /* ── 导航 + 页面 ── */
  "sceneDeploy.nav": "场景部署",
  "sceneDeploy.title": "场景部署",
  "sceneDeploy.intro":
    "粘贴一份场景声明(SceneSpec),先看它会按什么顺序建什么、哪几步不会跑,再批准、部署。批准的对象是**这一份计划**——声明在批准后被改一个字节,授权立即失效,需要重新预览批准。",

  /* ── 声明输入 ── */
  "sceneDeploy.specLabel": "场景声明(SceneSpec,JSON)",
  "sceneDeploy.specPlaceholder": "把一份 SceneSpec 的 JSON 粘贴到这里…",
  "sceneDeploy.specHint": "声明只描述「要什么」,不含凭据 / 绝对路径;真正的执行由本机在批准后按能力清单决定。",

  /* ── 动作按钮 ── */
  "sceneDeploy.preview": "预览",
  "sceneDeploy.previewing": "预览中…",
  "sceneDeploy.approve": "批准",
  "sceneDeploy.approving": "批准中…",
  "sceneDeploy.deploy": "部署",
  "sceneDeploy.deploying": "部署中…",
  "sceneDeploy.resume": "续跑剩余步骤",
  "sceneDeploy.resuming": "续跑中…",
  "sceneDeploy.reset": "清空",

  /* ── 阶段提示 ── */
  "sceneDeploy.stage.empty": "粘贴一份声明后点「预览」。",
  "sceneDeploy.stage.approved": "已批准这一份计划(授权有效至 {expiresAt})。点「部署」开始执行。",
  "sceneDeploy.stage.approvedExpired": "批准的授权已过期,请重新预览并批准。",
  "sceneDeploy.stage.needsApproval": "看过计划之后点「批准」——没有授权不会执行任何一步。",
  "sceneDeploy.emptySpec": "先粘贴一份声明。",
  "sceneDeploy.invalidJson": "这份文本不是合法 JSON:{message}",

  /* ── 计划预览 ── */
  "sceneDeploy.deploymentId": "部署 id:{id}",
  "sceneDeploy.planTitle": "变更计划",
  "sceneDeploy.planSceneId": "场景 {id}",
  "sceneDeploy.planDigest": "计划摘要 {digest}",
  "sceneDeploy.stepOrder": "第 {order} 步",
  "sceneDeploy.stepWillRun": "会执行",
  "sceneDeploy.stepWillNotRun": "不会执行",
  "sceneDeploy.serviceLabel": "服务入口:{label}",
  "sceneDeploy.noServiceLabel": "无稳妥服务入口(需先决议)",
  "sceneDeploy.dependsOn": "依赖:{ids}",
  "sceneDeploy.hold.needsResolution": "该资源种类无单条确定入口,需先按「{hint}」进一步决议,本层不猜入口、不执行。",
  "sceneDeploy.hold.needsResolutionNoHint": "该资源种类无单条确定入口,需先进一步决议,本层不猜入口、不执行。",
  "sceneDeploy.hold.payloadProjectionHeader": "声明缺该服务真实入参的必需字段,无法投影成可派发的入参(本层不派发半成品):",
  "sceneDeploy.hold.dependency": "依赖的步骤「{id}」不会执行,故本步也不执行。",

  /* ── 校验问题 ── */
  "sceneDeploy.problemsTitle": "声明不合法,先修正以下问题:",
  "sceneDeploy.problemLine": "{path}: {message}",

  /* ── 能力预检 ── */
  "sceneDeploy.preflightTitle": "能力预检",
  "sceneDeploy.preflightChecking": "预检中…",
  "sceneDeploy.preflightOk": "所需能力全部就位(查了 {n} 条)。",
  "sceneDeploy.preflightMissing": "有必需能力缺失,部署会被挡下:",
  "sceneDeploy.preflightOptional": "以下可选能力缺失(不影响部署,少一块):",
  "sceneDeploy.gapMissing": "缺「{kind} / {id}」:{detail}",
  "sceneDeploy.gapIncompatible": "「{kind} / {id}」不适用:{detail}",
  "sceneDeploy.preflightUnavailable": "能力预检暂时不可用:{error}",

  /* ── 结果 ── */
  "sceneDeploy.approveRefused": "批准被拒:{reason}",
  "sceneDeploy.applyRefused": "部署被拒:{reason}",
  "sceneDeploy.resultTitle": "部署结果",
  "sceneDeploy.deployStatus.deploying": "部署中",
  "sceneDeploy.deployStatus.active": "已完成",
  "sceneDeploy.deployStatus.partial": "部分完成",
  "sceneDeploy.deployStatus.failed": "失败",
  "sceneDeploy.acceptancePassed": "验收通过",
  "sceneDeploy.acceptanceFailed": "验收未通过",
  "sceneDeploy.acceptanceExpected": "期望:{ids}",
  "sceneDeploy.acceptanceObserved": "回读到:{ids}",
  "sceneDeploy.acceptanceMissing": "缺失:{ids}",
  "sceneDeploy.stepStatus.pending": "待执行",
  "sceneDeploy.stepStatus.running": "执行中",
  "sceneDeploy.stepStatus.done": "已完成",
  "sceneDeploy.stepStatus.failed": "失败",
  "sceneDeploy.stepStatus.compensated": "已补偿撤销",
  "sceneDeploy.stepError": "错误:{error}",
  "sceneDeploy.stepCompensation": "补偿:{reason}",
  "sceneDeploy.readbackUnverifiable": "无法独立回读:{ids}",
  "sceneDeploy.digestMismatch": "本机预览与宿主返回的计划摘要不一致(理论上不应发生)——以宿主为准,请复核。",

  /* ── 【MC-002】重启后发现的未完成部署 ── */
  "sceneDeploy.unfinishedTitle": "未完成的部署",
  "sceneDeploy.unfinishedHint": "这些是盘上留下的部署记录(应用重启后仍可见)。选一条把它的声明放回输入框,重新预览并批准后即可续跑剩余步骤。",
  "sceneDeploy.unfinishedEmpty": "这个场景没有留下部署记录。",
  "sceneDeploy.unfinishedEmptyAny": "盘上没有未完成的部署记录。",
  "sceneDeploy.unfinishedLoadError": "读取部署记录失败:{reason}",
  "sceneDeploy.unfinishedRetry": "重试",
  "sceneDeploy.unfinishedResumable": "可续跑",
  "sceneDeploy.unfinishedNotResumable": "不续跑",
  "sceneDeploy.unfinishedNoSnapshot": "这份旧记录没有声明快照,无法一键恢复声明;可在上方粘贴原声明后重新预览。",
  "sceneDeploy.unfinishedRestore": "恢复到输入框",
  "sceneDeploy.unfinishedRowMeta": "{status} · 更新于 {updatedAt}",
} as const;
