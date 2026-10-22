# T103｜Orca↔Mcode 三栏 UI/Agent 任务看板与可用性架构对照

## 1. 范围、基线与结论摘要

- **Orca 固定基线**：ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560（orca/；版本字符串 1.4.214）。本轮只读核验的 HEAD 与任务卡一致，git -C orca status --short --untracked-files=all 为空。
- **Mcode 起始基线**：94524df83eb01669dd93191521f84a593bd0dd95。工作区已有其他执行对话的未提交修改，本报告未碰这些文件；清单见 §8。
- **证据范围**：固定 SHA 的一手源码、源码内注释、已有测试源码、T78 历史 ARC-005 审计、T95/T96 任务卡。没有启动 Electron、没有运行测试或构建、没有访问外部服务，也没有声称完成真实 UI 旅程。
- **证据等级**：**E2** = 静态源码/调用链/测试源码可定位；**E3** = 基于 E2 的产品范围或设计判断。**E1/U1 未做**：没有真实窗口、实际键盘旅程、屏幕阅读器、终端 PTY 或实时 PR 服务的端到端验收。
- **Skill 使用**：frontend-design 用于只读检查信息层级、状态表达、焦点可见性与减动效线索；research 按任务边界只追溯一手源码/测试，不调用后台代理。

结论不是“Orca 的 UI 全面领先”。Mcode 已有持久化三栏布局、隐藏面板保活、会话内 Agent 活动汇总、工作流节点状态板、可键盘操作的右栏导航和审批卡。最明显的差异是**状态聚合范围**：Orca 的 Activity 是跨 worktree/pane 的应用级 Agent 收件箱；Mcode 当前是当前会话内的 ActivityCluster 与 WorkflowBoardPanel。Orca 的双槽终端 Portal、PTY 冷停放和 IME 焦点回收属于它的全局工作区架构，不宜整包移植到 Mcode。

## 2. 可复核的源码调用链

### 链 A：工作区布局、可见性与偏好落盘

**Orca（E2）**

1. **orca/src/renderer/src/app-shell/AppWorkspaceShell.tsx** 组装 useAppChromeLayout、usePersistedUIWriter、useGlobalKeybindings 及工作区/浮动终端表面。
2. **orca/src/renderer/src/app-shell/use-app-chrome-layout.ts** 从 app store 解析当前 activeView、活动 worktree 与 chrome 布局状态；**orca/src/renderer/src/components/TerminalWorkbenchContainer.tsx** 在非工作区视图时把工作台设为 hidden，或在浏览器 guest 仍需绘制时改为 absolute + opacity-0 + pointer-events-none。两种隐藏状态都设置 inert 与 aria-hidden，避免不可见终端继续进入 Tab/辅助技术顺序。
3. **orca/src/renderer/src/app-shell/use-persisted-ui-writer.ts** 以 150 ms 差异写入 sidebarWidth、rightSidebarTab、右栏宽度、分组/排序，以及 acknowledgedAgentsByPaneKey、activityClearedAtByPaneKey、manuallyUnreadTurnsByPaneKey。写入优先使用 window.api.ui.setWithAck，旧 preload 才回退到 set；activeView 单独保存，避免每次视图切换触发完整持久状态写入。

**Mcode（E2）**

1. **apps/desktop/src/renderer/components/shell/ClassicShell.tsx** 将 ThreePaneLayout、右栏 RightPanel、终端和中间工作区接到同一布局。
2. **apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx** 对已打开过的右栏/底部终端采用保活策略；隐藏表面用 inert/aria-hidden 和不可见尺寸/显示状态隔离，而不是每次切换都销毁组件。
3. **apps/desktop/src/renderer/components/layout/RightPanel.tsx** 对访问过的内建 tab 维持 React identity 并隐藏非当前面板，保留 Git 子 tab、文件浏览器滚动和嵌入式 panel 状态。
4. **apps/desktop/src/renderer/stores/sessionStore.ts** 的 setRightPanelTab 将 UI_RIGHT_PANEL_TAB_SETTING_KEY 写入设置；setPaneRightSizePct 等 setter 调用 schedulePaneWidthPersist，最终通过 ui.paneWidths 保存 paneLayout、dock 和各栏尺寸。**apps/desktop/src/renderer/stores/paneLayoutPrefs.ts** 解析旧/新格式并验证数值字段。

**判断：**布局尺寸、tab 偏好持久化、隐藏面板隔离与保活属于**等价已有（E2）**。Orca 的 activeView/跨 worktree 工作台生命周期更广，但不是 Mcode 必须复制的同一信息架构。

### 链 B：Agent 活动、状态反馈与用户动作

**Orca（E2）**

1. **orca/src/renderer/src/components/activity/ActivityPrototypePage.tsx** 组合 useAgentPaneThreads，并把搜索、worktree scope、read filter、grouping、child-agent 显示和选中 paneKey 交给列表。
2. **orca/src/renderer/src/components/activity/use-agent-pane-threads.ts** 从 agentStatusByPaneKey、编排快照、保留的 Agent 状态、已确认/未读和清理时间等 store 字段生成事件，再经 buildActivityEvents / buildAgentPaneThreads 形成线程列表。
3. **orca/src/renderer/src/components/activity/use-activity-thread-action-bindings.ts** 与 **activity-thread-actions.ts** 将行操作接到 acknowledgeAgents、unacknowledgeAgents、清理完成项、激活并显示对应 workspace，以及激活 tab/聚焦目标 pane。对应的已读、手动未读与清理时间再由 usePersistedUIWriter 落盘。

**Mcode（E2）**

1. **apps/desktop/src/renderer/components/chat/ChatPane.tsx** 把当前会话的 subagents、todos、planBlocks、bookmarks 与跳转回调传给 ActivityCluster。
2. **apps/desktop/src/renderer/components/chat/ActivityCluster.tsx** 打开 ActivityConsole；**ActivityConsole.tsx** 用四种内容模型表达子代理时间线、Todo 状态板、计划索引和书签。可点的子代理行使用共享 ClickableRow，过滤 chip 使用 aria-pressed。
3. **apps/desktop/src/renderer/components/chat/WorkflowBoardPanel.tsx** 通过 useWorkflowLive() 读取 workflow.node.* 事件、调用 api.workflow.get 取得流程形状、调用 api.session.listNodes 读取已保存的节点会话，并按 nodeId 合并 live/stored 行；**BoardNodeCard.tsx** 以 PHASE_META/PHASE_LABEL 显示 queued、running、awaiting、success、failed、skipped、cancelled 等状态。打开节点由 openNode 同时更新展开卡和 selectSideChat，避免只高亮却没有切换到对应会话。
4. 工作流图高度由 WorkflowBoardPanel.tsx 的 api.setting.get/set 持久化；读取失败时关闭写回闸门、提供重试，写失败通过 toast 告知用户。

**判断：部分已有（E2）。**Mcode 的状态词、颜色、运行耗时、失败/等待提示、节点上下文和当前会话子代理操作并不薄弱；差异在于 Mcode 没有 Orca 那种应用级、跨 worktree/pane 的统一 Agent 收件箱及其已读/未读/批量清理语义。不能把“没有全局 inbox”直接判成 UI bug，需先确认 Mcode 是否需要跨会话管理 Agent 的产品场景。

### 链 C：终端切换、Portal 就绪与焦点所有权

**Orca（E2）**

1. **ActivityPrototypePage.tsx** 为当前显示与下一候选线程分别创建 Portal descriptor，字段包括 worktreeId、tabId、稳定 paneKey、slot 与 requestToken。
2. useActivityTerminalPortalStatus 观察目标 pane 是否就绪/不可用；resolveActivityPortalSwap 决定 clear、swap-staged 或 settle-visible。页面通过 useLayoutEffect 调用 setActivityTerminalPortals，在 paint 前发布 descriptor，避免切换线程时旧终端短暂显示在新行下。
3. **use-terminal-workspace-store-bindings.ts** 只在 activeView === 'activity' 时订阅 Portal；**TerminalPaneOverlayLayer.tsx** 用 worktree/tab 身份查找目标，**TerminalOverlaySlot.tsx** 通过 createPortal 将同一个 TerminalPane 渲染到目标容器，并传入 isolatedPaneKey。**use-terminal-tab-cold-parking.ts** 将 Portal 中的终端排除在普通冷停放候选之外。
4. **activity-filter-focus-shortcut.ts** 在 Activity 页面接管 Cmd/Ctrl+F 前检查当前焦点是否位于 Portal 终端内；若是，保留终端自己的搜索快捷键。**use-floating-terminal-focus-lifecycle.ts** 处理外部点击、窗口 blur/focus、焦点回收与 IME 刷新边界。

相关源码测试包括 activity-terminal-portal.test.tsx、activity-portal-readiness-loop.react185.test.tsx、ActivityPrototypePage.filter-focus-shortcut.test.ts、terminal-pane-title-focus-handoff.spec.ts。**本任务只检查了测试源码，没有运行它们。**

**Mcode（E2）**

- **ThreePaneLayout.tsx** 与 **RightPanel.tsx** 保留隐藏表面并将不可见内容从辅助技术/Tab 顺序隔离；右栏 rail 的左右键导航通过 nextRailFocusIndex 处理，dock handle 提供 click/Enter/Space 之外的方向键路径。
- **ApprovalPrompt.tsx** 将初始焦点放在审批卡而非“允许”按钮，active 卡才处理 Escape；它区分 IME composition/229，允许按钮有 arming delay。**McpToolDecisionCard.tsx** 是只读状态卡，明确不自行合成授权决定。
- 当前 Mcode ActivityCluster 是会话内浮层，WorkflowBoardPanel 也是当前会话/工作流的右栏面板；在本次 UI 入口中没有 Orca 那种把全局 Activity 列表行绑定到任意 worktree 的 live PTY Portal。

**判断：部分已有（E2）。**Mcode 已有 pane 保活、inert/aria-hidden、右栏键盘导航和审批焦点门禁；Orca 的双槽预热/就绪切换解决的是跨 worktree 终端搬运问题。不能仅凭源码断言真实 Tab 顺序、焦点返回、屏幕阅读器和 IME 的完整旅程已通过。

### 链 D：Hosted Review 路由、异步结果与可见性刷新

**Orca（E2）**

1. **useRightSidebarTabRouting.ts** 规范化持久化 tab；如果 tab 被当前 workspace 隐藏或插件已卸载，解析可见 fallback 而不必把原路由覆盖成 fallback。
2. **RightSidebarPanelContent.tsx** 在 effectiveTab === 'checks' 时挂载 ChecksPanel；**ChecksPanel.tsx** 组合 useChecksPanelReviewState、useChecksPanelReviewData、polling 与手动刷新。
3. **use-checks-panel-review-data.tsx** 为 PR comments/check details 构造 checksPanelAsyncResultKey，并在写回前检查 isCurrentAsyncResult；切换 PR/worktree 后到达的旧结果不应覆盖当前上下文。
4. **use-visible-hosted-review-refresh.ts** 和 **use-visible-review-refresh-reporting.ts** 根据可见 review targets、document.visibilityState、当前活动 worktree 与右栏内容决定刷新/报告对象；离开可见视图时清理报告。

**Mcode（E2）**

- **packages/contracts/src/ipc/settings.ts:634** 的 RightPanelTabSchema 内建 tab 为 files/git/browser/turns/preview/flow/tasks；**GitPanel.tsx** 的子 tab 是 changes/history/worktrees。Mcode 另有 DiffView、ApprovalPrompt、PlanApprovalPrompt 与 McpToolDecisionCard，但这些是 diff/本地审批/工具结果，不等价于 Orca 的 Hosted PR Checks + review comments 工作流。
- 因此本次限定 UI 入口没有找到一一对应的 Hosted Review 面板；这不是“源码目录里没找到就证明产品缺失”，而是现有内建 tab/schema 及产品范围的差异。

**判断：与定位冲突（E3；底层 UI/schema 事实为 E2）。**除非 Mcode 明确要成为 Hosted PR review 客户端，不建议为追求界面对齐而新增 Orca 式 PR 生命周期、轮询器或 review 状态机。

## 3. 能力对照矩阵

| 能力 | Orca：可核验入口/符号 | Mcode：可核验入口/符号 | 分类与证据 | 结论 |
|---|---|---|---|---|
| 三栏布局、dock、隐藏面板保活 | AppWorkspaceShell.tsx、useAppChromeLayout、TerminalWorkbenchContainer.tsx；usePersistedUIWriter | ClassicShell.tsx → ThreePaneLayout.tsx；RightPanel.tsx；sessionStore.ts:setRightPanelTab/setPaneRightSizePct；paneLayoutPrefs.ts | **等价已有 / E2** | 两边都将布局、tab 与隐藏状态作为真实状态处理；Mcode 无需重写布局框架。 |
| Agent 活动看板的范围 | ActivityPrototypePage.tsx、useAgentPaneThreads、activity-thread-actions.ts | ChatPane.tsx → ActivityCluster.tsx/ActivityConsole.tsx；WorkflowBoardPanel.tsx | **部分已有 / E2** | Mcode 有会话内 Agent/Todo/Plan/Bookmark 与工作流节点看板；未见跨 worktree 的统一 Agent inbox、搜索/范围过滤、已读/未读和批量清理同一套语义。 |
| 运行/等待/失败/完成状态表达 | ActivityPrototypePage.tsx、use-agent-pane-threads.ts、WorkspaceReviewChecksIndicator.tsx、WorktreeCardReviewDetailSection.tsx | ActivityConsole.tsx 的 SUBAGENT_STATUS_META/TODO_META；BoardNodeCard.tsx 的 PHASE_META/PHASE_LABEL；McpToolDecisionCard.tsx | **等价已有（限各自范围）/ E2** | Mcode 已有文本状态、颜色、计数/耗时与失败状态；可借鉴 Orca 的跨 worktree 聚合，而非重画一套颜色。 |
| 焦点/键盘可达性 | use-global-keybindings.ts、activity-filter-focus-shortcut.ts、use-floating-terminal-focus-lifecycle.ts | RightPanel.tsx 的 rail arrow-key handler、Divider.tsx、ApprovalPrompt.tsx、ActivityConsole.tsx 的 ClickableRow | **部分已有 / E2** | 两边均有显式键盘路径和隐藏内容隔离；全流程焦点恢复、IME、真实 Tab 顺序仍缺 E1/U1。 |
| 终端切换时不显示旧内容/不误停放 | ActivityPrototypePage.tsx → setActivityTerminalPortals → TerminalPaneOverlayLayer.tsx/TerminalOverlaySlot.tsx → TerminalPane；useTerminalTabColdParking.ts | ThreePaneLayout.tsx 的 terminal keepalive/inert；sessionStore.ts 的 pane 状态；无对应全局 Activity→任意 worktree Portal | **部分已有 / E2** | Mcode 解决常规 pane 隐藏/恢复；Orca 的双槽 Portal 是额外的跨工作区功能，只有出现同类需求时才值得设计。 |
| Hosted PR review / checks 状态 | useRightSidebarTabRouting.ts → ChecksPanel.tsx → useChecksPanelReviewData → visible-review refresh hooks | RightPanelTabSchema、GitPanel.tsx changes/history/worktrees、DiffView.tsx 与审批卡 | **与定位冲突 / E3**（事实 E2） | 不建议为视觉相似而复制 PR 评论、checks polling、Hosted Review 状态机。 |
| UI 偏好、已读/清理状态与恢复 | usePersistedUIWriter.ts 对 sidebar/tab/filter/ack/clear/unread 做 diff + ack write | sessionStore.ts 的 pane widths/right tab；WorkflowBoardPanel.tsx 对高度读失败关闭写回并显示重试/保存失败 toast；ActivityConsole 交互状态主要在组件内 | **部分已有 / E2** | Mcode 的布局/工作流高度恢复有明确保护；如果未来增加全局 inbox，应先定义 read/clear 的持久化语义，不要将临时组件状态当作 durable state。 |
| 语义 token、焦点样式与减动效 | orca/docs/STYLEGUIDE.md；orca/src/renderer/src/assets/main.css 的 focus/状态 token 与 prefers-reduced-motion 规则（1764、1881、1944、2004、2093、2637、2717、2970） | apps/desktop/src/renderer/styles.css 的 prefers-reduced-motion 规则（741、802、896、1113、1155、1564、1691、2110、2198、2408、2808、3036、3181、3262、3316）；components/ui/cds/StatusDot.tsx | **等价已有 / E2** | 两边都能从源码定位语义化状态样式与减动效路径；实际系统偏好下的渲染仍未做 E1 验证。 |
| 真实视觉、Tab 顺序、读屏与键盘旅程 | Orca 有相关测试源码，但本轮未运行；源码不等于真实端到端通过 | T78 的 PNG/JSON 历史档案、T95 probe 任务、T96 审批键盘回归任务；本轮未启动 Electron | **证据不足 / E2** | 不给任何真实 UI/可访问性 PASS；需以修正后的探针与隔离组件旅程补证。 |

## 4. 与 T78 / T95 / T96 的边界

- **T78 的 39/39 是历史存档完整度，不是 39 个真实旅程都通过。** .tmp/t78-arc005-visual-gap-audit.md 记载 PNG/JSON 39/39、历史 probe.ok 39/39，但 Composer selector 0/39、Terminal selector 0/39、Titlebar selector 3/39 且误命中 Settings header；sidechat 只检查外层 wrapper，静态 terminal/editor 是 fixture。存档也没有 activeElement、Tab 顺序、焦点环、溢出尺寸或 pane bounds。因此不能拿该矩阵推断 Orca 式 Activity/终端/审批行为已经被 Mcode 的 U1 验收。
- **T95 的对象是视觉探针可信度，不是产品 UI 改造。** 它要修 fake composer/tool-row/titlebar/sidechat 的假阳性和缺失测量字段；探针缺字段不是产品能力缺失，也不能靠改产品 token 让基线全绿。
- **T96 的对象是审批卡动态交互测试。** 任务卡明确要求验证初始焦点不直接授权、Tab + arming 后允许、Escape 拒绝、IME/229 不误触发、隐藏 keepalive 不消费按键、拒绝后仍可操作，以及危险方法不出现“始终允许”。ApprovalPrompt.tsx 的静态实现已显示这些门禁意图，McpToolDecisionCard.tsx 也声明只读；但测试卡列出的行为尚不能由静态源码当作验收通过。
- 因此：**测试覆盖缺口 ≠ 已证实的产品功能缺陷**。本任务不改生产代码、不重复派审批卡实现任务，也不把源码有 focus-visible/aria-* 直接等同于可访问性旅程通过。

## 5. 三个关键异常/恢复边界（测试设计，不是已复现缺陷）

1. **Activity 连续切换线程 / worktree，旧 terminal descriptor 或 readiness 回调晚到。** 输入：先选 pane A，再快速选 pane B；A 的 ready/unavailable 回调在 B 之后返回。Orca 以 paneKey/requestToken、visible/staged slot 与 resolveActivityPortalSwap 管理切换；应验证 B 未就绪时不把 A 的终端留在 B 行下。Mcode 的会话内 openNode 同时更新展开卡和 selectSideChat；若将来加跨会话 inbox，应以稳定 pane/session identity 绑定内容，而非只读全局 activeTabId。**本轮未执行该反例。**
2. **PR A 的 comments/checks 请求在用户已切换到 PR B 后返回。** 输入：启动 A 的异步请求，切换 worktree/PR 后再释放 A 的响应。Orca useChecksPanelReviewData 使用 checksPanelAsyncResultKey 和 isCurrentAsyncResult 防止旧上下文写回，visible refresh hooks 限制到当前可见目标；这是可复用的状态边界思想，不代表 Mcode 当前需要 Hosted Review 功能。**本轮未执行该反例。**
3. **隐藏/关闭终端或切换审批卡时发生快捷键竞争。** 输入：焦点位于终端输入区或 IME composition 中时触发 Cmd/Ctrl+F、Escape 或窗口 blur/focus；同时让另一张审批卡处于隐藏 keepalive。Orca filter shortcut 会让 Portal terminal 保留自己的搜索 chord，floating focus lifecycle 清理/延迟焦点回收；Mcode RightPanel 跳过 IME/修饰键并用 inert 隔离隐藏 pane，ApprovalPrompt 只让 active 卡处理 Escape。应验证焦点不落到隐藏控件、Enter 不意外授权、拒绝后仍能继续操作。**本轮未执行该反例。**

## 6. Top 2 借鉴点与一条不应照搬的设计

### 借鉴 1：Agent 活动信息架构，而不是复制整页

- **设计**：如果 Mcode 的真实使用需要同时查看多个会话/工作区的 Agent，再把 Orca 的 scope/search/group/read-unread/clear-completed 模型适配到现有 Agent 状态事实源；稳定的 pane/session identity 应贯穿列表、选中行与操作回调。
- **Mcode 入口**：先复用 ActivityCluster/ActivityConsole 与现有 session/workflow state；不要新增第二套运行状态 store，也不要将 WorkflowBoardPanel 的流程节点误当作所有 Agent 的全局清单。
- **方式/复杂度**：**借鉴设计；M–L**（M 仅增强现有会话视图；L 才涉及跨 worktree 聚合与 durable read/clear）。
- **完整回归门（本轮不运行）**：隔离测试覆盖 scope/search/filter/group/read/unread/clear；双会话身份切换与 late update；ARC-005 的真实列表/窄窗探针；键盘导航、焦点恢复；既有 workflow、Provider 与审批 smoke。只有需求成立后才拆实现任务。

### 借鉴 2：把焦点所有权与状态反馈写成可测试的切换契约

- **设计**：延续 Mcode 现有 inert/aria-hidden 与 ApprovalPrompt active/IME 门禁；对每个面板切换明确谁拥有焦点、哪些快捷键归终端、隐藏内容如何从可访问性树隔离，以及 loading/ready/unavailable/error 的状态转移。借鉴 Orca 在 Portal 就绪前保留旧可见内容、就绪或明确不可用后再切换的原则，不照抄实现。
- **方式/复杂度**：**小模块适配；S–M**，优先补焦点/状态探针和独立测试 seam，不先重写布局或终端。
- **完整回归门（本轮不运行）**：T95 修正后的 source/focus/overflow/pane-bound probe；T96 动态审批隔离测试；右栏键盘与 divider smoke；终端焦点/IME 测试；如需验证真实窗口再由既有 U1 门串行运行，不与独占 Electron 任务并发。

### 不应照搬：Orca 的双槽 Terminal Portal + cold-parking/focus-reclaim 整套实现

- **理由**：ActivityPrototypePage、TerminalOverlaySlot、TerminalPaneOverlayLayer、useTerminalTabColdParking 和 useFloatingTerminalFocusLifecycle 共同依赖 Orca 的全局 worktree/tab/group/PTY 模型、稳定 paneKey、隐藏终端保活与 IME 生命周期。Mcode 当前是会话内 ActivityCluster + 右栏 WorkflowBoard，布局保活已有自己的 ThreePaneLayout/sessionStore 机制。整体移植会引入重复的终端所有权、额外状态同步与 PTY 生命周期风险，收益没有被现有需求证明。
- **方式/复杂度**：**暂不引入；L**。若将来确认要做跨 worktree live-terminal inbox，只能先定义 Mcode 自己的身份/所有权/就绪契约，再在隔离宿主中验证，不复制 Orca 源码。
- **版权/资产**：orca/LICENSE 为 MIT，但这不自动覆盖仓库内所有依赖、图标、字体或其他内嵌资源。本报告只借鉴可验证的行为与信息架构，不复制 Orca 源码、品牌资产或商用/第三方素材。

## 7. 结论计数

按 §3 矩阵的 9 行计数（同一行只计一个主分类）：

- **等价已有：3**
- **部分已有：4**
- **真缺失：0**
- **证据不足：1**
- **与定位冲突：1**

这里的“真缺失：0”不等于所有功能都有；它表示在没有产品端到端证据、且两边产品范围不同的情况下，不把静态未找到或 T78 探针缺口直接升级为已证实产品缺陷。

## 8. 验证记录、改动范围与剩余风险

### 只读验证

- git rev-parse HEAD → 94524df83eb01669dd93191521f84a593bd0dd95。
- git status --short --untracked-files=all → 存在下列他人工作区修改；本轮没有清理、暂存或覆盖它们：
  - .aoci/baseline.json
  - .gitignore
  - apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts
  - apps/desktop/scripts/orchestration-ipc-smoke/run.sh
  - apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs
  - apps/desktop/src/main/appControl/apiCatalog.generated.ts
  - apps/desktop/src/main/ipc/settingsTransfer.ts
  - 另有一个未跟踪条目在命令输出中呈现为 ?? ['dev（名称输出异常/截断，未对其进行解析或操作）。
- git diff --cached --name-status → 空（调查开始时无已暂存变更）。
- git -C orca rev-parse HEAD → ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560。
- git -C orca status --short --untracked-files=all → 空。
- git check-ignore -v docs/research/orca-mcode/T103-ui-ux.md → exit 1，无忽略规则命中。
- 未运行测试/构建/Electron：符合本只读研究卡边界；以上源码测试仅核对其存在和断言方向，不计为测试 PASS。

### 剩余风险

1. 没有真实窗口 U1/E1：不能证明视觉像素、实际 Tab 顺序、屏幕阅读器、窄窗裁切、终端焦点回收或 IME 旅程通过。
2. Orca Activity Portal 的异步切换与 PTY 冷停放复杂；本轮没有运行其测试，报告仅说明源码设计意图。
3. Mcode 是否需要跨 worktree Agent 收件箱是产品需求判断，不是静态源码能单独决定的事项。
4. Hosted Review 是 Orca 的完整 PR 协作能力；本轮只核对 Mcode 的内建右栏入口与相关 UI，不声称 Mcode 全仓没有任何 review API。
5. 未修改产品代码、共享配置、Orca、其他任务卡或用户数据；仅新增本报告。
