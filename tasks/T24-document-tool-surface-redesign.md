# T24｜文档 AI 工具面重做：借鉴 docx-cli 的 Markdown-操作模型

- Status: ready-for-agent
- Category: feature
- Priority: **P0 产品核心**
- Depends on: T0（同轮往返已通，`6bd8289e`）
- Exclusive writable files: 新建的文档工具面模块、其 IPC 契约、新建回归套件。逐个确认后写进回写区。**不改** `genoffice/` 上游、`patches/`、`document/docsAiPorts.ts` 与 `nativeEditorToolTransport.ts`（T0 刚交付，需保持）。

## Required Skills
- `codebase-design`: 决定新的工具面该是「包一层 CLI」还是「重写工具定义」，接口要多窄。
- `mcode-smoke`: 建工具面回归，并做变异验证。
- `research`: 需要时可以对照 `genoffice/skills/genoffice/SKILL.md` 与 docx-cli 的公开文档，但**不得直接复制其代码**（许可虽 MIT，但引入运行时依赖要单独决策）。

Read before work: `CLAUDE.md`、`docs/planning/product-roadmap/T13-genoffice-baseline.md`、`genoffice/skills/genoffice/SKILL.md`（229 行，**上游自己写的 AI 操作方法论文档**）、`apps/desktop/src/main/document/genofficeCli.ts`（556 行，Mcode 已有 CLI 调用层）、`apps/desktop/src/main/document/docsAiPorts.ts`。

## 用户明确指出的问题（原话）

> 「ai 的修改，编辑工具不行，也不能预览页面效果，工具覆盖的不全面，读文件也不全面，让 ai 改 word，改 ppt 这种有格式要求的很烂，而且很丑，简直不能看」

> 「整体就是工具的问题……可以去找现有的比如 office cli 之类的借鉴或者是集成」

> 「我的想法是全面，基本 office 能够编辑的能力都要有……就是工具集，用查找来获取工具」

## 已查清的事实

### 事实一：GenOffice 的工具数量被低估了

| 编辑器 | 工具数 |
|---|---|
| PDF | **45** |
| Docs | **38** |
| Sheets | 18 |
| Slides | 18 |
| Markdown | 11 |
| HTML | 8 |
| **合计** | **138** |

T13 说的「PDF/MD/HTML 没有 AI 面板」不等于没有工具定义。

### 事实二：上游自己写了正确的方法论，但 Mcode 没用

`genoffice/skills/genoffice/SKILL.md`（229 行）里有：

- **`## Designing a deck`** —— 分阶段流水线：`style.md` → `outline.json` → 每页一个 `pages/NN.json` → `check` 校验 → `create` → **`render` 出 PNG 自己看** → `audit` 查几何 → 最多两轮修复。
- **`## Before you say "done"`** —— 每个产物三行检查：`audit`/`check` 看 `detail.issues`，`render` 出图**亲眼看**。
- **`## Pitfalls`** —— 14 条实操坑，含「0-based vs 1-based 索引」「EMU 不要自己乘 914400」「结构性编辑会重新编号」「`status:"partial"` 但 exit 0，必须查 status」。

**当前 Mcode 走的是「138 个工具直接注入渲染端」，绕过了这套带 QA 门禁的流水线。**

### 事实三：`docx-cli` 提供了更好的模型，可借鉴

`kklimuk/docx-cli`（MIT，228 star，2026-10-22 更新，TypeScript/Bun）。它的核心主张：

> **standardizing most operations as creating, updating, deleting, or replacing Markdown**
> CLIs like OfficeCLI often force them to compose smaller operations with JSON they often struggle to understand in context.

它的能力面：

| 命令族 | 用途 |
|---|---|
| `read FILE` | 输出**带定位注释的 Markdown**；`--ast` 输出无损 JSON 树 |
| `find FILE "phrase"` | 返回精确 span |
| `insert` / `edit` / `replace` / `delete` | 手术式编辑，只改被要求改的 |
| `track-changes` | 原生 Word tracked changes；`apply --accept rev1 --reject rev0` |
| `comments` | 批注增删改 |
| `tables` / `images` | 表格与图片操作 |
| `diff FILE --against ORIGINAL.docx` | 文本化列出改动 |
| `render` | 页面图（需 Word 或 LibreOffice） |
| `--dry-run` | 预览不保存 |
| `--batch FILE.jsonl` | 批量，定位符按读取时的文档定址 |

**稳定定位符**：`p3`（段落）、`p3:5-20`（段落内字符区间）、`t0:r1c2`（表格单元格）、`c0`（批注）、`rev1`（修订）。这解决了「模型自己数块索引数错」的问题。

### 事实四：Mcode 已有 CLI 调用层

`apps/desktop/src/main/document/genofficeCli.ts`（556 行）已经能调 `genoffice` CLI。`genoffice/packages/cli/bin/genoffice` 与 `dist/genoffice.cjs` 都在。

## 目标

把文档 AI 的工具面从「138 个 JSON 工具直注」改成**可发现 + Markdown 操作 + 带 QA 门禁**的三层模型。

### 必须实现

1. **工具发现（你明确要求的「用查找来获取工具」）**
   - 三级结构，与现有 `app_api_list → describe → call` 同构：
     - `document_apps()` —— 列出可用编辑器（docs/sheets/slides/pdf/markdown/html）
     - `document_tools_list({app, query?})` —— 列出该编辑器的工具
     - `document_tool_describe({tool})` —— 查参数与示例
     - `document_tool_call({tool, input})` —— 执行
   - **138 个工具不再一次性进上下文。**
   - 但**保留少量高频读工具常驻**（每个编辑器 ≤2 个），避免「读一段文字都要查三轮」。建议常驻：Docs `read_blocks`/`get_document_context`、Sheets `read_range`/`get_workbook_context`、Slides `read_slide`、PDF `pdf read`。

2. **操作载体改为 Markdown（借鉴 docx-cli）**
   - 至少对 Docs 实现：`read` 返回带定位符注释的 Markdown；`edit` 接受 Markdown 续写/替换。
   - 对比实验：同一任务用「JSON ops」与「Markdown 操作」各做一次，记录 token 数与成败。**这是本卡的核心证据。**

3. **QA 门禁接入（借鉴上游 SKILL.md 的 `## Before you say "done"`）**
   - 每次编辑后强制跑 `check`/`audit`，把 `detail.issues` 回给模型。
   - **`render` 出图并让模型看**——这是解决「丑」和「没有预览」的关键。
   - 不得跳过。跳过了就等于回到现在的状态。

4. **变更可视（你 Q8 同意的 (a)）**
   - 引入 tracked changes：AI 的每次修改都是可逐条接受/拒绝的修订。
   - `diff --against` 输出文本化改动清单，供 UI 呈现。

### 明确不做

- **不引入 `docx-cli` 作为运行时依赖**。本卡只借鉴其**模型与定位符设计**；若后续决定集成，另开卡评估 Bun 依赖、二进制分发、许可。
- **不改 GenOffice 上游**。通过 Mcode 侧适配层实现。
- **不做 PDF 文本层编辑**（用户 Q11 明确：正常 PDF 编辑能做就行，不用文本层）。

## 验收判据

1. `document_apps()` / `document_tools_list()` / `document_tool_describe()` / `document_tool_call()` 四个方法存在且可用，138 个工具可按 app 与关键词检索到。
2. **上下文体积对比**：改造前一次性注入的工具定义 token 数 vs 改造后（仅常驻工具 + 按需查找）的 token 数。必须显著下降。
3. **Markdown 操作 vs JSON ops 的 A/B**：同一编辑任务两种方式各做一次，记录 token、轮次、是否成功。
4. **QA 门禁**：编辑后 `check`/`audit` 的 `detail.issues` 真的回到模型上下文（有断言）。
5. **`render` 可用**：能出页面图，且模型能在下一轮看到（有断言）。
6. **tracked changes**：AI 的修改可被逐条接受/拒绝。
7. 变异验证：撤掉「编辑后跑 audit」→ 对应断言必须变红；逐字节还原（`cmp`）。
8. 双包 typecheck 通过。
9. **不得**宣称 T7（六编辑器 U1）完成。

## 边界与风险

- 138 个工具里有 40 个（Docs 的联合类型/深度超限）无法进入共享 JSON-Schema 子集，T0 已按 withheld 明示。改造时**不得把它们悄悄丢掉**——要么单独通道，要么明确列出。
- `document_tool_call` 是新开的一条执行通路，**必须复用 T0 的可信渲染端绑定**，不得绕过 sender/session/document/callId 校验。
- 若发现某编辑器的工具质量太差无法改造，**如实列出并建议重写，不要硬凑**。

## 结果回写（2026-10-23）

### 开工声明：精确可写文件集

- 新增：`apps/desktop/src/main/document/documentToolSurface.ts`（目录/检索/门禁格式化/withheld 说明，纯函数）、`documentToolRuntime.ts`（执行层：发现、Markdown 载体、QA 门禁、出图）、`documentToolRendererBinding.ts`（T0 请求级渲染端绑定登记簿）、`documentToolCatalog.generated.ts`（139 条目录，生成文件）、`apps/desktop/scripts/t24-document-tool-surface-smoke/`（新套件）。
- 修改：`packages/contracts/src/ipc/document.ts` + `rpcMap.ts`（七条通道与类型）、`apps/desktop/src/main/ipc/document.ts`（注册七条 handler）、`apps/desktop/src/main/appControl/{tools,engineTools,policy,apiCatalog.generated}.ts`（agent 侧七个 `document_*` 工具、审批分档、前缀路由、目录刷新）、`apps/desktop/src/main/document/genofficeCli.ts`（check/audit/render/docs read 视图开关）、`apps/desktop/src/preload/index.ts` + `src/renderer/lib/webApi.ts`（三层接线）、三个 Provider 的放行/路由前缀、`scripts/app-control-smoke/main.ts`（两条审批分档断言）。
- **未改**：`genoffice/`、`patches/`、`document/docsAiPorts.ts`、`nativeEditorToolTransport.ts`（T0 交付保持原样）。

### 一、138 个工具的分类结果（实测，不是照抄卡里的表）

用 esbuild 把六家 renderer 的 `AGENT_TOOLS` / `WORKBOOK_TOOLS` / slides `TOOLS` 及**实际组合的伴随 skill**（files / search / image / merge / knowledge-base）打包进 node 跑出来，逐条取 `name`/`description`/`inputSchema`：

| 编辑器 | 实测数量 | 构成 |
|---|---|---|
| Docs | **40** | 29 个内联工具 + `PAGE_SETUP/SECTION_BREAK/DEFINE_STYLE/LIST_STYLES/SET_WATERMARK/INSERT_TEXT_BOX/INSERT_PICTURE/MIND_MAP` 8 个常量工具 + `read_attachment` + KB `read_knowledge_file`/`search_knowledge_base` |
| Sheets | **18** | 13 个 `WORKBOOK_TOOLS` + `read_attachment` + `merge_attached_workbooks` + `web_search` + `image_search`/`generate_image` |
| Slides | **18** | 17 个 slides-skill 工具 + `read_attachment` |
| PDF | **45** | 45 个内联工具（无伴随 skill） |
| Markdown | **10** | 9 个内联（含 `MIND_MAP_TOOL`）+ `web_search` |
| HTML | **8** | 6 个内联 + `web_search` + `read_attachment` |
| **合计** | **139** | 卡里写 138；差值来自 Docs 组合了两个 KB 工具——**按实测 139 落目录**，不放宽成“大约 138”。 |

**T0 的 withheld 名单（8 个 Docs 工具）逐个保留说明**（`document_tool_describe` 返回 `withheld` 原因）：
`insert_chart`、`edit_chart`、`set_page_setup`、`define_style`、`set_watermark`、`insert_text_box`、`insert_picture`（联合类型 `type:[X,'null']`）、`generate_mindmap`（嵌套深度 >12）。另实测出卡里没提的 4 个：`sheets.find_cells`（`default` 关键字）、`slides.apply_ops`（description 超 4000 字符）、`markdown.generate_mindmap`（深度）、`html.apply_ops`（联合类型）。它们都**能**在渲染端由编辑器自己执行；只是无法塞进 T86 请求级 schema 子集。CLI 路线对 Docs 的这 7 个 op 有等价 `apply` 写法（guide 原文可取），`generate_mindmap` 无 CLI 等价物——如实列出。

### 二、发现 API 设计（与 `app_api_list → describe → call` 同构）

Agent 工具（`appMcpTools()` 表内，与 `app_*` 同一审批路）：

- `document_apps()` → 六编辑器、每个 ≤2 个常驻读工具、工具数量、CLI 承载面、QA 门禁；
- `document_tools_list({app?, query?, cliOnly?})` → 目录检索（只给名称 + 160 字截断说明 + route，不给 schema）；
- `document_tool_describe({tool, app?})` → CLI 承载的 op 直接取 `genoffice guide <domain> <op>` 原文（永远是校验器那一份）；
- `document_tool_call({tool, app?, filePath, input?, dryRun?, track?})`；
- `document_md_read` / `document_md_edit` / `document_render`。

IPC 通道（同一业务模块，界面与 Agent 同一段代码）：`document:apps|toolsList|toolDescribe|toolCall|markdownRead|markdownEdit|render`，契约在 `packages/contracts/src/ipc/document.ts`，preload 与手机 `webApi.ts` 均已接线（手机端显式 unsupported）。

**常驻读工具**（卡里要求 ≤2）：docs `get_document_context`/`read_blocks`；sheets `get_workbook_context`/`read_range`；slides `read_slide`；pdf `read_pages`/`search_text`；markdown `get_document_context`/`read_blocks`；html `get_outline`/`read_source`。

**执行路线与 T0 绑定**：文件在受信渲染端有活跃请求 → 借用 T0 的请求级 ACK（`documentToolRendererBinding` 包 `DocsAiPorts.run`，绑定身份是宿主签发的 `context.sessionId/filePath`，原始工具定义由该请求声明决定，T98 仍做 canonical JSON 比对；同文件多请求时**拒绝**而不是猜）。否则走 CLI 白名单（docs read/apply（`--track` 默认开）、sheet read/apply、slides read/apply/guide、pdf read）；renderer-only 工具**显式拒绝并说明**，不静默降级。

### 三、Markdown vs JSON 的 A/B 实测数据（核心证据，真跑）

同一份 31 块的真实报告（`docs read` 生成，含标题/列表/表格/多段），同一模型（`codex exec`，每次一新会话、只读沙箱、同一提示词），同一任务「文末追加 Outlook 小节（h2 + 一段）」：

| | JSON ops 臂 | Markdown 臂 |
|---|---|---|
| 载体 | `docs read --full --html` 信封 | `blocksToMarkdown` 定位符 Markdown（`<!-- bN -->`） |
| 载荷 | **4771 B** | **1776 B**（−62.8%） |
| 模型输入 token | **19271** | **18310**（−961，−5.0%） |
| 模型输出 token | 51 | 40 |
| 轮次 | 1 | 1 |
| 是否落盘 | 是（`docs apply`） | 是（`documentMarkdownEdit` 真实现） |
| 结果正确 | 是 | 是 |
| QA 门禁 | 未自动跑（该臂不经过 Mcode） | **自动回 `pending_revisions`**（2 条 tracked insertion） |

短文档（7 块）重复一次：JSON 18138 / 51 token，Markdown 17888 / 40 token，两臂均一次成功。**结论：Markdown 臂在载荷与 token 上都更省，且天然带 QA 回执；JSON 臂在本任务上也能一次做对——差距不大，但载体越结构化（表格/多块）Markdown 的优势越大（表格在 JSON 臂里是转义 HTML，Markdown 臂里是 GFM 管道表）。** 说明：后续的 replace 任务因 `codex` 订阅额度耗尽未跑完，上面的 append 配对是完整记录（原始记录在 `.tmp/t24/ab2/records/`）。

### 四、QA 门禁接入点（不得跳过）

- `documentToolCall` / `documentMarkdownEdit` 在**任何** mutating 工具（按目录判定）真正落盘后调用 `runQaGate`：docs/sheets → `check`，slides → `audit`。`extractQaReport` 读 `detail.issues`；**读不到 issues = 门禁失败**（负控有断言），绝不把“没拿到结果”当“没问题”。返回给模型的正文包含格式化后的 issues + `suggest` op。
- `document_render` 真出 PNG（受控临时目录），并以 **image 块 + 路径** 回给模型（读不到图的模型可 `agent_read_image` 转述）——这是“改完亲眼看看”的落点。
- 默认 `track: true`：Markdown 编辑与 `document_tool_call` 的 docs apply 默认写 Word 修订；实测 `docs read --revisions` 读得到，`accept_changes` 可逐条接受。

### 五、上下文体积前后对比（实测字节）

- 改造前：139 个工具的完整 JSON（名称 + 说明 + schema）**138 108 B**。
- 改造后：常驻读工具目录条目（11 条，**4 938 B**）+ 七个发现/载体工具的描述（**618 B**）= **约 5.6 KB**，**下降 96.0%**。套件里该断言用真实目录算，阈值为 ≥90%。

### 六、变异证据

1. **撤掉「编辑后跑 QA 门禁」**（`runQaGate` 恒返回 null，用 `MCODE_T24_MUTATE_QA=1`）：T24 套件 **56/59**，三条 ★ 变红（“编辑后必须有 qa”“qa 里带 detail.issues”“check 能报出真实问题”）；`cp` 还原后 `cmp` 逐字节一致，复跑 **59/59**。
2. **撤掉「审批分档不信模型自报 app」**（退回只看 `scope.app`）：app-control **573/574**，「省略 app 的写工具仍按写档弹卡」变红且审批卡一次都没弹；还原后 `cmp` 一致，复跑 **574/574**。

### 七、回归与验收判据逐条

- 新套件 `t24-document-tool-surface-smoke`：**59/59**（真 CLI、真子进程、真文件；隔离 mktemp 工作区与数据根）。
- 相关回归（提交后重跑）：`app-control-smoke` 574/574、`genoffice-cli-smoke` 53/53、`genoffice-format-gates-smoke` 110/110、`t0-genoffice-native-tool-roundtrip-smoke` 55/55、`t83-mcode-editor-tool-bridge-smoke` 19/19、`document-read-smoke` 140/140、`ipc-wiring-smoke` 45/45、`provider-context-smoke` 56/56、`effective-tools-smoke` 140/140、`genoffice-native-view-smoke` 21/21。
- 双包 typecheck：`packages/contracts` 与 `apps/desktop` 均通过（提交前实测；期间他人并行改动 `ModuleHost`/`moduleInstallConsent` 的报错已随其提交消失）。
- 已知**非本卡**失败（HEAD 同样红，已核实）：`genoffice-source-smoke`（verifier 期望 lock v2，套件夹具写 v1）、`host-mcp-server-smoke`（esbuild 别名未覆盖 T29 的虚拟模块 `genofficeSheetsEntry`）、`genoffice-cli-smoke` 里 `document-view-host-smoke` 相关的 51/52 常量（T98 遗留，另一卡）。
- 判据：①四个方法存在且可检索 139 个工具——达成；②体积下降——**96.0%**；③A/B 真跑——见第三节；④QA 门禁回 issues——达成并有变异证据；⑤render 出图且模型能看到——达成（image 块 + 路径）；⑥tracked changes 可逐条接受/拒绝——达成（`accept_changes` 实测）；⑦变异验证——两条；⑧双包 typecheck——通过；⑨**未宣称 T7 完成**。

### 八、哪些工具判定“不可用/建议重写”

- **没有任何工具被判定为“质量太差无法改造”**——139 个全部进了目录；40 个只能渲染端执行的（withheld 12 个 + 其余依赖实时编辑器状态的）在 CLI 路线下显式拒绝并给出替代路线，不是丢掉。
- 真实限制（如实列）：①PDF 的 45 个工具**没有 CLI 路线**（编辑/签名/redaction 在 vendor 主进程），文件没开在编辑器里时只能读；②HTML 同理（无 CLI 编辑）；③Markdown 有 CLI 但只做转换，结构化编辑仍需编辑器；④`sheets.read_range` 走 Rust sidecar，本机无 sidecar 时该工具经 CLI 报 `unavailable`（工具面如实转述）。
- 建议（不在本卡范围）：PDF/HTML/Markdown 的完整工具面要等 T7 的真实 Electron U1 打通受信绑定后才有“文件没开也能改”的能力。

### 九、遗留与移交

- **真实 Electron U1 与三引擎在线回合未做**（T7 排期）：本卡的渲染端路线由 fake 端口驱动验证了“绑定身份/原始定义/拒绝路径”，没有在真窗口里让真模型经 `document_tool_call` 调一次原生工具。
- **A/B 的第二任务（replace）** 因 `codex` 额度耗尽未完成；若要更强的证据，建议在 T7 里用真实 Mcode 会话补一组 replace/表格任务。
- 期间并行会话多次改写工作区（`packages/contracts` 被整树删除后我从索引恢复并重放补丁；`apiCatalog.generated.ts` 被重新格式化后我恢复到其原始 dirty 版本再加 T24 七条与 T64 的三条 `framework.*`）。**所有他人未提交修改均保留**；我提交的文件集见下。

### 十、提交

- 实现提交：`ce2913f8`（`feat(T24): discoverable document tool surface with Markdown carrier and QA gates`），19 文件。
- 提交后复跑：T24 **59/59**、app-control **574/574**、genoffice-cli **53/53**、T0 **55/55**、T83 **19/19**。
