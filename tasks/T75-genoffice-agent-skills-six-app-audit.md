# T75｜GenOffice 六编辑器原厂 AgentSkill 与 Mcode AI 的真实调用链审计

| 项目 | 值 |
|---|---|
| 编号 | T75（为路线图 T31/T32/T33 降低重复开发） |
| 工作包 | ARC-007 FULL-3 AI 互通能力 |
| 优先级 | P0：先证明六个原生 AI 面板能调用编辑器本机技能 |
| 路线 | L1 保留 GenOffice renderer `AgentSkill.executeTool` + L2 Mcode `ai:stream`/会话授权桥 |
| 可派 | **立即，只读**；与所有业务开发卡兼容 |
| 写边界 | 仅本卡结果回写和 `.tmp/t75-*` 只读分析输出；不可改 `genoffice/*`、`main/document/*`、`main/appControl/*` 或 tests |


## 背景
`tasks/GENOFFICE-ROADMAP.md` 阶段 2 明确：原厂 `AgentSkill` 存在渲染端并直接操作编辑器对象；**不要搬入 Mcode 主进程重写**。T05c/T28/T29/T53 已有 Docs 和多格式 `ai:stream` 宿主测试，但目前没有可靠证据表明六个原厂编辑器“选区→原生编辑指令→原生工具执行→用户可见修改→撤销”都可用。此卡找真正断点，不先扩充新代理 API。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/GENOFFICE-ROADMAP.md` 阶段 2、T05c/T28/T29/T53/T54 的回写。
2. 六个上游编辑器 `genoffice/apps/{docs,sheets,slides,pdf,markdown,html}` 中 AI transport、AgentSkill、`executeTool` 实际路径及工具列表（用搜索找到，不能想当然）。
3. Mcode 的 `src/main/document/docsAiPorts.ts`、`genofficeViewFactories.ts`、`genofficeViewAiVendor.ts`、`documentViewHost.ts`，以及 `genoffice-ai-ask-smoke`、`genoffice-native-view-smoke`。
4. 对应原厂 `packages/agent-core`，辨别 renderer 工具和 Host 工具分别在哪运行。

## 执行内容
1. 输出 6 app × `ai:stream` 接线/消息 schema/发送方身份/取消/选区/AgentSkill 工具列表/原生编辑回写/撤销/只读限制 的矩阵，每格注明 E2/E1/U1 或未知。
2. 逐个追踪一次“用户选区提问→Mcode 三 SDK/provider→工具调用→原厂编辑器 apply→持久化”调用链；无 U1 就标 U1 未验，不在分析中把 mock 工具调用替代编辑器执行。
3. 查是否有第二份工具执行器、绕过宿主授权、用户所选 session 被 vendor payload 假冒、跨 pane 的状态泄漏。只记录可定位调用链与真实测试证据，不改代码。
4. 明确 T31（共用 AI transport）、T32（保持 renderer AgentSkill）、T33（Agent 反向利用编辑器选区上下文）**哪些实际上已经有、哪些缺生产调用、哪些欠 U1**。
5. 按“最小文件边界+前置+红例+功能”建议 2–4 张开发卡给总控；不要在本卡擅自改编辑器内核、直连原厂云模型或换新 Agent loop。

## 验收判据
1. 六格式每个至少一条原始源码地址与当前能力结论，完整矩阵无空格，未知如实标记。
2. 拟称可用的功能必须有调用链到实际原厂 `executeTool` 或证实无需该工具；仅 `ai:stream` 事件抵达不代表可编辑。
3. 来源清单和安全域归属明确，能识别面板伪 session/缺取消/跨文档写权限等风险。
4. 后续建议卡相互不抢文件，且不与 T49/T64/T65 或 T30 在飞范围重叠。
5. 纯静态 E2 不宣称真三 SDK 与 Electron U1，未新增断言则变异 N/A；回写版本/证据/remaining。

## 不做
不运行在线模型、不向真实资料发写命令、不切换生产 provider、不新写工具/重写 skill、不改任何业务文件。

## 结果回写区

<!-- 只在下面追加：提交 SHA、旧红→新绿、原始命令/日志、变异/还原字节、剩余未验；不得覆盖本任务正文。 -->

### 2026-10-21｜T75 六编辑器 AI/AgentSkill 源码审计结果（只读，E2 为主）

**版本与方法**：根仓库审计起点 `de6a13e3138d0e59232e8b82c191b5b9da1d036e`（`master`）；GenOffice 固定源码 `aba076cc9b292461cc419288ee555e524f6250e1`（`genoffice` 子仓库检查时无工作树改动）。读取本任务及 `audit-ledgers/README.md`、`tasks/GENOFFICE-ROADMAP.md` 阶段 2、`tasks/T05c-docs-ai-panel.md`、`T28-genoffice-pdf-markdown-html.md`、`T29-genoffice-sheets-slides.md`、`T53-genoffice-sheet-slide-verification.md`、`T54-vendor-pane-ipc-fencing.md` 回写；通过 Mcode `agent_read_file`、`agent_grep`、`agent_glob`、只读 `git` 查询核对真实源文件与函数。**本任务没有运行新 smoke / 在线模型 / 真 Electron 人工旅程，没有修改生产代码。E2=当前源码调用链；“E1-历史”仅为其他任务已有隔离动态证据、非本次复跑；未知/U1 未验不能写成 PASS。变异验证 N/A（审计未新增断言或修复）。**

#### 1. 六个 app × 九个检查维度

表内简写：**桥**＝原厂 `createIpcTransport` 到 Mcode AI IPC；**文流**＝宿主最终仅发 `delta/reasoning/done/error`，没有 `tool-call/usage`，因此不能驱动原厂 `AgentLoop.executeTool`；**原厂可执行**＝原始 renderer skill 本身拥有编辑器对象和 executor，但**不代表经生产 Mcode SDK 已调用成功**。所有“原厂可执行”的完整 Mcode→编辑器→磁盘 U1 均**未验**。

| 编辑器 | `ai:stream` 接线 | 消息 schema | 发送方身份／会话 | 取消 | 选区／上下文 | AgentSkill 工具（代表项；详见下文） | 原生编辑回写 | 撤销 | 只读约束 |
|---|---|---|---|---|---|---|---|---|---|
| **Docs** | **E2**：`window.desktop`→scoped `mcode:docs:ai-stream`→`registerDocsAiIpc` | **E2**：入站 requestId/messages/tools；输出**文流**，缺 `tool-call` | **E2**：`DocumentViewHost` 真实 sender→docId→绑定 Mcode 会话；`resolveDocsAiSession` 再验 provider/路径 | **E2**：sender+requestId AbortController；SDK handle interrupt | **E2**：`createDocsSkill.buildContext` 冻结选区并取文档骨架 | **E2**：`get_document_context`、`replace_selection`、`apply_ops`、`write_document` 等 | **E2**：`docs/ai/tools.ts:executeTool` 可改 TipTap；**E1-历史** vendor mock 修改/落盘，**生产 Mcode 未闭环** | **E2**：`AiPanel.rollback` 恢复 run 前 JSON snapshot；U1 未验 | **未知**：未建立全部 AI 写命令的统一宿主只读拒绝证据 |
| **Sheets** | **E2**：`window.desktopApi`→`ai:stream`→五格式共享 `registerViewAiIpc`；Mcode `createSheetsView(includeAiHandlers:false)` 不启原厂云流 | **E2**：同一 `IpcStreamStart` 输入、**文流**输出 | **E2**：sender→`sheets` view→授权文件/会话；输入伪 session 被丢弃 | **E2**：共享桥按 sender+requestId abort | **E2**：`aiScope/aiRunScopeRef`、`buildWorkbookContext`；具体选区冻结规则在原厂 renderer | **E2**：`read_range`、`find_cells`、`propose_operations`、`create_document` 等 | **E2**：`executeWorkbookTool`→原厂 Univer/sidecar 操作；**Mcode 产出的工具调用未到此处** | **E2**：原厂 Univer 撤销服务与 AI 操作批次；**逐回合可撤销 U1 未验** | **部分 E2**：上下文有 `readOnlyOversized`；所有操作均拒绝的覆盖性**未知** |
| **Slides** | **E2**：`window.slidesApi`→`ai:stream`→共享桥；原厂独立通用 `registerAiIpc` 非 Mcode 入口 | **E2**：同输入、**文流**输出；额外 `ai:generate-image/analyze-media` 不在桥内 | **E2**：sender→`slides` live view；宿主额外校验页面 URL；**额外媒体 IPC 不经此校验** | **E2**：共享桥取消；额外原厂媒体路径取消/授权**未知** | **E2**：`AiPanel` 缓存 slide/element selection；`createSlidesSkill` 提取 deck outline | **E2**：`read_slide`、`execute_slide_script`、`apply_ops`、`generate_deck` 等 | **E2**：`slides-skill.ts:executeTool`→`access.applySlide/applyOps`；**生产 Mcode 未闭环** | **E2**：AI 面板 `onUndo` 和 deck 操作历史入口；运行后真实撤销 U1 未验 | **部分 E2**：nested/locked 元素受限；全编辑器统一只读判据**未知** |
| **PDF** | **E2**：`window.pdfApi`→`ai:stream`→共享桥 | **E2**：同输入、**文流**输出 | **E2**：sender→`pdf` view→会话与文件路径 | **E2**：共享桥 abort；上游传输 cancel 已接 | **E2**：`createPdfSkill.buildContext` 注入页码/选区/注释/加密状态 | **E2**：`read_pages`、`markup_text`、`edit_text`、`apply_ops`、`insert_blank_page` 等 | **E2**：`executePdfTool`→原厂 PDF 编辑 access；**生产 Mcode 未闭环** | **E2**：`pdf/App.tsx` `undoStack`；AI 回合粒度 U1 未验 | **E2**：多种写工具在 executor 内 `deps.readOnly()`→`READONLY_OUTPUT`，但未声称所有命令穷举 |
| **Markdown** | **E2**：`window.markdownApi`→`ai:stream`→共享桥 | **E2**：同输入、**文流**输出 | **E2**：sender→`markdown` view→会话与文件路径 | **E2**：共享桥 abort | **E2**：`buildDocContext` 和冻结发送时选区/定位 | **E2**：`read_blocks`、`apply_ops`、`write_document`、`read_frontmatter` 等 | **E2**：`markdown/ai/tools.ts:executeTool`→TipTap/frontmatter；**生产 Mcode 未闭环** | **E2**：`AiPanel.restoreSnapshot`，`onRunDone(mutated)` 保存接线；U1 未验 | **未知**：未见通用只读输入限制可证明所有写工具安全 |
| **HTML** | **E2**：`window.htmlApi`→`ai:stream`→共享桥 | **E2**：同输入、**文流**输出 | **E2**：sender→`html` view→会话与文件路径 | **E2**：共享桥 abort | **E2**：`getSelectedSid`、源码 `getMap/getVersion`、`get_outline` | **E2**：`get_outline`、`read_source`、`apply_ops`、`plan_page`、`write_document` 等 | **E2**：`createHtmlSkillCore.executeTool`→`HtmlDocAccess.applyOps/replaceAll`；**生产 Mcode 未闭环** | **E2**：`AiPanel.restoreSnapshot`，`onRunDone(mutated)`；U1 未验 | **未知**：未证明所有 AI 写入遵守宿主只读模式 |

**每格式源码锚点（工具名与执行器来自真实定义，而不是猜测）**：
- Docs：`genoffice/apps/docs/src/renderer/ai/transport.ts`；`src/renderer/ai/AiPanel.tsx:824-858,1330-1339`；`src/renderer/ai/docs-skill.ts:36-107`；`src/renderer/ai/tools.ts:91-640,1187,1459-1510`。额外 `files-skill.ts` 的 `read_attachment`、条件 KB skill；原厂 `mcp-bridge.ts:106-150` 也**复用同一个 `executeTool`**，并非另抄写一份编辑器算法。
- Sheets：`genoffice/apps/sheets/src/renderer/ai/transport.ts`；`src/renderer/App.tsx:748-769,1374-1389`；`src/renderer/ai/workbook-skill.ts:21-27`；`src/renderer/ai/tools.ts:266-545,1273-1362`。附加 files/merge/search/image skills 工具有 `read_attachment`、`merge_attached_workbooks`、`web_search`、`image_search`、`generate_image`。
- Slides：`genoffice/apps/slides/src/renderer/ai/transport.ts`；`src/renderer/ai/AiPanel.tsx:1419-1425`；`src/renderer/ai/slides-skill.ts:286-766,1077-1116,1401-1475`；`src/renderer/ai/slide-qc.ts:145-151` 的 QC 包装**复用**原 executor；files skill 为 `read_attachment`。
- PDF：`genoffice/apps/pdf/src/renderer/ai/transport.ts`；`src/renderer/ai/AiPanel.tsx:364-425`；`src/renderer/ai/pdf-skill.ts:52-102`；`src/renderer/ai/tools.ts:236-1150,1279-1303`。
- Markdown：`genoffice/apps/markdown/src/renderer/ai/transport.ts`；`src/renderer/ai/AiPanel.tsx:400-418,766-769`；`src/renderer/ai/markdown-skill.ts:85-118`；`src/renderer/ai/tools.ts:133-260,457-535`；搜索补充 skill 定义在 `search-skill.ts`。
- HTML：`genoffice/apps/html/src/renderer/ai/transport.ts`；`src/renderer/ai/AiPanel.tsx:681-718,1107-1110`；`src/renderer/ai/html-skill.ts:56-65`；`src/renderer/ai/tools.ts:35-43,255-400,559-800`；`intent.ts:14-27` **只附加上下文、不提供新工具**。

#### 2. 实际调用链、准确断点、证据分层

**六格式共用的前半段（E2）**：原厂 AI 面板选择对象/选区→各自 `AgentLoop`/`composeSkills`→相应 `renderer/ai/transport.ts`→`genoffice/packages/agent-core/src/electron-transport.ts:80-160`（向 IPC 发送含 `tools` 的 `IpcStreamStart`）→ Docs scoped `mcode:docs:ai-stream`／其余共享 `ai:stream`→宿主真实 sender 定位打开的 docId、`mcodeSessionId` 与 `openedFilePath`→`apps/desktop/src/main/document/docsAiPorts.ts:45-53` 校验 `SessionRepo`、`ProjectRepo`、`providerRegistry`、project/worktree→用户本轮模态确认→`runtimeManager.sendTurn` 向所选 `claude-sdk/pi-sdk/codex-sdk` 发送**纯文本 prompt**。装配点：`apps/desktop/src/main/ipc/index.ts:145-160,214`、`documentViewHost.ts:483-493,1080-1088`、`genofficeViewAiVendor.ts:1-3`；前端选中会话来自 `GenofficeViewHostPane.tsx:259,326`，由打开时宿主储存，不信任后续 vendor payload 自报。

**决定性断点（E2，不是“模型可能不愿调用工具”的随机问题）**：`docsAiPorts.ts:60-87` 的 `docsAiPrompt` 只从 `messages` 提取 text，把 `tools` 完全排除，且显式要求“Return helpful document-edit suggestions as plain text; host will never execute GenOffice native tool calls”。`docsAiPorts.ts:107-139` 的 `RuntimeManager` 事件映射**只**产生 `delta/reasoning/error/done`，不会产生 `tool-call`／`usage`；两个 vendor Mcode AI 桥的 `ViewAiChunk/DocsAiChunk` 类型也没有 `tool-call`。反观 `electron-transport.ts:~101-130` 只有收到 `chunk.type==='tool-call'` 才调 `cb.onToolCall`；`agent-core/src/loop.ts:~1150-1198` 才会按原厂 skill 调 `skill.executeTool`。因此**目前生产 Mcode SDK→GenOffice renderer 原生 AI 编辑工具链在流 schema 处必然中断**；AI 可能正常流式回复，但不能据此声称 `replace_selection`／`propose_operations`／`apply_ops` 等已执行。宿主的 Mcode SDK 工具若自行改磁盘，是**另一条宿主工具通路**，不等价于当前编辑器选区/撤销/保存。

**原厂后半段（E2，前半段缺工具事件时不可到达）**：GenOffice renderer `AgentLoop` 解析模型 tool-call→原厂 `AgentSkill.executeTool`→Docs TipTap、Sheets Univer/sidecar、Slides deck access、PDF page access、Markdown TipTap/frontmatter、HTML `applyOps/replaceAll`→原生 undo/snapshot 及各 app 自己的保存通道。**回盘并发/CAS、真 Electron 可见变化/跨重启**须另验，不能由 source 推导为已走通。

**隔离历史证据，不能串接冒充一个生产 E1**：
- `apps/desktop/scripts/genoffice-native-view-smoke/ai.ts:1-120`（T53）以假的 `DocsAiPorts` 对真实 host sender→选定会话、伪造 `sessionId`、流式回复及撤销授权做 E1；仅证实“假 provider 能回文本”；同组 `real.ts` 另测 XLSX/PPTX 的原生读改保存，不是 AI 回填。任务回写称 `genoffice-native-view-ai-smoke 12/12`，**本次未复跑**。
- `apps/desktop/scripts/genoffice-ai-ask-smoke/probe.ts:34-67,186-316,567-666` 的真 Electron Docs renderer、原厂 `AgentLoop`、tool-call、编辑、DOCX 保存使用的是本地 `127.0.0.1` **mock 模型**，并直接通过原厂 `@genoffice/ai-provider.streamForProvider` 喂 tool-call；证明“原厂 renderer 编辑器 executor 可以跑”（E1-历史），**不能证明生产 Mcode SDK 发出了 tool-call**，也不能证明三引擎在线 U1。`tasks/T05c-docs-ai-panel.md` 结果回写明确真 Mcode SDK/Electron U1 未达成。
- 原有 T54 `genoffice-pane-fence-smoke` 等属于 A/B/C 侧效应边界 E1，**不是全 6 格式 AgentSkill 生产执行 U1**。

#### 3. 安全域／多执行器／跨 pane 结论

1. **伪 session 不能用 vendor payload 直接替换选定 SDK（E2，有上述 E1-历史假输入）**：`genoffice/apps/docs/src/main/mcode-ai.ts:52-67` 和 `genoffice/apps/pdf/src/main/mcode-view-ai.ts:50-68` 都忽略请求自报 `sessionId`、`settings`、`provider`、`cwd`；用 `event.sender` 查 `DocumentViewHost` 和当前打开文件；`docsAiPorts.resolveDocsAiSession` 再核 Mcode 三 SDK 与 project/worktree。宿主首次打开传入的 `mcodeSessionId` 源自 Mcode 前端活跃会话，**不能升级表述为每轮与活跃会话的重新选中状态比对**。异步确认弹窗前建立的 authority，确认之后没有再次查视图/会话；“审批期间换页/更换绑定”需 race E1 验证，当前只能记 E3 风险。
2. **并没有第二套原生文档工具执行算法**：六份 skill 是六种编辑器各自一份 renderer native executor；Docs 的 MCP 桥和 Slides 的 slide-QC 复用对应 executor。**存在两套相似 AI IPC 接线实现**：Docs `mcode-ai.ts` 为 `mcode:docs:ai-*`，PDF/Markdown/HTML/Sheets/Slides 共用 `mcode-view-ai.ts` 的 `ai:*`；加上原厂独立运行的 `ai-provider` 代码依旧在 upstream repo。T31 目前**没有做到“一份 host AI IPC 协议实现”**，也没有统一 tool-call 映射。不能把两套 IPC 包装误称“两套业务编辑器 executor”。
3. **常规流的跨 pane 隔离（E2）**：`registerViewAiIpc` 使用 sender→owner 及 `running: Map<sender.id,Map<requestId,AbortController>>`；cancel 只从相同 sender 的 map 拿 abort，不接受另 pane 指令操作任意 requestId，sender 销毁则中断。Docs scoped IPC 同形。**潜在事件串流待验证（E3）**：`docsAiPorts.ts:109-119` 订阅 SDK 事件只按 `event.sessionId` 而非单次 turn/requestId 过滤；同一 Mcode session 若允许并发两个 native panes，是否会误收文本尚无双 pane 并发 E1。Mcode 运行时“同 session 一次只跑一回合”的约束不能在未核验前代替此检查。
4. **找到独立云媒体通道的静态风险（E2）**：`genoffice/apps/slides/src/main/slides-main.ts:4835` 在 `registerSlidesIpc` 中仍调用 `registerSlidesOnlyAiIpc`；`genoffice/apps/slides/src/main/ai-ipc.ts:1-74,336-385` 直接从 Electron 的原生 `ipcMain` 注册 `ai:generate-image`、`ai:analyze-media`，调用 GenOffice `generateImageTool/analyzeMediaTool` 并读取原厂 `AI_SETTINGS_PATH()`。Slides skill 的 `generate_image` 走 `window.slidesApi.generateImage`（`slides-skill.ts:1549`）。这两条**不经过共享 `registerViewAiIpc` 的 Mcode sender/session/逐次确认与云账户拒绝**；T54 `mcode-sheets-scoped.ts:isScopedChannel` 只匹配 `slides:|sheets:|workbook:|shell:`，**不涵盖 `ai:*`**，且 ai-ipc 直接 import Electron ipc。原厂登录状态/配置或许使调用失败，但这是**缺宿主授权围栏的真实旁路入口**；没有做在线外呼/凭据测试，不能说已实际产生云请求。Slides 其它 `ai:insert-image-url` 等应随该入口**单独枚举**，不能冒充全部已安全。
5. **权限与写盘归属**：原厂 renderer 编辑工具对编辑器实例的内存操作不等价于物理磁盘授权；文件落盘仍须通过对应 Mcode/workspace/原厂保存围栏和 CAS（此前 T53/T54 分片 E1）。`docsAiPrompt` 的“不直接写文件”只是发给模型的文本指令，**不能当成 SDK 工具权限隔离**。PDF `deps.readOnly()` 有较多 executor 显式拒写；其余格式未知项不补猜。`mcode-view-ai.ts:~150` 的兼容设置硬编码 `provider:'codex'`、另带 `mcodeEngine`；在 Claude/Pi 当前会话里可能误导界面，真实 UI 表象 U1 未验。

#### 4. T31/T32/T33 的已成与未成

- **T31 共用 AI transport**：**部分**。六格式 renderer 均调用 `@genoffice/agent-core:createIpcTransport`，五格式共用 `registerViewAiIpc`、Docs 独立 scoped bridge；真实 SDK 选定/文本/取消在 host source 可追。**缺**完整 tool-call/usage schema、Mcode SDK tool results→renderer 多轮协议，且需清理 Slides 独立 `ai:*` 云旁路；真三 SDK U1 未验。
- **T32 保持原厂 renderer AgentSkill**：**原始 skill/executeTool 均存在，且为正确唯一业务执行器（E2）**；Docs vendor mock 证明工具编辑能力的孤立 E1。**缺**生产 Mcode SDK→原厂 tool-call→executor→编辑器 apply/undo/save 的贯通。应复用 renderer AgentLoop，不把 skill 复制到 Mcode main、不另写 ReAct loop。
- **T33 Mcode Agent 反向使用编辑器选区/骨架**：**没有确认通用 `app_api_list→describe→call` 到六 app renderer `skill.buildContext`/选区的宿主级桥**；Docs 独立 `mcp-bridge.ts` 的原厂本地方法不等于 Mcode `app_api_call`。需等 T31/32 安全协议与 T49 appControl 在飞工作完成后再单独设计，不把页面选择器声明为 agent 已可调用；U1 全未验。

#### 5. 交总控的三张非重叠后续开发建议（此卡**不新建**正式任务）

| 建议卡 / 顺序 | 唯一预期源码边界（只供后续派发） | 前置 / 最小失败红例 / 必须达到的功能 |
|---|---|---|
| **T31-A：Mcode 三 SDK → 原厂 tool-call 适配能力门** | `apps/desktop/src/main/document/docsAiPorts.ts` ＋**新建** `apps/desktop/src/main/document/nativeEditorToolTransport.ts` ＋**新建** `apps/desktop/scripts/genoffice-mcode-tool-bridge-smoke/*`；不碰六 app renderer 或 `appControl` | T75 审计通过，保持 RuntimeManager 及原有审批。**红例**：假 Mcode SDK 请求携带 `replace_selection` tool schema 后没有 `tool-call` chunk，或者 SDK 自带文件工具冒充原厂已执行；断言主机只能按 SDK 真正支持的结构化 tool-call/结果协议转发，能力不支持就明确拒绝，不能把自然语言 JSON 假扮原生执行，不直连 GenOffice 云。 |
| **T31-B / T32-验证：原厂六格式 renderer 原生执行闭环回归** | **新建** `apps/desktop/scripts/genoffice-native-skill-integration-smoke/*`；如确有问题才以**独立补丁**修改 `genoffice/packages/agent-core/src/electron-transport.ts`（对应 `patches/genoffice`）；与上一卡的 host 源文件互不重叠 | 依赖 T31-A 的结构化事件已可得；保持六个既有 `AgentSkill.executeTool` 不重写。**红例**：真 Electron 隔离空白文件，送包含 `tool-call` 的受控本地假事件，原编辑器无变更/没有回传 tool-result/undo/save 不一致；逐格式断言选区、执行、撤销、持久化，再明确另列三真 SDK 在线 U1 门槛。 |
| **T31-S：Slides 独立原厂 `ai:*` 云媒体旁路关闭** | `genoffice/apps/slides/src/main/ai-ipc.ts`、必要时 `genoffice/apps/slides/src/preload/index.ts`，对应单独 `patches/genoffice` 和**新建** `apps/desktop/scripts/genoffice-slides-ai-boundary-smoke/*`；不碰 T31-A/B 源码 | T54 原生 pane 约束先稳定。**红例**：Mcode-hosted 的 Slides sender 通过 `ai:generate-image/analyze-media` 仍可进入 `generateImageTool/analyzeMediaTool`（即使常规 `ai:stream` 被 Mcode 桥接）；要求 Mcode 模式 fail-closed 可读错误或改走已有获批 Mcode 能力，原厂 standalone 保持兼容；再枚举余下 `ai:insert-image-url` 等分流入口与 sender 审批，做取消/假 sender 断言。 |

**并发避让**：三卡分别只碰 Mcode host AI adapter、vendor transport/新的 renderer E1 套件、Slides 特有媒体注册；均不碰在飞 T30 的文件类型路由与 `GenofficeViewHostPane.tsx`、T49 的 `main/appControl`／扩展权限面、T64 的提示词策略、T65 的 Monaco 选区引用。**T33 待 T49 与前述桥闭环以后再派**，不在本轮撞改 `appControl`。

**验收映射与 remaining**：#1 **达成（E2 完整 6×9）**；#2 **达成（已定位生产 tool-call 断点，没把文本/假 provider 冒充编辑器执行）**；#3 **达成（sender/会话/取消/Slides 云旁路与未实证竞态写明）**；#4 **达成（三份后续文件边界不相撞）**；#5 **达成（版本、原始读取方式、E1-历史/E2/U1 区分、变异 N/A）**。**剩余真实能力**：六格式生产工具回写、选区精准应用、逐步撤销、保存并独立回读、异步弹窗期间会话撤销、同 session 多 pane 并发隔离、Slides 媒体旁路隔离、三种真 SDK + 真 Electron U1、全工具只读状态穷举均未完成；这些是后续开发/独立 U1 证据，不按本次纯只读审计项目冒称已交付。
