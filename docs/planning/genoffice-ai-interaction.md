# GenOffice AI 交互全链路测绘

> **状态**：测绘稿（只读 vendor 源码 + 只写本文档），2026-10-18。未改任何生产代码，未提交，未改台账。
>
> **测绘基线**：Mcode `master` HEAD `b4648913a61627d5f34d8c4718a9d5236d23e55f`；vendor 快照 `genoffice/` HEAD `1f306a2a496227cae9194097897212c93d00a4e6`（2026-10-17，与 ARC-007 规划锁定的 commit 逐字一致）。
>
> **需求原文（用户）**：「我试了一下 genoffice 的官方软件，效果非常不错，我很喜欢他的 ai 交互功能，比如修改 ppt，可以直接选择一个框图，然后弹出输入框，用户输入内容，确定之后这个记录就直接显示到了侧边栏的聊天对话里面了……这个 genoffice 和 ai 的交互方式我要**完全的保留下来**，比我之前的 mcode 的 ai 交互编辑好太多了。」
>
> **要保留的交互**：选中元素 → 弹出输入框 → 用户输入 → 确认 → 该记录出现在侧边栏聊天对话；且很可能 docs/sheets/slides 同构。

---

## 1. 交互链路（按实读 vendor 源码）

### 1.1 总览：它不是命令面板，是「跟随选区的浮动按钮 + 锚定输入气泡 + 侧栏编辑队列」

三件事串起来：

1. **选区内/选区上方出现浮动「Ask AI」按钮**（floating chip）；
2. 点击后在该元素旁弹出**锚定输入气泡**（anchored popover，`position: fixed`，挂在 app 根上、不在画布缩放的子树里）；
3. 确认后有两种去向：**加入队列**（默认确认按钮，队列卡片立刻出现在侧边栏 AI 面板中）或**立即发送**（作为一次 selection-scoped 请求直接进聊天）。

队列本质是「先把这条记录显示在侧栏里，攒批后一次性发给模型」——用户看到的「记录直接出现在侧边栏聊天对话」，在 GenOffice 里对应 **`EditQueueCard` 的队列行**（确认即出现）与**提交后的 user 气泡**（发送时出现）。

### 1.2 PPT（slides）——用户描述的场景

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 浮动按钮 | `genoffice/apps/slides/src/renderer/components/AiAskPopover.tsx:66-130`（`AiAskTrigger`），挂载条件 `App.tsx:4644-4651` | 有选中元素、未在编辑、非裁剪/抠图/墨迹模式时显示；按钮跟随选区包围盒（`selectionRect`，`App.tsx:1362-1400`），滚动/缩放重新测量 |
| 弹输入框 | `AiAskPopover.tsx:152-342`；挂载 `App.tsx:4653-4687` | `openAskPopover`（`App.tsx:1414-1422`）+ `askState`；标题按元素种类（`NODE_NOUN_KEY`，`ai/edit-queue.ts:24-33`），副标题是元素文本预览（`truncate(preview, 60)`，`:229`），输入框回车提交（`:283-289`），最多 4 个建议 chip 只填充不提交（`:133-150`、`:291-305`） |
| 「确认」的两种 | 加入队列 `:320-323`（`aiAskQueue`）/ 立即发送 `:311-315`（`aiAskSendNow`）；多选时无「立即发送」以外的 queue 编辑语义 | 队列满只禁用「加入队列」（`:189`） |
| 加入队列 | `App.tsx:1424-1453`（`commitAsk`） | 建 `EditQueueItem{key,slideIndex,targets,instruction,status:'pending'}`；**强制展开侧栏** `setShowAi(true)`（`:1448-1452`）——这就是「确认后记录出现在侧栏」 |
| 队列卡片 | `ai/AiPanel.tsx:2437-2448` → `ai/EditQueueCard.tsx` | 在 composer 上方；行内显示页号/元素摘要，可点行定位元素（`EditQueueCard.tsx:36` `onFocus`）、行内改指令（`EditQueueCard.tsx:81-100`）、折叠、全部丢弃、发送 |
| 立即发送 | `App.tsx:4666-4685` | `pushAiPreset(buildSelectionInstruction(...), true, instruction, …, askScopeQuote())`：**模型指令**（含元素 id 清单）与**聊天气泡显示文本**（用户原话）分开，见 `ai/edit-queue.ts:136-150`、`App.tsx:1299-1322` |
| 会话提交 | `AiPanel.tsx:1855-1897`（`sendEditQueue`） | 提交时现解析锚点；按页分组，每页一次 run（各自一个撤销批次）；不可运行的条目直接出队并在气泡里说明原因；气泡文本由 `aiQueueSubmitted` + 每行 `页 · 指令` 拼成（`:1867-1883`） |

### 1.3 Word（docs）——同一交互的文本版

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 浮动按钮 | `apps/docs/src/renderer/components/AiAskPopover.tsx:132-179`（effect 跟随 selection），按钮 JSX `:399-417`；挂载 `App.tsx:7440-7449` | 编辑器有非空选区且聚焦时出现（`:139-147`）；`onMouseDown.preventDefault()` 保住选区（`:406`） |
| 弹输入框 | 同文件 `:228-390` | `openFromSelection`（`:230-237`）；`setInactiveSelectionShown(editor,true)` 让目标范围在弹框抢焦点时仍高亮（`editor/inactive-selection.ts:1-40`）；Escape 关闭、Enter 确认（`:307-322`）；点外部会把已输入文本**落进队列**而不是丢弃（`:207-220`） |
| 加入队列 | `App.tsx:6284-6295`（`queueAdd`）→ `editor/ai-queue-anchors.ts:84-86` | 锚点用 ProseMirror decoration 记录（随编辑字符级迁移）；**注意：docs 的 `queueAdd` 不主动展开侧栏**（对比 slides/html），需要面板已开；立即发送会展开（`App.tsx:6317-6319`） |
| 队列卡片 | `ai/AiPanel.tsx:1674-1683` → `ai/EditQueueCard.tsx` | 每次渲染用 `resolveQueueItem` 对活文档重解析（`ai/edit-queue.ts:60-91`）；点队列行可回跳选中锚点（`App.tsx:6304-6308`） |
| 立即发送 | `App.tsx:6317-6319` | `setShowAi(true)` + `aiPreset{autoRun:true}`；`AiPanel` 的 preset effect `AiPanel.tsx:987-995` 直接 `runWith(preset.text)` |
| 会话提交 | `AiPanel.tsx:1200-1213`（`sendQueue`） | `buildQueueInstruction`（`edit-queue.ts:111-127`，**自底向上排块**避免块索引漂移）+ `buildQueueSummary`（`:129-135`）作为气泡文本；消费队列后才发 |

### 1.4 Markdown / HTML——docs 的复制品（非共享实现）

- **markdown**：`components/AiAskPopover.tsx`（419 行，与 docs 版逐段相似，差异仅在 selection kind：多 code/task，见 `diff` 对照）、`ai/edit-queue.ts`、`ai/EditQueueCard.tsx`、挂载 `App.tsx:1358-1367`；队列/立即发送 `App.tsx:1017-1070`。
- **html**：`components/AiAskPopover.tsx`（274 行，按 tag 分 chip，`:56-75`）；打开入口有三条——预览检查器工具栏 `onAskAi={askAi}`（`App.tsx:1689`、`:862-864`）、预览 iframe 的 postMessage `msg.command === 'askAi'`（`:792`）、元素 pin 点回编辑（`:679-686`）；挂载 `App.tsx:1809-1825`。
- 两者都有自己的 `ai/EditQueueCard.tsx`（204/207 行）与 `ai/edit-queue.ts`。

### 1.5 Sheets——只有「立即发送」，没有队列

- 不是浮动 chip：**拖选单元格（≥4px 才算拖，`ai/selection-ask.ts:23-29`）**后，在拖拽终点附近直接弹出 `AiSelectionAsk`（`ai/AiSelectionAsk.tsx:23-167`；触发检测 `App.tsx:3179-3266`；挂载 `ExcelShell.tsx:1013-1022`）。
- `onSend` 只做一件事：`setIsCopilotOpen(true)` + `onSend(instruction)`（`ExcelShell.tsx:1018-1021`）→ `App.tsx:3415` `handleSend`。**没有 edit queue / EditQueueCard**（全仓 grep `editQueue` 在 sheets 只命中消息队列）。
- 「侧栏记录」体现为普通 user 气泡（`ai/AiChatPanel.tsx:636`），选区范围冻结进 run scope（`App.tsx:1596-1601`），并由上下文注入模型（`ai/tools.ts:700-706`，`selectionFrozen`）。

### 1.6 PDF——markup bar 上的按钮，只有「立即发送」

- 选中文本后出现浮动的标注工具条，其中「Ask AI」按钮 → `openAskPopover`（`apps/pdf/src/renderer/App.tsx:2602-2620`；按钮 `:9826-9843`）；popover 挂载 `:9844-9857`。
- `AiAskPopover`（`apps/pdf/src/renderer/AiAskPopover.tsx:30-164`）**刻意没有编辑队列**（文件头注释 `:1-8`）；`readOnly`（加密文档）时隐藏改写 chip（`:88-90`）。发送 → `runAiPreset(text)`（`App.tsx:6970-6973`）→ `AiPanel` preset effect 直接 `send`（`ai/AiPanel.tsx:579-585`）。

### 1.7 消息模型、存储位置、渲染组件

| app | 消息模型 | 侧栏渲染 | 持久化 |
| --- | --- | --- | --- |
| docs | `ChatEntry`（`ai/AiPanel.tsx:115-136`：role/text/error/streaming/tools/snapshot/attachments/**scope**/usage） | `chat.map` `AiPanel.tsx:1502-1630`；历史 `historicChat` `:1457-1475` | `window.projectApi.appendChat`（`AiPanel.tsx:688-720`；preload `apps/docs/src/preload/index.ts:277-285`）→ 主进程 `project:appendChat`（`docs-main.ts:4462-4504`）→ `ProjectStore` 写 `userData/<project>/chats/<chatId>.jsonl`（`packages/project-store/src/store.ts:334-341,686-757`）；重开时 `resolveChat`+`loadChat` 并 `loop.restore`（`AiPanel.tsx:630-667`） |
| slides | `ChatEntry`（`AiPanel.tsx:238-256`，含 `deckProgress` / `snapshotId`） | `chat.map` `:2263-2400`（composer 起于 `:2419`） | `persistMessage`（`:672-720`）同样走 `projectApi`（`:529,614-620`；preload `slides/src/preload/index.ts:507`） |
| sheets | `AiChatMessage`（`ai/AiChatPanel.tsx:207-227`，含 `autoApplied{opCount,undoSteps}`） | `:636-660` | `App.tsx:1188,1230-1252` + `persistChatMessage`（`:1266-1333`） |
| pdf | `ChatEntry`（`ai/AiPanel.tsx:69-87`） | `:749-800`（composer 起于 `:822`） | `resolveChat/loadChat` `:234-256` |
| markdown | `ChatEntry`（`ai/AiPanel.tsx:96-115`） | `:905-960`（composer 起于 `:1050`） | `projectApi` `:284-310,530-580` |
| html | `ChatEntry`（`ai/AiPanel.tsx:213-227`） | `:1268-1330`（composer 起于 `:1432`） | `projectApi` `:554-600,832-900` |

所有 app 的 user 气泡都会在 `scope` 存在时渲染 `AiScopeQuote`（共享组件 `packages/ui/src/AiScopeQuote.tsx`；docs `:1461,1528`、slides `:2222,2289`、sheets `:611,643`、markdown `:909`、html `:1273`、pdf `:753`）——这就是「这条记录是针对哪个元素/范围发的」的可见凭据。

### 1.8 共享 vs 各写一份（对落地成本很关键）

- **共享**（`packages/ui/src/`）：`AiComposer.tsx`、`AiScopeQuote.tsx`、`AiQueueStrip.tsx`（消息队列，不是编辑队列）、`AiModelPicker.tsx`、`AiPanelSideButton.tsx`、`AiTypingIndicator.tsx`、`AiUsageChip.tsx`、`chat-run-queue.ts`、`ai-panel-prefs*.ts`；`packages/agent-core/src/`：`loop.ts`、`skill.ts`、`electron-transport.ts`、`stream-text.ts`、`knowledge-base-skill.ts`、`create-document-skill.ts`；`packages/project-store` 管聊天历史。
- **各写一份**：`AiAskPopover` 5 份（docs 418 行 / slides 342 / markdown 419 / html 274 / pdf 164，**没有抽成共享组件**）；`EditQueueCard` 4 份（docs 203 / slides 209 / markdown 204 / html 207）；`edit-queue.ts` 4 份（docs/slides/markdown/html，锚点语义各按编辑器实现）；`AiPanel` 5 份 + sheets 的 `AiChatPanel` 1 份，各 1100–3200 行。
- **结论**：交互的「形」在每个 app 里都是一份拷贝，**没有一份可复用的共享实现**。这与 Mcode 的「共享实现只有一份」硬规矩直接冲突，是三种落法共同要付出的账。

---

## 2. AI 后端：从输入到文档改动

### 2.1 调用链

```
popover 确认
  → AiPanel.runWith(instruction, display?)            docs AiPanel.tsx:1108 / slides :1701 / pdf :530 / markdown :599 / html send :990
  → 压入 user 气泡 + assistant 占位（setChat）          docs :1146-1157
  → AgentLoop.run(instruction, images?)               packages/agent-core/src/loop.ts:470（类）、:582（run）
      ├─ skill.buildContext() 每轮附上文档骨架 + 选区     skill.ts:26-29；docs docs-skill.ts:78-96
      ├─ transport.stream(system, messages, tools)     electron-transport.ts:76-160
      │    → window.<app>Api.aiStream / onAiStream      docs preload:212-213,242-246
      │    → 主进程 ipcMain.handle('ai:stream')         docs-main.ts:4084；slides ai-ipc.ts:172；sheets sheets-main.ts:3766
      │    → streamForProvider(...)                     docs-main.ts:4150；packages/ai-provider/src/stream.ts:18-61
      │         provider: genspark/anthropic/gemini/openai 兼容/codex-app-server（types.ts:3-30；stream.ts:39-57）
      └─ 模型回 tool-call → skill.executeTool → 直接改活编辑器（见 2.2）
  → onText/onToolExecuted/onDone 更新气泡；onDone 后持久化
```

- 主进程只做「网络代理 + 凭据 + 设置」，模型**不在主进程做 agent 决策**；决策循环在渲染端 `AgentLoop`（默认 `maxTurns=100`，`loop.ts:94`）。
- 渲染端用 `createIpcTransport` 的 240s 静默看门狗（`electron-transport.ts:49`），主进程按 `requestId` 回 `delta/reasoning/tool-call/usage/done/error/ping`（`IpcStreamChunk`，`:13-29`）。
- `ai-provider` 不 import Electron（只有 `ai-search` 在 `genoffice-auth.ts:69,105` `require('electron')`）；`codex-app-server` 用 `node:child_process` 等 Node 内置（`packages/ai-provider/src/codex-app-server.ts:1-6`）。

### 2.2 文档操作怎么落地：不是 patch 文件，是「tool call → 活编辑器 ops」

- **docs**：`AGENT_TOOLS`（`ai/tools.ts:93-680`）里 `apply_ops`（`:196-217`，原子批，`dryRun`）、`insert_content`/`replace_blocks`/`replace_selection`/`write_document`；执行器 `executeTool`（`:1187` 起，`apply_ops` 分支 `:2045`）直接对 Tiptap 文档操作。`write_document` 是流式长文写入（`AiPanel.tsx:749-800` `runDocWriter`，经 `streamText` `:771`）。
- **slides**：`apply_ops`（`ai/slides-skill.ts:736-765`，一个事务、可 `dry_run`、`atomic|per_op`）与 `execute_slide_script`（`:300`）；另有 `generate_deck`/`regenerate_slide`（`:577/:542`）等。
- **sheets**：`propose_operations`（`ai/tools.ts:492-525`）→ `deps.proposeOperations` 自动应用（`:1273-1310`），结果带 `autoApplied{opCount,undoSteps}` 渲染内联 Undo（`AiChatPanel.tsx:219-220`）。
- **pdf**：`apply_ops`（`ai/tools.ts:927-958`，一次事务、一个 undo step）与专用编辑工具；不可逆文件级操作走确认卡（`:969/:986/:1005`）。
- **markdown/html**：各自 `apply_ops`/ops 执行器（`markdown-skill.ts:78`、`html-skill.ts`；`applyOps` 见 html `App.tsx:430-450`）。

### 2.3 失败与撤销

- **失败**：tool 返回 `{output, isError}`，`AgentLoop` 把错误结果回给模型继续（`loop.ts:1044-1240`）；`AgentSkill.verifyResponse` 是「没调工具却宣称改了」的防假完成钩子（`skill.ts:36-40`，`composeSkills` 逐个链式调用 `:79-86`）；实际实现只在 sheets（`ai/response-verify.ts:37`，`workbook-skill.ts:28` 挂载）与知识库 skill 里（`packages/agent-core/src/knowledge-base-skill.ts` 内的 citation 校验），**docs/slides/pdf/markdown/html 的内置 skill 没有实现该钩子**。请求失败落成气泡的 `error`（docs `ChatEntry.error` `:118`；pdf `:75` 附近）。`ai:stream` 的 `errorCode` 区分 timeout/credits/network/overloaded（`electron-transport.ts:16-25`）。
- **撤销**：
  - docs：每次 run 捕获一次快照（`captureSnapshot` `AiPanel.tsx:858`；首个 mutating 工具前 `snapshotBefore` `:870-872`），气泡上的回滚按钮 `:1632-1635` → `rollback` `:1330-1341`；track-changes 打开时 AI 修改以修订形式待接受（`:876-882`）。
  - slides：主进程 history batch（`beginHistoryBatch` `AiPanel.tsx:1789`；`session-state.ts:238-268`），每 run 一个 `snapshotId`，回滚走 `slidesApi.aiSnapshotRestore`（`:799-813`；主进程 `slides-main.ts:4516-4533`）；队列按页分组，每页一个 batch（`AiPanel.tsx:1855-1897`）。
  - sheets：自动应用后的内联 Undo + ⌘Z；undo 深度写入 `autoApplied.undoSteps`（`App.tsx:3630-3636,3714-3716`）。
  - markdown/html：面板内快照列表（markdown `AiPanel.tsx:203,429-438,766-770`；html `:328,730-739,1107-1111`）。
  - pdf：没有面板级 run 回滚；待定编辑由文档自身 undo 覆盖（工具描述 `ai/tools.ts:929`）。
- **没有审批**：除 PDF 不可逆文件操作的确认卡、docs 整篇重写的 `confirm()`（`App.tsx:5318-5326` `runAiProofread`，`AI_REWRITE_ACK_KEY`）外，AI 对文档的编辑**没有逐次人工批准**；队列/快照/撤销是它替代审批的机制。

---

## 3. 与 Mcode 的接口面：只嵌入 renderer + 现有最小 preload，会缺什么

### 3.1 现状

Mcode 的可视化轨是 `DocumentViewHost`（`apps/desktop/src/main/document/documentViewHost.ts`，`WebContentsView`，`contextIsolation+nodeIntegration:false+sandbox` 三项钉死，`:377-378`）挂 vendor 构建产物 `file://…/genoffice/apps/<host>/out/renderer/index.html`（URL 由 `GenofficeViewHostPane.tsx:153-170` 推导），preload 是**最小桥** `apps/desktop/src/main/document/documentViewPreload.ts`（146 行）：`openDocxPath`、`saveDocx`、`onMenuCommand` + 4 个写死默认值（`:80,95,114,125-134`），并在注释里明说「**不暴露 AI/知识库/附件**（vendor 的 AI 面板在本宿主里不接）」（`:38-40`）。`documentViewPreload.ts` 不暴露 `ipcRenderer`、不暴露 `projectApi`。

### 3.2 逐项缺口（以「AI 交互完整保留」为判据）

| # | vendor 需要的桥 | vendor 调用点 | vendor 提供方 | Mcode 现状 | 缺了会怎样 |
| --- | --- | --- | --- | --- | --- |
| 1 | 模型流 `aiStream/aiStreamCancel/onAiStream` | `AiPanel.tsx:742-743`（transport）→ `transport.ts:8-13`；preload docs `:212-213,242-246`；slides `:407-408,448`；sheets `:585-595`；pdf `:121-123`；markdown `:144-146`；html `:112-114` | 主进程 `ai:stream`：docs `docs-main.ts:4084-4206`（`streamForProvider:4150`）、cancel `:4207`；slides `ai-ipc.ts:122`（`registerAiIpc`）与 `:172`（`ai:stream`）；sheets `sheets-main.ts:3766`（`registerSheetsAiIpc`）；pdf/markdown/html 复用 shell 注册的 docs `registerAiIpc`（`shell/src/main/index.ts:6625`；pdf `shared/ipc.ts:870`、markdown `:203`、html `:126` 注释） | **Mcode 全仓无 `ai:stream`/`aiStream` 通道**（`apps/desktop/src` 与 `packages/contracts` grep 零命中） | 点确认后 transport 的 start 调用 `undefined`，被 catch 后变成一条错误回复；**没有任何模型流**，交互只剩空壳 |
| 2 | AI 设置/模型选择 | `App.tsx:1550`（**无保护**）、`AiPanel.tsx:353-359`（`MODEL_BRIDGE`）、`AiModelPicker.tsx:46-58`（有 catch） | preload docs `:203-244`；主进程 `ai:get-settings`/`ai:set-settings`/`ai:gsk-status`（`docs-main.ts:4028-4082`） | 最小 preload 只有 `getLanguage/getTheme/getDocumentTheme/getAutoSaveDefault`（`:125-128`），**无 getAiSettings 等** | ① `App.tsx:1549-1550` 的无保护 effect 抛错（见 3.3，整树会被 React 卸载）；② 模型选择器静默降级为未配置 |
| 3 | 聊天持久化 `projectApi.resolveChat/appendChat/loadChat/rebindChat` | docs `AiPanel.tsx:631,676,702`（有 `window.projectApi?` 保护）；preload docs `:277-285` | `project:resolveChat/appendChat/loadChat/rebindChat`（`docs-main.ts:4442/4462/4506/4522`）→ `ProjectStore`（`userData/.../chats/*.jsonl`，`store.ts:334-341`） | 最小 preload **不暴露 `projectApi`**（只 `exposeInMainWorld("desktop", …)`，`:146`） | 面板仍可当场聊，但**没有历史**；重开文件会话不续接（`loop.restore` 永不发生） |
| 4 | 知识库 `kbList/kbSearch/kbRead` | `AiPanel.tsx:828-834`（有 `typeof === 'function'` 保护）、`:437-441`；preload docs `:234-236` | shell `index.ts:4617-4657` | 无 | 知识库 skill 不挂载（vendor 本身是可选挂载，降级安全） |
| 5 | 附件 `readAttachment/readAttachmentImage/pickAttachments/addAttachmentPaths/addPastedImage/getPathForFile` | docs `AiPanel.tsx:469,1091,1287-1311`、`files-skill.ts:78`；preload `:231-233` 等 | docs main `docs-main.ts:5181-5230` 等 | 无 | 附件按钮/粘贴图片会失败（多数在事件处理器里，不会崩面板；`files-skill` 读附件会返回工具错误） |
| 6 | 搜索/媒体/生成：`webSearch/imageSearch/analyzeMedia/fetchImage/generateImage/createDocument` | docs `ai/tools.ts`（web_search `:434`、image_search `:447`、analyze_media `:460`、insert_image `:487`、generate_image `:500`、create_document `:623`）；preload `:103,216-222` | docs main `:4212/4223/4262/4285…`；`createAiDocument` `:5711` | 无 | 工具调用返回错误（`executeTool` 的 `window.desktop.X` 抛 TypeError 会被包成 isError 结果？——**未确认**：tools 里是直接调用、未见 try/catch，可能整个 run 失败）；`create_document` 一定会失败 |
| 7 | 打开/新建/密码/最近文件等**与 AI 无关但挡在首帧**的 API | docs `App.tsx:2129`（`onRenamedDocx`）、`:2145`（`onOpenDocx`）、`:2153-2156`（`consumePendingOpenDocx/consumeNewBlankDoc/consumeAiDocContent`）、`:1549`（`getRecentFiles`）；`openRecent` 里 `:2205`（`confirmDocumentReplace`） | preload docs `:82-116`、主进程 `docs:recent` 等 | 最小 preload 全无 | 见 3.3：**按源码推断，真实 docs 页面在最小 preload 下挂不起来**；宿主推送 `open-path` 后 `openRecent` 也会在 `confirmDocumentReplace` 处抛错 |
| 8 | 其余 app 的命名空间 | slides `window.slidesApi`（preload `:485`，含 `beginHistoryBatch/aiSnapshotRestore/getRecentFiles/onMenuCommand`）、sheets `window.desktopApi`（preload `:743`）、pdf `window.pdfApi`（`:140`）、markdown `window.markdownApi`（`:164`）、html `window.htmlApi`（`:132`） | 各自 preload | 最小 preload 只暴露 `desktop`；且 sheets/slides 的打开通道在 vendor 主进程（已由 `GenofficeViewHostPane.tsx:40-80` 逐条列证） | slides/sheets 连首帧都过不了（`GenofficeViewHostPane.tsx:68-75` 已注明：sheets `App.tsx:1729` 无保护 `getAiSettings`；slides `App.tsx:2312` 无保护 `onMenuCommand`） |
| 9 | 保存 | `file-actions.ts:1078,1100-1101,1114`（`saveDocxTo/saveDocxAs/saveDocxNew/saveDocx`） | 最小 preload 只给了三参 `saveDocx`（`:95-107`） | 「另存为/导出」入口会失败；普通保存/自动保存可用，且有宿主乐观锁 + 租约（`documentViewHost.ts:666` 起） | AI 改完不落盘——Mcode 侧没有任何「AI 结果自动保存」通道 |
| 10 | 主题/语言/侧栏偏好 | `@genoffice/ui` 的 `AiPanelSideButton`（`AiPanel.tsx:1429-1432`，调 `setAiPanelPrefs`）、`main.tsx` bootstrap 的 `getAiPanelPrefs` | preload docs `:200` 附近；`packages/ui/src/ai-panel-prefs-store.ts:50-60` | 无（最小 preload 只给只读默认值） | 面板可用但偏好不持久；`setAiPanelPrefs` 在事件处理器里，点了会报错 |

### 3.3 一个必须先核实的硬事实：最小 preload 可能连 docs 页面都挂不起来

源码事实链：

1. `apps/docs/src/renderer/App.tsx:1548-1552` 的挂载 effect **无保护**调用 `window.desktop.getRecentFiles()` 与 `window.desktop.getAiSettings()`；
2. `:2128-2139` 无保护调用 `window.desktop.onRenamedDocx(...)`；
3. `:2145-2158` 无保护调用 `window.desktop.onOpenDocx(...)` 与 `consumePendingOpenDocx/consumeNewBlankDoc/consumeAiDocContent`；
4. 最小 preload（`documentViewPreload.ts`）不含以上任何一个（grep 确认；其自身注释 `:136-143` 声明「文件对话框/AI 设置/附件」都不提供）；
5. vendor 用 React **19.2.7**（`genoffice/apps/docs/package.json:44`），`main.tsx` 的根**没有错误边界**（全仓 `componentDidCatch/getDerivedStateFromError` 只命中 React 内部）。
6. 隔离探针（2026-10-18 实测，用 vendor 自己的 `node_modules/react-dom@19.2.7` 生产构建 + jsdom，复刻上述 effect 形状；临时脚本写在 `.tmp/` 下、运行后已删除，复刻方法：`createRoot` 渲染一个空依赖 effect 里调用 `window.desktop.onRenamedDocx(...)` 的组件，`window.desktop` 用最小 preload 的同一组键）：passive effect 抛错 → `onUncaughtError` 走 `reportGlobalError`，**`createRoot` 容器被清空（`unmounted: true`）**，兄弟节点一并消失。

推论：**按当前源码，真实 docs 页面在 Mcode 最小 preload 下应当整树卸载（白屏），而不是「编辑器起始页」**。这与上一轮台账/面板注释里「视图里是编辑器起始页」的描述矛盾（`audit-ledgers/Mcode_统一审查台账.md` ARC-007 切片记录；`document-view-host-smoke/main.ts:585-587` 也承认「本宿主刻意不给 preload」）。两种可能：① 真机表现与源码推断一致，上一轮没有用真实 vendor 页面做过 U1（`document-view-electron-smoke/probe.ts:7,26` 明确写「套件自己造一个最小 HTML 页面」「不加载 genoffice 真实编辑器」）；② 构建产物还有未读到的 shim。**在动 AI 之前，必须先用真 Electron 加载真实 `apps/docs/out/renderer/index.html` 目视一次**（见第 6 节）。这一步不通过，「保留 AI 交互」无从谈起。

### 3.4 结论

vendor 的 AI 交互**不是纯渲染端功能**：它依赖 vendor 的 Electron 主进程（`ai:stream` 的网络与凭据、`project:*` 的聊天存储、`files:/kb:*` 的工具通道、`create_document` 的文件落盘），以及一份完整的 docs preload（`apps/docs/src/preload/index.ts`，`wc -l` 实测 **288 行**；Mcode `documentViewPreload.ts:16` 的注释写 284 行，以实测为准）。Mcode 现有「DocumentViewHost + 最小 preload」在 AI 方向上**一项都没有接**；且在接 AI 之前，首帧所需的普通 API 也缺，真实页面无法可靠启动。

---

## 4. 「完全保留」的三种落法与代价

### 方案 A：原样跑 vendor 的 AI 面板 + vendor 的 ai-provider，宿主只做权限/网络/凭据代理

**需要的 vendor 模块**：全部 `apps/*/src/preload/index.ts`（docs `wc -l` 288 行、sheets 3967 行）；主进程 AI 段 `registerAiIpc`（docs `docs-main.ts:4026-4356`）与 `registerSheetsAiIpc`（`sheets-main.ts:3766`）、slides `ai-ipc.ts`；`packages/ai-provider`（网络/流/协议）、`packages/ai-search`（搜索与 gsk 登录，`require('electron')`）、`packages/project-store`（聊天历史）、`packages/electron-utils`（fetch 图片等）；各 app 的 `AiPanel`/popover/queue（本就是渲染端文件）。

**是否需要 vendor 主进程**：**是**。`ai:stream`/`ai:get-settings`/`project:*`/`files:*`/`kb:*`/`create_document` 都是 `ipcMain.handle`，且 `registerAiIpc` 被 import 自 `docs-main`（`shell/src/main/index.ts:146,6625`），会一并拉进 docs 主进程模块（打开/保存/密码/菜单等）。可以在 Mcode 主进程里调这些注册函数（同一 Electron 进程），但等于把 vendor 的 AI 主进程逻辑整体搬进来。

**与 Mcode 原则的冲突**：
- **三引擎唯一 Agent**：直接冲突——多出 vendor `AgentLoop` + `ai-provider` 这一整套第二 Agent/第四引擎（`packages/agent-core/src/loop.ts:470`；台账 `Mcode_统一审查台账.md:2927` 第 1 条「不引入 GenOffice 第二套 Agent loop / 用户/存储/权限」）。
- **凭据/网络**：Genspark 登录（`ai-search/src/genoffice-auth.ts:69,105` 用 Electron `net`/`session`）绕过 Mcode 的供应商设置与审计；BYOK 密钥落 vendor `userData/ai-settings.json`（`docs-main.ts` `SETTINGS_PATH()`），不是 Mcode 的设置库。
- **审批/围栏**：vendor AI 对文档的编辑没有逐次审批（见 2.3）；`create_document` 会把模型内容写到 vendor「保存目录」（`createAiDocument`，`docs-main.ts:5711-5740`），不经 Mcode 的 path guard / 操作账本。落盘通道 `saveDocx` 虽可继续用 Mcode 的版本租约（`documentViewHost.ts:666`），但 AI 文件生成绕过去了。
- **聊天存储**：vendor `project-store`（`userData/chats`）与 Mcode 会话存储是两份真相。

**代价**：保真度最高（交互和后端都是原版），但架构上等于在 Mcode 里再开一个 AI 产品；安全面最大（完整 preload + Genspark 云路由）；升级时要同时跟 vendor AI 层与 Mcode 三引擎两套演进。**不建议作为终态**；只适合作为「先证明用户要的交互确实被保留」的短期诊断/原型。

### 方案 B：保留 vendor 的 UI 交互（选择→弹框→侧栏会话），后端换成 Mcode 三引擎（经 Host RPC / 同一工具面）

**需要的 vendor 模块**：各 app 的 `AiAskPopover`/`AiPanel`/`EditQueueCard`/`edit-queue`（渲染端）；**不需要** vendor 主进程 AI 段、`ai-provider`、`ai-search`、`project-store`。文档操作复用 vendor 已有的一条现成通道：`docs:mcp-command` → renderer `mcp-bridge.ts` 用**内置 agent 的同一批执行器**跑 `insert_content/replace_blocks/apply_ops/read_document/save_document`（`apps/docs/src/renderer/mcp-bridge.ts:1-30,214-244`；shell 端 `apps/shell/src/main/mcp/docs-bridge.ts:1-20`；命令枚举 `apps/shell/src/main/mcp/tools/document-tools.ts:47-61`）。sheets 也有 `mcp-bridge.ts`（`apps/sheets/src/renderer/mcp-bridge.ts`），slides/pdf/markdown/html 需要补对端。

**是否需要 vendor 主进程**：**否**（若把 Mcode 的三引擎会话当作唯一 loop）。但注意：Mcode 的三引擎是**会话级 agent 运行时**（`claude.sendTurn`，`packages/contracts/src/ipc/rpcMap.ts:175`），不是「可给外部 loop 调用的裸 tool-calling 网关」；要做 B，必须新增一条 Mcode 的文档助手通路，把模型的工具调用转成 `doc.*`/`docs:mcp-command`，或在 Mcode 侧实现一层「文档 turn」RPC。

**与 Mcode 原则的冲突**：方向相反——B 是**最合规**的（唯一 Agent、审批/围栏都在 Mcode），但**用户要的「完全保留」变成「等价复刻」**：vendor 的 `AiPanel` 若保留，它内部的 `AgentLoop` 就还在；若换成 Mcode 的聊天侧栏，则交互的视觉/手感/消息模型要重做一遍（5 个 app，见 1.8）。这正是旧计划里判为「B 不推荐」的原因（`genoffice-integration-frontend-redesign.md:203`：各编辑器 App.tsx 未组件化，抽 React 组件成本高于收益）。

**代价**：架构最干净；工程最大；最容易在「复刻」中丢掉用户喜欢的细节（浮动 chip 的跟随、队列行、元素 pin、`AiScopeQuote`）。

### 方案 C：混合——UI 与消息模型保留（vendor 的 popover/队列/侧栏），模型调用可切换 Mcode 引擎

**形态**：保留 vendor 的交互层文件（`AiAskPopover`、`AiPanel`、`EditQueueCard`、`edit-queue`）与消息模型（`ChatEntry`/`AiChatMessage`、`scope`、`snapshotId/autoApplied`），把 `runWith` 下游拆成两条合同：

1. **模型流**：把 `createElectronTransport` 的 `aiStream/onAiStream` 换成一条 **Host RPC**（例如 `genoffice.aiTurn` / `aiStream`），由 Mcode 主进程按用户配置的供应商/引擎产生 `delta/tool-call/done` 流。vendor 的 `AgentLoop` 继续在渲染端做 tool 循环（它只是回调式状态机，`loop.ts:470-582`），工具执行器继续跑在活编辑器上（保持 2.2 的 ops 与 2.3 的快照/撤销语义不变）。
2. **聊天存储**：`projectApi` 换成 Mcode 的文档会话存储（按文件身份 + documentId 关联，复用 ARC-007 的 `DocumentSessionRegistry` 判据），不再写 vendor `userData/chats`。

**需要的 vendor 模块**：渲染端交互全套（同 B）；**不需要** vendor 主进程 AI 段与 vendor `project-store`；**需要** `agent-core` 的 `AgentLoop`（或把它的 tool-loop 语义移植进一个薄适配层）。

**是否需要 vendor 主进程**：**否**（模型由 Mcode 主进程出；工具在 renderer）。

**冲突点与边界**：
- 与「三引擎唯一 Agent」：**仍有一处需要裁决**——vendor 的 `AgentLoop` 仍是第二个 tool 循环。若把「唯一 Agent」解释为「唯一模型/凭据/审批 owner」而不是「唯一 tool 循环」，C 可接受（模型与网络都在 Mcode）；若解释为绝对「不得有第二 loop」，C 不成立，只能走 B。
- 审批/围栏：文档内编辑仍无逐次审批（vendor 现状），但都在内存里且有一键撤销；**必须把落盘、外部网络、生成文件（`create_document`）、危险操作（PDF 不可逆）接到 Mcode 的审批/账本**——这些是低改动、高收益的接点。
- 存储：聊天历史归 Mcode；`ChatEntry` 的渲染可以保留 vendor 组件。
- 升级：UI 层仍需跟 vendor 的 popover/queue 补丁同步（fork manifest 已有先例，ARC-007 G0 已建）。

**代价**：交互保真度高（用户点过的那套 UI 原样在），后端归 Mcode，审批/围栏可逐项加；中间层（Host RPC + 文档会话存储 + 活编辑器工具桥）是新增工程，但每一块都是 Mcode 已有能力的组合（RPC/契约/权限/会话），不是新造 Agent。

### 推荐

**推荐 C（先 A-lite 验证，再 C 收敛）**：

1. **第一步（保真验证，短周期）**：按 A 的受控子集跑通「原样 UI + vendor 流」，只允许 **BYOK/本机端点**（禁用 Genspark 登录与云路由），聊天落临时目录，Mcode 只做设置/凭据注入与网络审计。目的：**用真 Electron 证明用户描述的那条链路可复现**（选择→弹框→确认→队列行→侧栏→文档改动→撤销）。这一步不承诺架构。
2. **第二步（终态）**：切到 C——transport 换 Host RPC（Mcode 供应商/三引擎），`projectApi` 换 Mcode 文档会话存储，`create_document`/`web_search`/`generate_image`/`saveDocx` 等**离开文档内存的操作**全部过 Mcode 审批与路径围栏；vendor 的 `AiPanel`/popover/queue 作为渲染层保留，列入 vendor manifest 的受控补丁。
3. **不建议 A 作终态，也不建议 B 作首选**：A 把第二套 Agent/凭据/存储整体搬进来；B 最合规但会把用户点名称赞的交互重做一遍，违背「完全保留」的原话。若治理上把「三引擎唯一 Agent」定为不可让步，则只剩 B——这一点需要用户/台账明确裁决（见第 5 节）。

---

## 5. 与现有计划的冲突（明确写出被推翻的句子）

**旧计划中与本需求直接冲突、已被用户需求覆盖的原句**：

1. `docs/planning/genoffice-integration-frontend-redesign.md:20`：
   > 「**无头轨**：……不要把 GenOffice 内建 AI 面板与 Agent loop 再当成第四个引擎接进来。」
   —— **被覆盖的 part**：「不要把 GenOffice 内建 AI 面板……接进来」。用户明确要求保留该交互，面板/弹框/队列/侧栏必须接。**仍保留的 part**：「不要当成第四个引擎」——这正是 C 要守的：模型/凭据/网络归 Mcode，vendor 只留 UI 与 tool 循环适配。

2. `docs/planning/genoffice-integration-frontend-redesign.md:62`：
   > 「不引入 GenOffice 独立用户身份、聊天模型层、第二个项目管理/资料库、第二套快捷键总线、第二个自动化系统……」
   —— **被覆盖的 part**：「**聊天模型层**」不得引入。A 方案与该句正面冲突；C 通过把模型层换成 Mcode 的 Host RPC 让这句话在终态仍然成立。其余各项（用户身份、项目管理、资料库、快捷键、自动化）继续有效。

3. `docs/planning/genoffice-integration-frontend-redesign.md:202`：
   > 「**A（随后）**：受控 WebContentsView 模块（复用 configure*Runtime/register*Ipc），替换文件对话框与保存为 Mcode 服务，**不注册 ai:***；」
   —— **「不注册 `ai:*`」被覆盖**：C 至少要注册一条 AI 通道（可以是 Mcode 自己的 `genoffice.aiTurn`，也可以沿用 `ai:stream` 名字但由 Mcode 实现）。「文件对话框与保存为 Mcode 服务」继续有效。

4. `docs/planning/genoffice-integration-frontend-redesign.md:251`：
   > 「文档可作为工作流节点、自动化产物及资料库资源；**不生成另一个“仅 GenOffice AI 才能编辑”的孤岛**。」
   —— **不推翻，转为约束**：C 必须保证同一条 `doc.read/apply/save` 也能被 Mcode Agent（`app_api_call`）与工作流使用，否则就真成了孤岛。

5. `audit-ledgers/Mcode_统一审查台账.md:2927`（ARC-007「不可让步」第 1 条）：
   > 「1) 不引入 GenOffice 第二套 Agent loop / 用户/存储/权限；」
   —— **「第二套 Agent loop」被用户需求部分覆盖**：为保留交互，UI 层会出现 vendor 的 tool 循环（C）或完整 Agent+provider（A）。「用户/存储/权限」三项继续不可让步：不得引入 vendor 用户身份、聊天存储与权限模型（C 的第二步把这些全部换回 Mcode）。**这一条需要用户/维护者显式裁决**：若坚持「绝不出现第二 loop」，则只能 B，交互只能等价复刻——本文档推荐 C 的理由是用户原话「**完全的保留下来**」优先于这条构建层纪律。

6. 同文件的补充说明已经记录了这次转折：`docs/planning/genoffice-integration-frontend-redesign.md:185`：
   > 「**结论（2026-10-18 已被用户需求推翻 —— 见下）**：原方案是「保留 AI 管线/工具协议、去掉聊天 UI」的构建层排除。**这条不再成立**……因此 `AiPanel` 与它的选择→弹框→侧栏会话交互**要保留**；需要重新裁决的是后端（vendor 的 ai-provider vs Mcode 三引擎）与权限/审批的接法，而不是「去掉聊天 UI」。测绘与三种落法见 `docs/planning/genoffice-ai-interaction.md`。」

   本文档就是该处指向的测绘；它把「保留聊天 UI」进一步落到**保留 popover + 编辑队列 + 元素锚点**这一整条链路，并给出后端裁决（推荐 C）。

**不受影响、继续有效的旧约束**：`genoffice-integration-frontend-redesign.md` 第 62 行的其余内容、第三/七节的许可证与安全边界、ARC-007 的 `ee/` 排除、真 Electron/跨格式验收门槛（`Mcode_统一审查台账.md:2925-2931`）。

---

## 6. 验证方式建议：怎样证明「交互被完整保留」

### 6.1 验收判据（用户可观察行为）

在真 Electron 下，对 docs 与 slides 至少各走一遍：

1. 打开真实 vendor 编辑器页（`genoffice/apps/{docs,slides}/out/renderer/index.html`，两者当前均已构建，见 6.5）；
2. 选中一个元素/段落 → 出现浮动「Ask AI」chip（`.ai-ask-trigger`）；
3. 点击 → 出现锚定输入气泡（`.ai-ask-pop`），标题/摘要与所选元素一致；
4. 输入一句话 → 回车/点「加入队列」；
5. **侧栏 AI 面板自动可见**，且队列行（`.ai-queue-row`）显示这句话与元素摘要（这正对应用户原话「记录直接显示到了侧边栏」）；
6. 点侧栏「发送」→ 聊天中出现 user 气泡（含 `AiScopeQuote`）→ 模型流式回复 → 文档真的被改（可在页面 DOM/Tiptap/渲染树断言）；
7. 点气泡上的撤销/回滚 → 文档恢复；队列行消失；无孤儿锚点。

### 6.2 可无头（headless）测的部分

- **队列/锚点纯逻辑**：vendor 已有单测可复用/移植——`apps/docs/tests/ai-edit-queue.test.ts`、`apps/slides/tests/ai-edit-queue.test.ts`、`apps/html/tests/edit-queue.test.ts`、`apps/markdown/tests/edit-queue-redaction.test.ts`（锚点解析、自底向上排序、redact、失配）。这些不依赖 Electron。
- **定位纯函数**：sheets `ai/selection-ask.ts`（拖拽阈值/翻转位置）、popover 的放置算法（各 `AiAskPopover.tsx` 内联，若要测需先抽出）。
- **transport 合同**：用 fake stream 仿 `packages/agent-core/tests/electron-transport.test.ts` 的写法，证明 `tool-call → executeTool → 气泡 → snapshot` 全链，不发网络。
- **交互 DOM（半无头）**：用 Playwright 起 vendor 构建页（或 jsdom + vendor React 19.2.7）加载真实 `AiPanel` 源码，按 `genoffice/e2e/html-tab.spec.ts:272-417` 的套路断言：浮动按钮出现 → 点开 `.ai-ask-pop` → 填 `.ai-ask-pop-input` → `.ai-ask-confirm` → `.copilot .ai-queue-row` 出现并可点回编辑。**这套 e2e 不调模型**（只验证交互），可作第一道网。
- **会话持久化**：用 Mcode 的 fake IPC 模式验证 `appendChat/loadChat` 落到预期存储，且重开后 `loop.restore` 被调用。

### 6.3 只能真 Electron 验的部分

- 原生 `WebContentsView` 上的 popover 是否被宿主侧边栏/对话框/窗口边缘裁掉（popover 的 band 逻辑读的是 `window.innerHeight`，即**视图**高度，不是整窗；`AiAskPopover.tsx:210-226`）；
- 焦点与快捷键：视图内输入框、编辑器选区高亮（docs 的 `inactive-selection`）、Esc/Enter 是否被宿主截走；
- 视图 bounds 切换（切标签/隐藏）时队列卡片与聊天状态不丢（vendor 面板是 always-mounted，`App.tsx:7383-7385` 注释）；
- 「侧栏自动展开」的视觉效果与滚动位置。

### 6.4 建议新增的 Mcode 套件（沿用仓库既有模式）

1. **`genoffice-ai-interaction-renderer-smoke`（无头）**：真源码 `AiAskPopover`/`EditQueueCard`/`edit-queue` + 极小 React 运行时或 jsdom；断言「选中→chip→pop→队列行→侧栏卡片」与「立即发送→user 气泡 + scope quote」；变异：撤掉 `onQueueAdd`/chip 渲染/队列卡片 → 必须真红（仓库硬规矩：先看红再装回）。
2. **`genoffice-ai-interaction-electron-smoke`（真 Electron，仿 `document-view-electron-smoke`）**：`MCODE_DV_DIR` 隔离所有 app 路径（`electron-host.cjs:8-19` 的骨架），真窗口 + 真 `DocumentViewHost` + **真实 vendor 页面**（不再是自造最小页），注入契约版 preload + 本地 mock 模型端点（仿 `genoffice/e2e/settings-custom-endpoint-gateway.spec.ts:29-115` 的 `createServer`），用 CDP 驱动 6.1 的 1-7 步。**先决条件**：3.3 的页面启动问题必须先解决（补 preload 或注入 shim），否则套件只能验「白屏」。
3. **跨文档一致性**：同一套断言在 docs 与 slides 各跑一遍（两者交互最接近用户描述）；sheets/pdf 各自断言「无队列、立即发送」的差异。

### 6.5 当前可直接执行的检查清单（测绘时已核实）

- `genoffice/apps/docs/out/renderer` 与 `slides/out/renderer` **已构建**；`sheets/pdf/markdown/html` 的 `out/renderer` **未构建**（本次 `ls` 核实），后四个 app 的真机 U1 暂无页面可加载。
- Mcode 仓库内 Electron 二进制存在于 `node_modules/.pnpm/electron@44.4.5_.../dist/electron.exe`（可跑真 Electron 套件）；vendor 自己的 `node_modules/electron/dist` **没有**下载二进制（`npm install --ignore-scripts` 的后效），所以「在 Mcode 的 Electron 里加载 vendor 页面」是可行路径，直接用 vendor 的 electron 跑不起来。
- 本次未运行任何真 Electron 应用；3.3 的结论是「源码 + 同版本 React 隔离探针」，必须用 6.4 的第 2 套件在真机复核。

---

## 7. 未找到 / 未确定清单（如实）

- **未找到**任何命令面板（command palette）形态的 AI 入口：`CommandPalette|selectionMenu` 在 docs/slides/sheets 渲染端 grep 零命中；交互形态就是浮动 chip / 锚定 popover / markup bar 按钮 / 检查器工具栏四种，没有第五种。
- **未找到** docs 的 `queueAdd` 主动展开侧栏（`App.tsx:6284-6295`）；slides/html 会展开（`slides App.tsx:1448-1452`、`html App.tsx:1009`）、markdown 的立即发送会展开（`:1065-1069`）、sheets 会展开（`ExcelShell.tsx:1018-1021`）。「确认后侧栏出现」在 docs 依赖面板已开；若用户当时面板收起，只会出现 rail（`AiPanel.tsx:1381-1396`）。这是各 app 的不一致，测绘如实记录，未改。
- **未找到** vendor AI 的逐工具审批 UI（除 PDF 不可逆操作确认卡与 docs 整篇重写 ack）；「队列 + 快照 + 撤销」是替代机制。
- **未找到** docs/slides/pdf/markdown/html 的 `verifyResponse`（防「宣称改了却没改」的钩子）实现；只有 sheets 有（`ai/response-verify.ts:37`）。这是 vendor 自身的不一致，C 方案若要补齐，应放在 Mcode 侧的适配层。
- **未找到** Mcode 侧任何 raw tool-calling 模型网关 RPC；`claude.sendTurn` 是会话级（`rpcMap.ts:175`），`lib/modelEndpoint.ts` 只做模型列表/连通性探测。C 方案需要新增一层，可行性未做代码验证。
- **未确定**工具执行器在缺少 `window.desktop.webSearch` 等 API 时的行为：`apps/docs/src/renderer/ai/tools.ts` 的工具分支是否全部包了 try/catch 未逐一确认；有些（如 `create_document`）会直接失败，是否中断整个 run 取决于 `AgentLoop` 对同步抛错的包装（`loop.ts:1172-1240` 区域只看了片段）。这是 A/C 首轮接线时必须实测的点。
- **未确定**真实 docs 页面在最小 preload 下的真机表现（3.3）。源码 + React 19.2.7 生产构建探针均指向「整树卸载」，与上一轮台账「编辑器起始页」的描述冲突；必须以真 Electron 加载真实页面核实。
- **未确定** `registerAiIpc` 从 `docs-main` 导入后在 Mcode 主进程的副作用范围（它会 import 整个 docs 主进程模块，含窗口/菜单/保存逻辑）；A 方案的成本需要一次「只 import 看看拉进多少」的构建验证。
- **未确定** slides/pdf/markdown/html 的 `out/renderer` 构建在本机的可行时间（sheets 需 Rust sidecar，PDF 需 pdfium.wasm）；本次只核实了 docs/slides 已构建。

---

## 8. 附：一句话给实施者的摘要

用户要保留的是 **「浮动 Ask AI chip → 锚定输入框 → 队列行进入侧栏 → 批量提交成聊天记录」** 这一整套交互（docs/markdown/html/slides 同构，sheets/pdf 为立即发送变体）。它今天的后端是 vendor 自己的 `AgentLoop + ai-provider + project-store`，全部长在 vendor 主进程与完整 preload 上；Mcode 现有 `DocumentViewHost + 最小 preload` 一项都没接，而且按源码连页面首帧都可能过不了。**推荐 C**：UI 与消息模型原样保留，模型流与聊天存储换成 Mcode 的 Host RPC/文档会话，文档编辑仍由活编辑器工具执行器完成（保留快照/撤销语义），落盘与外部副作用过 Mcode 审批与围栏；A 仅作短期保真验证，B 仅在「三引擎唯一 Agent」被解释为绝对禁令时采用，代价是交互从「保留」降级为「等价复刻」。
