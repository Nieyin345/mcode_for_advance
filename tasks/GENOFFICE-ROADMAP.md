# GenOffice 长远路线图（总控维护）

> 用户目标原话：
> **「genoffice的要求是基本他的所有功能都保留，只是把助手ai替换掉，用我们项目的ai」**
>
> 用户对做法的要求原话：
> **「能复用就复用，项目里就有对应的源码，能搬过来就搬过来，二开，我感觉应该很容易呀，基本不要自己写什么东西」**

本文件是 GenOffice 这条线的总纲。所有 T2x 卡都是它的切片。
**写任何新卡前先读这里；新发现的事实回写到这里。**

---

## 一、GenOffice 的全部能力面（实读，20 个包 + 6 个 app + CLI + MCP）

### 1.1 六个 app（渲染端 = 我们要保留的「所有功能」）

| app | 渲染端文件数 | 主进程 IPC | 视图工厂 | Mcode 现状 |
|---|---|---|---|---|
| docs | 306 | 76 | `docs-main.ts:6433 createDocsView` | ✅ 已接（T05a/b/c + T22） |
| sheets | 307 | 57 | `sheets-main.ts:2444 createSheetsView` | ❌ 未接 |
| slides | 228 | 155 | `slides-main.ts:5051 createSlidesView` | ⚠️ 自搓了 3 个操作 |
| pdf | 69 | 43 | `pdf-main.ts:2042 createPdfView` | ❌ 未接 |
| markdown | 72 | 30 | `markdown-main.ts:1327 createMarkdownView` | ❌ 未接 |
| html | 101 | 29 | `html-main.ts:1941 createHtmlView` | ❌ 未接 |

**渲染端合计约 43 万行，一行不改地复用**（通过 `WebContentsView` 载入 `out/renderer/index.html`）。

### 1.2 二十个包（可复用的能力件）

| 包 | 用途 | Mcode 是否已用 |
|---|---|---|
| `docx-engine` | docx 解析/编辑（Block 树 + OOXML） | ✅ 通过 slidesVendorModules 邻近路径 |
| `pptx-engine` / `pptx-ops` / `pptx-render` | pptx 解析/编辑/渲染 | ✅ 静态 import |
| `xlsx-gateway` | xlsx 写入门户 + workbook 域逻辑 | ❌ |
| `pdf2docx` / `html2docx` / `odf2ooxml` | 格式转换 | ❌ |
| `file-parse` | 附件解析（PDF/Office/纯文本 → 文本） | ❌ **T22 只做了 docs 版** |
| `zip-gate` | zip 炸弹防护 | 间接 |
| `font-metrics` | 系统字体度量 | ✅ |
| `electron-utils` | 主进程共用件（截图/打印/协议） | 间接 |
| `i18n` | 六 app 共用 i18n | ❌ |
| `ui` | 共用渲染端组件（AI 面板 composer、图标） | ❌ |
| `agent-core` | **通用 ReAct agent loop + AgentSkill 接口** | ⚠️ **只用了类型** |
| `ai-provider` | 多供应商 LLM 流式客户端 | ❌ **明确不要**（换成 Mcode 三引擎） |
| `ai-search` | 网页/图片搜索（Genspark/Serper/Tavily…） | ❌ |
| `pipelines` | Electron 无关的生成流水线 + agent guides | ❌ |
| `project-store` | 本地项目式文档存储 + 聊天历史 | ❌ **不要**（Mcode 有自己的） |
| `cli` | 无头 CLI（21 个命令）+ MCP server（29 个工具） | ✅ MCP 已接 |
| `agent-core` 的 `create-document-skill` / `knowledge-base-skill` | 跨 app 共用 skill | ❌ |

### 1.3 CLI（21 个命令，无头轨）

`capabilities` `convert` `create` `docs` `guide` `image` `info` `install` `mcp`
`media` `merge` `open` `pdf` `render` `search` `selection` `sheet` `skill` `slides` `txn`

Mcode 已用：`convert` / `read`（`docsRead` / `pdfRead` / `sheetRead` / `slidesRead`）/
`apply`（`docsApply` / `sheetApply` / `slidesApply`）/ `guideOps` / `pdfRender`。
**未用**：`create` / `merge` / `search` / `image` / `media` / `render` / `selection` / `txn` /
`capabilities` / `info`。

### 1.4 MCP（29 个工具）

`info` `convert` `create_docx` `create_xlsx` `create_pdf` `create_pptx`
`docs_read` `docs_apply` `docs_check` `merge` `pdf_read`
`sheet_read` `sheet_apply` `sheet_check` `slides_read` `slides_apply` `slides_audit`
`slides_render` `slides_check` `slides_replace` `render` `guide` `capabilities`
`search` `image` `media` `open` `selection`

**已接**：`apps/desktop/src/main/mcp/genofficeMcp.ts` 产出规范 stdio 条目，
交给 Mcode 现有 MCP 登记表。围栏走 `GENOFFICE_ALLOWED_ROOTS`。

### 1.5 agent-core（**关键**，也是最容易搞错的一块）

```ts
// packages/agent-core/src/skill.ts
export interface AgentSkill {
  id: string
  systemPrompt: string          // 这个能力域的系统提示词
  tools: AgentToolDef[]         // 这个能力域的工具
  buildContext?(): string       // 每轮附加的上下文（文档骨架 + 选区）
  executeTool(call, signal?): ToolExecution   // 工具执行器
  verifyResponse?(finalText, executed): string | null   // 防「声称做了但没做」
}
```

**每个 app 的 AI 都是这个接口的一个实现**：
`docs-skill.ts` / `sheets-skill` / `slides-skill.ts` / `pdf-skill.ts` /
`markdown-skill.ts` / `html-skill.ts`，每个 300–800 行。

**这是用户要保留的部分** —— 它定义「AI 能做哪些文档操作」。
`agent-core/loop.ts`（ReAct 循环）才是要替换的。

**六个 app 的 skill 之间的差异是真实的**（不是重复）：
- docs 有 `write_document` 长文流式写、样式目录、批注、页眉页脚
- sheets 有 `formula-audit`、`aggregate-range`、`selection-ask`、`workbook-search`
- slides 有 `layout-script`、`deck-progress-view`、`slide-qc`
- pdf 有 `pdf-nav`（翻页/缩略图）
- markdown / html 各有 `search-skill`、`doc-nav`

---

## 二、复用什么、替换什么（用户目标的精确分解）

### ✅ 完全复用（一行不改）

1. **六个 app 的渲染端**（43 万行）—— 编辑器 UI、编辑内核、文档解析
2. **六个 app 的主进程 IPC / 视图工厂**（`createXxxView` + `registerXxxIpc`）
3. **六个 app 的 AI skill**（`agent-core/AgentSkill` 的实现）—— 这是「所有功能」的核心
4. **二十个能力包**（docx-engine / pptx-* / xlsx-gateway / file-parse / pipelines…）
5. **CLI 21 个命令**（无头轨，MCP 已接）
6. **MCP 29 个工具**（已接）

### 🔄 替换（只换这一层）

| 原厂 | 换成 | 方式 |
|---|---|---|
| `agent-core/loop.ts`（ReAct 循环） | Mcode 的三引擎（Claude / Pi / Codex） | AgentSkill 接口不变，执行器换宿主 |
| `ai-provider`（多供应商 LLM 客户端） | Mcode 的 provider 抽象 | 不引入这个包 |
| `ai:stream` / `ai:set-settings` / `ai:gsk-*` IPC | Mcode session 通道 | 提供一份 `ai:stream` 实现 |
| `project-store`（项目存储 + 聊天历史） | Mcode 的 sql.js + 会话 | 不引入这个包 |
| Genspark 登录 / 云账号 / 遥测 | 无 | 不引入 |

### ❌ 明确不要

- `ee/` 企业条款代码
- Genspark 云 AI / 账号状态 / `ai:gsk-*`
- 任何遥测（`analytics.ts`）
- GenOffice 自己的 Electron 主进程壳（`apps/shell/`）—— 但那套**装配方式**要抄

---

## 三、已经做对的和做错的地方（如实）

### 做对的

- 渲染端原样复用，没有重写编辑器
- `document.*` 契约让「用户点按钮」和「Agent 经 app_api_call」走同一段代码
- MCP 走 Mcode 现有登记表，没有造第二个 MCP 客户端
- AI 桥「默认拒绝 + 显式审批」的方向

### 做错的（教训）

**1. 宿主层重造了一套。**
Mcode 自己写了 4,740 行主进程文档层，其中 `documentViewPreload.ts` **611 行**
是一个替代原厂的最小 preload。而原厂每个 app 的 `createXxxView()` 里已经
写好了 sandbox、路径授权、`setWindowOpenHandler`、`will-navigate` 拦截。

原因：T05 系列只接了 docs，其它五个 app 的视图工厂一直可用但没被调用。

**2. `slidesBridge` / `slidesExecutor` 是重复劳动。**
以为不能直接用原厂视图，于是自搓了 3 个操作。原厂 `createSlidesView` 里
155 条 IPC 全都在。

**3. 只接了 docs，其它五个 app 一直空白。**
用户的要求是「所有功能都保留」，不是「先做一个」。

---

## 四、六个阶段（每个阶段一张卡，按用户价值排序）

### 阶段 1：把六个 app 的界面全部接起来（**不做 AI**）

> 目标：用户能在 Mcode 里打开任意格式的文档并编辑保存。

| 卡 | 内容 | 状态 |
|---|---|---|
| **T28** | pdf / markdown / html 三个 app 接原厂视图 | 待派 |
| **T29** | sheets / slides 接原厂视图（含 `queueWorkbookForView`） | 等 T28 |
| **T30** | 路由统一：一份扩展名判据，六个入口共用 | 等 T29 |

**判据**：六个 app 都能打开真实文件、编辑、保存、字节不变、pane 拖动不重载。

**T30 的必要性**：现在格式判据散在四个地方
（`fileEditorKinds.ts`、`FilePreview.extOf`、`sessionStoreHelpers.isMarkdownPath`、
`onlyoffice.ts` 的 `isOnlyOfficeSupportedPath`）。原厂 `app-routing.ts` 是**一份**：

```ts
export function appForPath(path: string): DocumentTabKind | undefined {
  if (DOCX_RE.test(path)) return 'docs'
  if (XLSX_RE.test(path)) return 'sheets'
  ...
}
```

照抄它。

---

### 阶段 2：AI 换成 Mcode 三引擎（**核心目标**）

> 目标：六个 app 的 AI 面板都跑在 Mcode 的会话上，原厂 skill 一行不改。

| 卡 | 内容 |
|---|---|
| **T31** | 通用 AI 桥：一份 `ai:stream`/`ai:stream-chunk`/`ai:stream-cancel` 实现，六个 app 共用 |
| **T32** | AgentSkill → Mcode 工具面：把原厂六个 skill 的 `tools` / `executeTool` 暴露给 Mcode 的 agent |
| **T33** | 反向：Mcode 的 `app_api_call` → 原厂 skill 的上下文（选区、文档骨架） |

**T31 的关键事实**（已核实）：
`ai:stream` 只在 docs（`docs-main.ts:4084`）和 slides（`ai-ipc.ts:172`）注册过。
**pdf / markdown / html 的主进程根本没有 AI 实现**，但六个渲染端
`ai/transport.ts` 完全同形（各 18 行）。原厂壳自己也是 `registerAiIpc()` 一份供全六 app。

**T32 的关键事实**（已核实）：
`AgentSkill` 是渲染端对象，它的 `executeTool` 直接操作编辑器实例。
**它不在主进程**。所以 Mcode 的 agent 要用它，只有两条路：

- **A**：agent 在渲染端跑（原厂方式），Mcode 只提供 `ai:stream` 这一个通道。
  **这是最省的，也最符合「不改上游」**。
- **B**：把 skill 的 `tools` 定义搬到主进程重写一遍 —— **不要**，那是重写。

→ **本阶段应走 A**。T32 的题目因此要改成「验证 A 路线可行 + 补缺失的宿主能力」，
而不是「搬 skill」。

**这一点必须在写 T32 前验证清楚**，否则会做成错误的重写。

---

### 阶段 3：无头轨补完（Agent 不打开文档也能操作）

> 目标：Agent 可以直接读/改/生成文档，不需要用户先打开。

| 卡 | 内容 |
|---|---|
| **T34** | CLI 剩余能力接入：`create` / `merge` / `selection` / `txn` / `render` |
| **T35** | `file-parse` 全格式接入（不是 T22 那种只做 docs） |
| **T36** | `xlsx-gateway` / `pdf2docx` / `html2docx` / `odf2ooxml` 接入 |

**已接**：`document.read/edit/convert/capabilities` + MCP 29 工具。

---

### 阶段 4：AI 的搜索与生成能力（**可选，看用户要不要**）

> 目标：文档 AI 能做网页搜索、图片搜索、图片生成。

| 卡 | 内容 |
|---|---|
| **T37** | `ai-search` 接入（但**默认拒绝**，每次真人批准 —— 与 T22 的 http(s) 同一策略） |

**注意**：`ai-search` 会联网。Mcode 的 `http(s)` 策略是默认拒绝 + 真人批准。
本阶段要先确认用户是否真的需要。

---

### 阶段 5：视觉整合

> 目标：GenOffice 的编辑器外面那圈（pane 边框、圆角、焦点环）与 Mcode 一致。

| 卡 | 内容 |
|---|---|
| **T38** | 六个 app 的外围视觉统一（**不改上游 UI**） |

T07 已经做了 docs 与 Node-RED 的 pane 化，本阶段补其它四个。

---

### 阶段 6：清理与收尾

> 目标：删掉为了绕路而写的东西。

| 卡 | 内容 |
|---|---|
| **T39** | 评估 `documentViewPreload.ts`（611 行）能否删除 |
| **T40** | 评估 `slidesBridge` / `slidesExecutor` 能否删除 |
| **T41** | 评估 `OnlyOfficeEditorPane` 是否还要保留 |

**这些卡只能在新路稳定运行一段时间之后开**。

---

## 五、四条铁律（每张卡都要遵守）

1. **不改 `genoffice/` 上游源码**，除非是「接缝」类改动（AI 桥、IPC 通道），
   且必须同步产出 `patches/genoffice/NNNN-*.patch`。
2. **能调 `createXxxView` 就不要自己写视图**。
3. **能调原厂 `registerXxxIpc` 就不要自己写 IPC**。
4. **AgentSkill 不要搬到主进程重写** —— 它在渲染端，操作编辑器实例。

---

## 六、当前进度

| 阶段 | 卡 | 状态 |
|---|---|---|
| 1 | T28 | 待派 |
| 1 | T29 | 等 T28 |
| 1 | T30 | 等 T29 |
| 2 | T31 | 等阶段 1 完成（否则 AI 面板没有宿主可挂） |
| 2 | T32 / T33 | **先验证 A 路线，再写卡** |
| 3 | T34–T36 | 可与阶段 1 并行（都是 CLI / 包，不碰渲染端） |
| 4 | T37 | 需用户确认要不要联网搜索 |
| 5 | T38 | 等阶段 1 |
| 6 | T39–T41 | 最后 |

**可立即并行开的**：T28（阶段 1）+ T34（阶段 3，CLI 能力）。
两者文件边界不重叠。

---

## 七、待验证的问题（写卡前必须先回答）

1. **`createXxxView` 能否被 `DocumentViewHost` 直接托管** —— T28 的第一件事。
2. **AgentSkill 的 `executeTool` 依赖渲染端编辑器实例** —— 确认后 T32 改题目。
3. **`ai:stream` 的 `request` 里带什么** —— 决定 T31 的契约形状。
4. **六个 app 的 preload 各有多少条通道会越出 pane 边界** —— 决定 T28/T29 要不要额外拦截。
5. **xlsx sidecar（Rust 可执行）在 Mcode 的两种布局下怎么定位** —— T29 的阻塞点。

---

# 附录：Node-RED 这条线（同一原则，另一条主线）

> 用户原话：
> **「node red部分，和genoffice的原则也是，直接搬过来，二开，只不过添加一些和ai交互的节点之类的，就是我们的mcode有的，或者是修改一下node red有的节点」**

## N1. 现状（实读，2026-10-21）

**已经做对了，而且比 GenOffice 那条线更彻底**：

| 层 | 状态 | 证据 |
|---|---|---|
| Node-RED 5.0.8 源码 vendor | ✅ | `node-red/`，独立 Git，Apache-2.0，`mcode/integration` 分支，HEAD `935b8d3` |
| 运行时拉起 | ✅ **官方 embedding 形状** | `registry.ts:85-260` 的 `BOOTSTRAP`，用 `RED.init(server, {...})` |
| 编辑器嵌入 | ✅ | 原厂 `red.min.js` 作为 `WebContentsView`（T07） |
| 认证 | ✅ | 宿主令牌，无令牌 401 |
| 部署审批 | ✅ | `POST /flows` 走 `process.send` 握手，其余写操作 423 |
| safeMode | ✅ | 默认开，只有宿主写可信标记才放开 |
| 引导脚本完整性 | ✅ | `bootstrapManifest.ts` 版本 + sha256 + 篡改检测 |

**关键差异**：Node-RED 这条线**没有「宿主层重造」的问题**。
引导脚本就是 `RED.init()`，没有替代任何原厂实现。

## N2. 唯一的断点

`apps/desktop/src/main/workflowEngines/` 下有 **1,380 行**自定义节点代码：

- `mcodeNodePack.ts` —— `mcode-agent`（纯逻辑 + 注册外壳 + **真实 HTML**，`agentNodeHtml():354`）
- `mcodeNodeTypes.ts` —— 另外 5 个（`mcode-conversation` / `mcode-branch` /
  `mcode-trigger` / `mcode-module-capability` / `mcode-node-red-call`）

**没有接进生产**：

```
grep -rn "registerMcodeAgentNodes" apps/desktop/src/main/   → 无输出（生产零调用）
grep -rn "registerMcodeAgentNodes" apps/desktop/scripts/   → 只有测试
```

同时 `McodeAgentPort` 只有测试替身，没有生产实现。

**节点写好了，但没有装进 Node-RED，也没有东西执行它们。**

## N3. Node-RED 的扩展方式（零上游改动）

一个节点 = 同目录下一对同名文件：

```js
// <type>.js
module.exports = function (RED) {
  function Ctor(config) { RED.nodes.createNode(this, config); }
  RED.nodes.registerType("mcode-agent", Ctor);
};
```

```html
<!-- <type>.html —— 编辑器加载 -->
<script type="text/javascript">RED.nodes.registerType("mcode-agent", { category, color, defaults, inputs, outputs, icon });</script>
<script type="text/html" data-template-name="mcode-agent"> 表单 </script>
<script type="text/html" data-help-name="mcode-agent"> 帮助 </script>
```

**发现机制**：扫 `nodesDir`（`node-red/settings.js:58-63`），有同名 `.js` + `.html` 即认作节点。

## N4. 不改原生节点，只做补充

`core/function/`：`function`（写 JS）、`switch`、`change`、`range`、`template`、
`delay`、`trigger`、`exec`。
`core/network/`：`http in`/`http request`、`mqtt`、`websocket`、`tcp`、`udp`。

**这些全部保留，一个不改。** Mcode 的 6 个节点是补充：

| Mcode 节点 | 原生做不到的事 |
|---|---|
| `mcode-agent` | 跑一次三引擎 agent，输出 `{text, artifacts}` |
| `mcode-conversation` | 跑一轮主对话（用户可见） |
| `mcode-branch` | 「模型决策」分支（原生 `switch` 只能按值比较） |
| `mcode-trigger` | 订阅 Mcode 应用事件（手动/定时/文件变化已并入原生 `inject`/`watch`） |
| `mcode-module-capability` | 调用扩展系统的能力 |
| `mcode-node-red-call` | 反向调用引擎 API |

**迁移器的映射方向已经是对的**（`mcodeNodeTypes.ts` 头注写死）：
`condition` → 原生 `switch`，`command` → 原生 `exec`，
`code` → 原生 `function`/`exec` + 解释器前缀。

## N5. 卡片

| 卡 | 内容 | 状态 |
|---|---|---|
| **T30** | 把节点包装进 Node-RED（`nodesDir` + build bundle + 清单校验） | 待派 |
| **T31** | `McodeAgentPort` 的生产实现（6 个 port 接到三引擎/审批/ModuleHost） | 等 T30 |
| **T32** | 节点表单的 i18n 与图标（不改 Node-RED 主题） | 等 T30 |

**T30 与 T28 可以并行** —— 前者改 `workflowEngines/`，后者改 `document/`，零重叠。

## N6. 与 GenOffice 线的对照

| | GenOffice | Node-RED |
|---|---|---|
| 上游源码 | `genoffice/`（gitignored 快照） | `node-red/`（gitignored 快照） |
| 渲染端 | 六个 app，43 万行，原样 | `editor-client`，原样 |
| 宿主层 | **重造了 4,740 行**（待 T28/T29 改回） | ✅ 官方 embedding，没问题 |
| AI 替换 | `ai:stream` 桥（待 T31/T32） | 节点 port（待 T31） |
| 扩展点 | AI skill（渲染端） | 自定义节点（`nodesDir`） |
| 上游改动 | 9 个补丁，全在 `apps/docs/` | **0 个补丁** |
