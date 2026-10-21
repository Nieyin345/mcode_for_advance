# Mcode 任务分派台

> **这份文件是给我（总控对话）和你（用户）看的索引。**
>
> 每个任务 = `tasks/` 下的一个 `.md` 文件。文件自带完整的执行要求、验收判据、
> 禁止事项，以及**结果回写区**。执行对话读它、做事、把结果追加在同一文件末尾。
>
> **给执行对话的固定指令**在 [`tasks/_PROMPT_TEMPLATE.md`](_PROMPT_TEMPLATE.md)。
> 复制那段话、只改文件路径，就能开一个执行对话。指令本身不改。

---

## 第三轮交付复核（2026-10-22，最新生效）

> **派发与验收事实**：T83、T84、T85、T76、T82、T78 六卡均已派出。T84/T82/T78 已交付；T83 的 fail-closed 能力门已提交，但真实同轮工具结果回传尚未实现。T85 已提交 G0/G1 预检，34/34 断言与两项变异通过；G2–G5 仍按设计阻断。T76 的 24/24 资源门禁通过，但发现真实发行阻断（GenOffice patch lineage/许可证文本、Node-RED 许可证覆盖），不能签真实 installer。总控确认 GenOffice 当前 HEAD `355e6673` 是第一条批准补丁 `73ba9180` 之后的 12 个 Mcode patch commits，仓库已有对应 `patches/genoffice/0001..0012`；现有 verifier 只表达单补丁，不能简单回退或改 SHA。后续卡 T87（GenOffice lineage + 18 项 notice）与 T88（Node-RED 许可证覆盖）已准备，可并行但尚未派发。T49 代码和结果回写均已提交，但 17 个 module/authoring suites 为 16 PASS / 1 FAIL，缺失 `workflowEngine.load` 权限映射仍需收尾。请勿重复派发、覆盖或清理其他执行对话的修改。PDF 路由尾项已关闭。T86、T87、T88 均已准备、尚待派发；T71/T77 仍需独占 Electron，先 T71、退出后再 T77。
> **第二轮 T30/T72/T73/T74/T75/T79/T80/T81 八卡均已提交、完成本卡交付**。T73 在本次总控审查期间先提交功能 `c3672167`、随后回写 `7442ebcb`；总控独立执行 `t73-browser-sandbox-smoke/run.cjs` **5/5 PASS**、真实 Electron `native.cjs` **PASS**（隔离 WebContentsView、spoof 拒绝与合法拾取）。其余七卡也有提交与回写，且总控独立 E1：`genoffice-file-routing-smoke` 52/52（含两变异）、`t74-genoffice-headless-smoke` 1/1 套、`mcode-node-pack-smoke` 1/1 套、`runtime-node-modules-smoke` + `library-import-smoke` 2/2、`arc005-focus-ownership-smoke` 1/1、双包 TS 2/2；`document-router-smoke` 原 124/125 失败已由 `e9e2dbf5` 修正测试判据、`e290df57` 回写关闭；总控最终复核路由 133/133、GenOffice 路由 52/52、FileViewer PDF 25/25，通过且未改产品路由。
>
> T80 回写的 22 个环境首错历史结果为 **21 PASS / 1 PDF 旧断言 FAIL**，后者已关闭；T80 的完整 22 套批次尚未由总控重新复跑，T81 自验 Windows 27/27。T72/T75 为审查成果，不是 FULL-3/GenOffice 六 AI 的实现闭环。T73 的 `BrowserManager.ts`/`browserPicker.ts`/`electron.vite.config.ts` 已提交。T49 的代码提交 `2af6b0ec`、结果回写提交 `f1198793` 已存在；当前双包 TypeScript 检查通过，`module-contributions-smoke` 和 `module-phase2-e2e-smoke` 已转绿，但 `module-permissions-smoke` 仍因 `workflowEngine.load` 缺少 `APP_METHOD_PERMISSIONS` 映射而失败。T67/T69 将该映射缺口归到 T49 收尾边界，尚不能签 T49 全部验收。T76 的真实发行包与许可证闭环、T73 真实发行包/真实站点 U1、T71/T77 完整原生编辑器 GUI U1 仍需另验。

| 派发窗口 | 新 / 已备任务 | 准确文件路径 | 文件边界、门禁 |
|---|---|---|---|
| **已提交；保留 U1** | **T84** Slides 原厂 `ai:*` 未授权媒体通道隔离 | `tasks/T84-genoffice-slides-ai-ipc-boundary.md` | 代码 `c4887d5a`；29/29 回写，独立 smoke 1/1 PASS；当前 contracts/desktop tsc 均 PASS；真实 Electron/真人授权 U1 未做，Hosted 原厂媒体通道继续 fail-closed |
| **已提交能力门；功能前置未满足** | **T83** GenOffice 三 SDK 原生工具调用桥 | `tasks/T83-genoffice-mcode-native-tool-calls.md` | 代码 `309c3ab5`；19/19 fail-closed smoke；独立相关回归 6/6、当前双包 tsc PASS；真实同轮工具结果未实现，需先派发 T86，随后再建 renderer 接线集成卡 |
| **下一步可派（尚未派发）** | **T86** Mcode 三 SDK 请求级结构化工具协议 | `tasks/T86-mcode-runtime-native-tool-protocol.md` | T83 已证明当前缺少 per-turn schema / 同轮 renderer result callback；只改 provider contract / RuntimeManager / 三 SDK adapter，不改 T83/T49 文件；可与权限映射尾项并行 |
| **已提交；G0/G1 验收通过** | **T85** Node-RED 旧图 G0/G1 无损迁移预检 | `tasks/T85-node-red-migration-preflight-proof.md` | 实现 `96825dc9`、结果 `d5674cdb`；34/34、两项变异按预期失败、相关迁移回归 8/8；当前双包 tsc PASS；G2–G5、真实用户数据和 Deploy 仍明确阻断 |
| **已提交；发现发行阻断** | **T76** 两原厂安装资源/许可完整性 | `tasks/T76-vendor-release-resource-integrity.md` | 实现 `ab9149eb`、结果 `4eed981f`；专项 24/24、GenOffice release 25/25；GenOffice 12-patch lineage 与 18 个 notice 全文待闭环，Node-RED 15 个依赖缺许可文本、`cli-table`/`pause` 元数据待核实；未跑真实 installer/U1 |
| **下一步可并行（尚未派发）** | **T87** GenOffice 上游补丁链与 18 项许可证 notice | `tasks/T87-genoffice-patch-lineage-and-license-notices.md` | 验证 `cbec600a → 73ba9180 → 12 个 patch → 355e6673` 可重现；严格 notice 18/18 全文；不改嵌套 `genoffice/**`，不跑 installer |
| **下一步可并行（尚未派发）** | **T88** Node-RED 第三方许可证覆盖 | `tasks/T88-node-red-third-party-license-closure.md` | 15 个依赖补齐版本级许可全文，核实 `cli-table@0.3.11` 与 `pause@0.0.1`；不改 `node-red/**`/现有 node_modules，不执行 npm ci |
| **审计交付完成** | **T78** UI 39 真实场景证据和差距审计 | `tasks/T78-arc005-visual-baseline-gap-audit.md` | 审计 `9cb27dec`，回写 `f4fd9bb9`；39 场景分类完成，但真实 Claude 安装版对照/U1 不在本卡范围 |
| **已提交；当前独立复核通过** | **T82** emit-path 过期事件扫描断言 | `tasks/T82-emit-path-smoke-event-shape.md` | 代码 `143e13a5`、回写 `7ca737cd`；41/41，独立复跑 `emit-path-smoke` PASS，当前 contracts/desktop tsc 均 PASS；旧回写中的并行 TS 阻断已不再复现 |
| **第三轮：可开独占 Electron 窗口** | **T71** 六原生文档 GUI U1 | `tasks/T71-genoffice-six-native-gui-acceptance.md` | T30/T73 均已提交；**与 T77 串行**，只用隔离样本 |
| **第三轮：与 T71 错峰** | **T77** Node-RED GUI U1 | `tasks/T77-node-red-native-electron-ui-acceptance.md` | T79/T73 均已提交，**必须独占 Electron**；仅隔离样本 |
| **代码已提交；验收尾项未闭合** | **T49** 扩展 API | `tasks/T49-extension-api-surface.md` | 代码 `2af6b0ec`、结果 `f1198793`；17 suites 为 16 PASS / 1 FAIL；`workflowEngine.load` 权限映射缺口仍需按 T67/T69 收尾；不另派重复 T49 owner |
| **已收尾（2026-10-21）** | `document-router-smoke` PDF 路由断言尾项 | `apps/desktop/scripts/document-router-smoke/main.ts`、`apps/desktop/scripts/file-viewer-basedir-smoke/main.ts` | 代码提交 `e9e2dbf53c27bbead3171654ea0ac812323fbfcd`；路由 133/133、GenOffice 路由 52/52、真实 FileViewer PDF 组件 25/25；未改产品路由；T80 完整 22 套批次本次未重跑 |

**验收口径**：任务卡交付完成 ≠ ARC/UXG 正式双勾。T72 的 G0–G5 尚未全闭环；T83 已 fail-closed，但需 T86 补齐 provider 同轮工具协议，再另开 renderer 接线卡；T84 的 Hosted 媒体门禁已通过静态/隔离验证，真实 Electron U1 仍待验；T85 仅交付 G0/G1，G2–G5 保持 blocked；T76 发现的许可证和上游 pin 问题是真实发行阻断，不因专项 Smoke 通过而放行；T49 的权限映射覆盖缺口仍需收尾。所有测试只用虚构文件/隔离数据库/本地 mock；不对真实帐号/文件或公网进行破坏性测试。

---

## 第一波验收后的下一波派发（2026-10-21，历史；下方旧历史派发表已过期）

> **第一波交付验收完成（非 ARC/UXG 整包双勾）**：T64 `a1690047`、T65 `b41d41e4`、T69 `d3f021db`、T70 `941de215`，四张卡各有提交/回写。总控在 HEAD `9efe0b46`（工作树部分 T49 dirty）独立复跑 `framework-prompt-smoke` 1/1、`ide-quote-snapshot-smoke` 26/26 断言、`scheduler-smoke`/`scheduler-data-smoke`/`scheduler-flow-smoke` 3/3、双包 tsc 0 error；T69 原日志 SHA 与报告相同，60 个不同失败套件（嵌套 Electron `FAIL SPE` 并非新套件）；T70 17/17 判据静态对照。**T65 字面判据 #2 引用早已删除的 `NoteEditor`，是旧卡前提失效；没有重建**。尚无真实 Electron/在线三 SDK/U1 和全仓稳定 HEAD 复测。T49 `main/modules/*`、`main/appControl/*` 仍在飞，不能再派新 owner。**下一波首选 T73、T74、T79、T80、T81、T30、T72、T75；可再加 T76/T78/T82。** 所有任务用 `tasks/_PROMPT_TEMPLATE.md` 的准确文件路径分别派发，彼此不要碰共享文件。

| 并行层 | 编号 | 实际文件名 | 可写热区与注意 |
|---|---|---|---|
| **现在可派** | **T73** 浏览器沙箱恢复 | `T73-browser-sandbox-preload-migration.md` | `main/browser/BrowserManager.ts` + 专用 `browserPicker` preload；与 T64/T65/T49 不重叠。实机 Electron 跑法与别的 UI 卡错峰 |
| **现在可派** | **T74** GenOffice 原厂无头 CLI 适配 | `T74-genoffice-cli-headless-operations.md` | 只占 `main/document/genofficeCli.ts` + 新测试；**不碰** T49 的 appControl/RPC |
| **现在可派** | **T75** 六编辑器 AgentSkill/AI 链审查 | `T75-genoffice-agent-skills-six-app-audit.md` | 只读六原厂应用源码及 Mcode AI 桥，不改已有实现 |
| **现在可派** | **T76** 原厂资源与打包许可证门禁 | `T76-vendor-release-resource-integrity.md` | 仅 `apps/desktop/build/stage-*/verify-*` 指定文件和新测试，不碰 dirty 的 `release-readiness-smoke`；不与完整 installer 构建并行 |
| **现在可派** | **T78** UI 39 场景真实基线/差距复审 | `T78-arc005-visual-baseline-gap-audit.md` | 只读 T01/T12 的基线和 `open-claude-ui`；不运行竞争性 Electron |
| **现在可派** | **T79** Node-RED 六节点图标/双语/帮助缺口 | `T79-node-red-node-palette-i18n-help.md` | T70 已定位具体源码红例；独占 `workflowEngines/mcodeNodeTypes.ts` / 节点 HTML + locale |
| **现在可派** | **T80** Windows sort -V 导致的 22 套 smoke 构建失败 | `T80-windows-sort-v-smoke-portability.md` | 独占 T69 指定 22 个 `run.sh` 及 `scripts/lib/esbuild-path.sh` |
| **现在可派** | **T81** Windows 临时 node_modules 链接导致的 27 套 smoke 失败 | `T81-windows-node-modules-symlink-smokes.md` | 独占 T69 指定 27 个**不与 T80 重叠**的 `run.sh` 和新 helper |
| **现在可派** | **T82** emit-path 事件扫描旧断言纠偏 | `T82-emit-path-smoke-event-shape.md` | 只改 `scripts/emit-path-smoke/main.ts`；生产事件通路只读 |
| **现在可派** | **T30** 六编辑器格式唯一路由 | `T30-genoffice-unified-file-routing.md` | **T65 已提交**；注意 `document-router-smoke/main.ts` 仍有其他在飞修改，不覆盖 |
| **现在可派** | **T72** Node-RED 唯一工作流权威差距 | `T72-node-red-single-authority-gap-audit.md` | **T70 已提交**；只读审计，不删除旧调度器 |
| **等 T79 后** | **T77** Node-RED 真实 Electron 编辑器/Deploy U1 | `T77-node-red-native-electron-ui-acceptance.md` | 独占 Electron；**不能**与 T71 或其它真实 UI 探针并行；只写新夹具 |
| **已解除前置** | T30、T72 | 详见上方“现在可派” | T65 和 T70 已提交，按新任务卡的文件互斥检查即可 |
| **原计划第三波** | T71 | 详见下文 | T71 **等 T30** 且独占 Electron |

**并发约束**：代码修改可多对话，但全量 smoke / Electron 探针 / installer 构建需要资源门禁，尤其不能同时跑多个完整 `--all`。T80 与 T81 只在 T69 的 22+27 个不重叠 `run.sh` 下工作，**共享 `scripts/lib/esbuild-path.sh` 归 T80**，T81 只写自己的 helper；不要用同一个 temp 路径和 node_modules 测试夹具。T73 的 `electron.vite.config.ts` 局部变动不允许 T76 写，T76 只做 staging/verify。T49 的未提交代码不得被 T73/T74/T76 顺手覆盖。T69 的 60 红历史混合快照经审计归类 A50/B6/D3/E1/C0，**不是当前产品 60 个明确 Bug**。真模型/生产文件/账号/用户安装器均不得用于破坏性验证。

---

## 最新总控派活入口（2026-10-21 晚；优先于本文下方旧时点“可派顺序”）

> 当前仓库 HEAD：`1bfc4adc`。本轮已核对任务回写、相关提交、工作树与正式台账规则。**任务卡写回 ≠ 任务所有判据全达成 ≠ 独立复核通过 ≠ ARC/FULL 整体验收**。本轮在有未提交代码的情况下不启动全量 smoke，不自签正式双勾。

| 顺序 | 直接派发的准确任务文件 | 边界 / 依赖 |
|---|---|---|
| **第一波（可并行）** | `T64-framework-prompt-customization.md` | 只改调度提示词与对应设置 UI |
| **第一波（可并行）** | `T65-monaco-selection-citation.md` | 独占 FileEditor/NoteEditor；阻止 T30 同时改 |
| **第一波（可并行）** | `T69-60-smoke-failure-triage.md` | 仅只读失败归因与本卡回写；不要跑全量/并行 Electron |
| **第一波（可并行）** | `T70-node-red-t43-t44-gap-audit.md` | 只读比对旧 T43/T44 与 T42 实际实现，避免重复开发 |
| **第二波** | `T30-genoffice-unified-file-routing.md` | 等 T65 提交，统一六格式路由 |
| **第二波** | `T72-node-red-single-authority-gap-audit.md` | 等 T70，核对 T46 双引擎过渡与 FULL-3 目标 |
| **第三波** | `T71-genoffice-six-native-gui-acceptance.md` | 等 T30，且无其它 Electron 测试并行 |
| **暂缓** | `T49-extension-api-surface.md` / `T51-real-ai-regression.md` | T49 还有未提交的 `main/modules/*`、`appControl/*` 等修改，不能重复派发；真 AI U1 要等 T49 收口 |

正式主路线：`audit-ledgers/Mcode_统一审查台账.md` 的 2026-10-20 FULL-0～6（Node-RED 最终唯一内核、GenOffice 六原生编辑器、复用优先 L1→L4）。任务卡仅负责切片，正式 ARC/MC 双勾须有独立实证。

**注意**：下面保留历史派发表/下一步建议供追溯，其中状态可能过期；派发以本节和任务卡现存内容为准。T66 只完成首阶段，不在其他修改 Store 的任务期间继续拆主干。T43/T44 暂不直接派，先拿 T70 差距矩阵。T68 全量 60 FAIL 是并行状态下的历史混合结果，不能当稳定当前全仓红例或忽略。

---

## 判定规则（唯一）

**执行对话把结果写进「结果回写区」= 该任务完成。** 不再由我二次判定"部分完成"。

写回里自己列出的「未达成 / 剩余风险」是**如实记录**，属于后续新任务卡的范围，
不影响本卡的完成状态。

---

## 唯一目标

**Mcode 的最终效果 = Claude 桌面端的 UI。其余一切功能都用「复用上游源码做二开」实现，不从零写。**

| 线 | 复用什么 |
|---|---|
| **UI** | `open-claude-ui/`（Claude 桌面端逆向，MIT） |
| **文档** | `genoffice/`（六套原生编辑器，Apache-2.0） |
| **工作流** | Node-RED 5.0.8 源码（commit `935b8d3`） |
| **扩展** | `ModuleHost` + VS Code API 薄映射 |

我的职责只有四件：写任务卡、监控回写区、核对完成状态、告诉你派什么。**不写业务代码，不提问。**

---

## 派活前必读：台账的复用优先级（L1 → L4）

**这条优先于本文件里任何任务卡的措辞。** 台账 2026-10-20 总路线图写死了四级路径：

| 级 | 做法 | 何时用 |
|---|---|---|
| **L1 直接复用** | 固定上游 repo/commit/许可，直接用其原生包、renderer、main、preload、引擎 | **首选** |
| **L2 薄宿主适配** | 只在身份/权限/IPC/UI 边界不同时补窄 Adapter | 次选 |
| **L3 可审计 fork** | 原厂确实缺能力才在固定 fork 上改，保留升级/来源 SHA/LICENSE/回滚 | 第三 |
| **L4 最小自有逻辑** | 仅 Mcode 专有的 Agent 节点、宿主授权、CAS、审计 | **最后**，且须附「已检索上游仍无对应能力」的源码证据 |

**没有 L4 证据不得从零写。** 每个任务卡都必须写明它属于哪一级、复用的是什么。

对照到四条线：

| 线 | L1 复用对象 |
|---|---|
| **UI** | `open-claude-ui/`（逆向，MIT）——色阶、动效、组件、分割拖拽 |
| **文档** | `genoffice/`（Apache-2.0，已 vendor）——六套原生编辑器 |
| **工作流** | **Node-RED 5.0.8 源码**（不是为了跑起来，是为了改它的编辑器） |
| **扩展** | `ModuleHost` + Theia `plugin-ext-vscode`（或 `vscode.d.ts` 薄映射） |

---

## 怎么用（你）

1. 从下面表格挑一个**未开始**的任务。
2. 打开 [`_PROMPT_TEMPLATE.md`](_PROMPT_TEMPLATE.md)，复制代码块里的整段指令。
3. 把里面唯一一处 `tasks/XXXX.md` 换成该任务的路径，例如
   `tasks/T01-electron-visual-baseline.md`。
   **文件名必须与磁盘一致** —— 不确定就先 `ls tasks/ | grep T01` 看实际名字，
   写成 `T01.md` 会让执行对话在第一步就 ENOENT 停住（T09 已经踩过一次）。
4. 发给一个全新对话。它会自己读任务文件、读台账规则、干活、回写结果。
5. 做完之后回来告诉我编号，我核对结果与台账，决定是否放行。

**用户侧派发数量没有上限** —— 能开几个开几个。
真正要守的只有一条：**不要派两个对话改同一批文件** —— 任务文件里已经写死了各自的文件边界。

派之前对照各卡的「边界（不要碰）」一节，确认新卡与在飞卡改的不是同一批文件即可。
冲突高发的几个热区：`components/settings/`（T24 独占）、
文件写路径 `lib/atomicFile.ts`（T25 独占）、`scripts/` 下的 stub/prelude（T26 独占）。

---

## 任务总表

| 编号 | 标题 | 类型 | 依赖 | 状态 |
|---|---|---|---|---|
| T01 | 真 Electron 逐屏视觉基线（浅/深/窄窗） | ARC-005 U1 | 无 | ✅ 完成（后由 T12 补到 39/39） |
| T02 | 自由 Pane 停靠（照抄 ArtifactsSplitPaneResizer） | ARC-005 核心缺口 | 无 | 已完成（50/50 双重取反由总控修复；U1 见 T15） |
| T03 | ARC-006 Gate D：唯一执行器/触发器接线 | ARC-006 | 无 | 已完成（原派活范围；落盘为增量，见 T10） |
| T04 | 手机远程全量 UI 对齐 | ARC-005 | 无 | ✅ 完成（96 断言，27 处 44px 修复；test:all 12 红与它无关） |
| T05 | ~~GenOffice Docs 全功能迁移~~ | — | — | **已拆分为 T05a/b/c** |
| T05a | Docs 迁移一：纯文档操作（6 组） | ARC-007 | 无 | ✅ 完成（25 handler 逐项登记；6 patch 可复现） |
| T05b | Docs 迁移二：需权限操作（10 个 handler） | ARC-007 | T05a | ✅ 完成（10/10 受控接线 + 两变异） |
| T05c | Docs AI 面板：默认拒绝 + 经三 SDK 可用（12 个 ai:*） | ARC-007 | T05b | ✅ 完成（受控链 + 14 云入口拒绝 + 两变异） |
| T18 | 输入框重做（复用 RichComposerWithMentions + ChatComposer） | ARC-005 UI | 无 | ✅ 完成（19/19 行为断言 + 两变异；未替换 Tiptap） |
| T19 | Node-RED 源码 vendor 第一步：落地 + 解析链路 | ARC-006 | T13 | ✅ 完成（vendor 5.0.8 / 解析+T19 fallback / afterPack 校验） |
| T20 | 工件预览沙箱 + 语音活动条（第三批逆向件） | ARC-005 UI+安全 | 无 | ✅ 完成（7 MIME 分流 + 真 MediaStream 六频段） |
| T21 | 顶栏 macOS 红绿灯避让 + 附件磁贴（第四批逆向件） | ARC-005 UI | 无 | ✅ 完成（74/zoom 公式 + 7.5rem 磁贴 + 智能截断） |
| T22 | Docs 后续切片：exportPdf 整链 / lazy-media 三类源 / files:read | ARC-007 | T05c | ✅ 完成（PDF 本地拆页 + 图片源四类策略 + 附件读取） |
| T23 | Pane 剩余能力：可调分割线 + 布局预设 + 重置 | ARC-005 UI | T02 | ✅ 完成（比例流 + 18%/82% 折叠 + 三预设 + 重置） |
| T24 | 设置页全面重构（63 面板对齐 CDS） | ARC-005 UI | 无 | ⚠️ **限定范围验收**（`cb3f59be`；判据 1/3/5 过，2/6 部分，4 被 T29 的类型错阻断） |
| T25 | 原子写与冲突副本的故障注入回归（maint-m07 9 红） | 数据安全 | 无 | ✅ 完成（`8f43c24e`；总控独立复跑 4/4 PASS） |
| T26 | 修好三套自坏的 smoke 脚手架 | 测试基础设施 | 无 | ✅ 完成（`f98df6ff`；总控独立复跑 2/2 PASS） |
| T07 | 文档/Node-RED 同壳整合 | ARC-005+007 | T02, T05, T23 | ✅ 完成（`41c42f03`；12/12 套件 + 变异 2/2；未做真 Node-RED 未部署 flow 端到端） |
| T28 | **GenOffice pdf / markdown / html 接入**（直接调原厂 `createXxxView`） | **ARC-007 主线** | T22 | ✅ 完成（`858d3c7b`；12/12 套件 + 2 变异；未做真 Electron GUI 端到端） |
| T29 | **GenOffice sheets / slides 接入**（同上，含 `queueWorkbookForView`） | **ARC-007 主线** | T22 | 已接线 `dc974b2c`，T53 文件实测，T57 修无修改保存；整 GUI U1 待 T71 |
| T30 | **六编辑器文件路由唯一判据**（GenOffice 预留） | ARC-007 FULL-2 | T29、T65 | **待 T65 提交再派** |
| T42 | **把 Mcode 节点包装进 Node-RED**（`nodesDir` + bundle + 清单校验） | **ARC-006 主线** | 无 | ✅ 完成（`9d390a7e`；六节点真运行；报告两条独立红项转 T54） |
| T43 | 节点的 `McodeAgentPort` 生产实现（接到三引擎/审批/ModuleHost） | ARC-006 主线 | T42 | 暂停重复派发：T42 已覆盖部分，先 T70 逐项验差距 |
| T44 | 节点包 i18n / 图标 / 分类 / 帮助文本 | ARC-006 | T42 | 暂停重复派发：T42 已覆盖部分，先 T70 逐项验差距 |
| T45 | **工作流 UI：删手写画布（685 行），切到原厂编辑器** | ARC-006 主线 | T42 | ✅ 完成（`351e4d9b`；三条未闭环转 T58） |
| T46 | 执行归属：原生调度器 vs Node-RED 运行时 | ARC-006 主线 | T45 | ✅ 完成（`5b8f9cbb`；选 B 双引擎+整图归属；原生节点看板盲区转 T60） |
| T47 | **Node-RED 编辑器主题**（官方 build-custom-theme） | ARC-006 | 无 | ✅ 完成（`1566a414`；20 个变量映射，其余沿用原厂；发现卡里写的 token 名不存在，用了真实存在的） |
| T48 | **扩展权限模型**：安装时一次性授权（手机应用式） | **扩展主线** | 无 | ✅ 完成（`0b414a62`） |
| T49 | **扩展调用面**：把 438 个 RPC 暴露给扩展（`core.app.call`） | **扩展主线** | T48 | 代码/回写已提交；专项与双包 tsc 通过，但 `module-permissions-smoke` 因 `workflowEngine.load` 缺映射而 FAIL，验收未闭合 |
| T50 | **扩展 UI 贡献点**：命令 / 侧栏面板 / 设置项 | 扩展主线 | T48 | ✅ 完成（`7eb548c9`；留下一处 e2e 红转 T58） |
| T51 | **让 AI 会写扩展**：`app_guide` topic + `extension_validate` + 模板 | **扩展主线** | T48、T49 | ⚠️ E1 完成；真 AI U1 待验（`T51-real-ai-regression.md`） |
| T52 | **smoke 急救**：501 套里 25 套红，其中 15 套是构建就崩 | **测试基础设施** | 无 | ⚠️ **已修构建链，验收受阻**（503 套全量 481/22，原红复测 17 转绿、5 条其它域断言仍红；见任务回写区） |
| T53 | **T29 续篇**：用真实 sidecar 验完 xlsx / pptx | ARC-007 | T29 | ✅ 已回写并提交 `276c6a12`；发现 PPTX no-op 缺陷转 T57 |
| T54 | 原厂 sheets/slides 的 Pane 外 IPC 围栏 | 安全 | T53 | ✅ 完成（`f4a81d5e` + genoffice `aba076cc`；26 条分类，新套件 109/109） |
| T55 | Node-RED 两条回归：主题 manifest 版本 + e2e 断言 | 回归修复 | 无 | ✅ 完成（`42a40ae8`；两条都是断言过时，4/4 套件 PASS） |
| T56 | 三套 UI/策略回归 | 回归修复 | 无 | ✅ 完成（`1934a722`；10/10 + 23/23 + 27/27，三条全是测试过期） |
| T57 | **PPTX 无修改保存不该改写字节**（T53 发现的真实缺陷） | 数据安全 | T53 | ✅ 已提交 `f24f3331`；原红变异已见红，历史类型检查曾被并发修改阻断 |
| T58 | **T45 删画布后的遗留**：两个套件红 + 保存回写工作流库缺失 | 回归 + 功能 | T45、T50 | ✅ 已提交 `74aeaa79`；保存回写已接，真实 GUI Deploy U1 仍待 |
| T59 | **选中的库文档要能装进 Node-RED 画布** | 功能缺口 | T45、T46、T58 | ✅ 完成（`d3517719`；选 A 启动前装载，不发 POST /flows 所以无回写环） |
| T60 | **Node-RED 原生节点也要进运行看板** | 功能缺口 | T42、T46 | ✅ 完成（`edbee229`；纠正了我卡里 runtime-event 的错误前提，改用 onReceive/onComplete） |
| T61 | **两套 smoke 引用了不存在的 electron 桩** | 测试基础设施 | 无 | ✅ 完成（26/26 + 27/27；顺带发现 116 套里有 4 套旧红） |
| T62 | **给 AI 加记忆写入工具**（`memory_write`/`search`/`forget`） | 功能缺口 | 无 | ✅ 已提交 `ae063acd`；8 套记忆专项自验通过，非整 U1 |
| T63 | **hook 加第二种动作：交给某个代理** | 功能缺口 | 无 | ✅ 已提交 `1bfc4adc`；9 项任务判据自验通过，真实模型 U1 待独立验 |
| T64 | **框架层提示词可自定义** | 功能缺口 | 无 | ✅ 本卡已提交 `a1690047`，总控独立 `framework-prompt-smoke` 1/1 + 调度 3/3 + 双包 tsc PASS；真实 UI U1 尚未做 |
| T65 | **Monaco 的选段引用**（三处里的最后一处） | 功能缺口 | 无 | ✅ 现存入口已提交 `b41d41e4`；总控独立 26/26 + 双包 tsc PASS；字面 #2 `NoteEditor` 已删除不再有效，真 UI U1 待验 |
| T66 | **sessionStore 按域切片**（7,603 行 / 145 动作） | 技术债 | 无 | ✅ 第一阶段已提交 `746365ae`：3 Store，主干约 7,456 行；critical 16/17 |
| T67 | **T59 加了 RPC 但没更新 apiCatalog** | 回归 | T59、T61 | ✅ 已提交 `5b14a9c3`；专项 572/572（任务回写证据） |
| T68 | **smoke 基线复查：四套旧红例** | 测试基础设施 | T61 | ✅ 已提交 `0fc29481`；四套目标已修，历史全量 450/510，60 红归因见 T69 |
| T69 | **60 套 Smoke 红例分类归因** | 测试诊断 | T68 | ✅ 交付已提交 `d3f021db`；总控核对原始 SHA 与 60 个唯一失败套；A50/B6/D3/E1/C0，待 T80/T81 等修复与同一冻结树复测 |
| T70 | **T42 与 T43/T44 重叠差距复核** | ARC-006 审计 | T42 | ✅ 交付已提交 `941de215`；总控核对 17/17 判据矩阵 + 5 个重复图标等静态缺口，后续 T79/T77；不重派整张 T43/T44 |
| T71 | **GenOffice 六编辑器真实 Electron U1** | ARC-007 U1 | T30 | **等 T30，且 Electron 测试清场** |
| T72 | **Node-RED 最终唯一工作流内核门禁** | ARC-006 审计 | T70 | **等 T70 回写** |
| T06 | MC-035 OS 级网络出站隔离 | MC-035 复核失败项 | 无 | 部分完成（判据 2/3/6 未达成：Windows 无 OS 沙箱、Linux/macOS 无 Node 五路实证） |
| T07 | 文档/Node-RED 同壳整合 | ARC-005+007 | T02, T05, T23 | ✅ 完成（见上） |
| T08 | 三引擎能力对齐收尾 | ARC-003 | 无 | ✅ 完成（27 类×3 引擎矩阵；跨层去重是真实缺陷，只记录未改） |
| T09 | ~~AOCI 索引补录~~ | — | — | **已取消**（用户决定不再用 AOCI） |
| T10 | executor owner 注册表落盘（增量，原派活未含） | ARC-006 | T03 | ✅ 完成（81/81；跨进程 CAS 与部署回滚仍缺） |
| T11 | Windows 上收窄 egress fail-closed（修 T06 回归） | MC-035 回归 | T06 | ✅ 完成（6/6；两套原红已复绿） |
| T12 | 视觉基线补完：7 类高依赖屏的真实夹具 | ARC-005 U1 | T01 | ✅ 完成（39/39，0 data-missing） |
| T13 | Node-RED 源码集成调查（按 GenOffice 模式） | ARC-006 | 无 | ✅ 完成（锁 5.0.8 / `935b8d3`；Apache-2.0 可二开） |
| T14 | 扩展系统二开（复用 ModuleHost + Theia 兼容层） | ARC-006 | 无 | ✅ 完成（Theia 拆不动→降级薄映射；25/25） |
| T15 | 真 Electron 下的 Pane U1（T02 剩余两条） | ARC-005 U1 | T02 | ✅ 完成（9/9 + 两变异；Toast 竞态由总控修） |
| T16 | MC-035 补齐：平台级 egress 与五路实证 | MC-035 续 | T06 | ✅ 完成（Windows 走显式降级 C；WSL 五路变异成立） |
| T17 | 把还没用的逆向件接进 UI（第二批 6 个） | ARC-005 UI | 无 | ✅ 完成（6/6 件独立提交；session-store 过时断言由总控修） |

状态取值：`未开始` / `进行中` / `待我核对` / `已完成` / `阻塞`。
执行对话**不要**改这张表的「状态」列 —— 它由我维护。你只需在自己的任务文件里回写。

---

## 共享依赖处于编辑中时，任何套件都跑不起来（2026-10-21 踩坑）

**`packages/contracts/` 是全局共享依赖。** 只要它有未提交的改动（哪怕只改了一半），
所有 bundle 它的主进程套件都会在 **import 阶段**崩溃，不是断言失败。

实测：T50 在改 `modules.ts` 的 `contributions` 为 `discriminatedUnion`，
期间 `skills-nodes-ui` / `vscode-l1` / `node-red-e2e` 三套全崩：

```
TypeError: Cannot read properties of undefined (reading 'type')
    at Object.create (...) at ../../packages/contracts/src/modules.ts:4497
```

**这不是那些套件的回归，是共享依赖的半成品状态。**

**做法**：
- 派「改 `packages/contracts/`」的卡时，**明确告知用户：在此期间任何人的
  `test:all` / 全量 smoke 都会假红**
- 想跑全量，先确认 `git status --short packages/contracts/` 干净
- 改 contracts 的任务应该**尽快提交**，不要长时间挂着半成品

---

## 全量 smoke 与在飞任务冲突（2026-10-21 踩坑）

**有任务在跑 Electron 探针时，不要启动 `run-all-smokes.sh`。**

`document-view-*` 五套、`arc005-pane-electron`、`genoffice-native-view-smoke`
这些都会启动**真 Electron 进程**。全量 smoke 会把它们全部拉起来，
与在飞任务的探针抢 `.tmp/` 与 pdf.js 的 wasm 资源 —— 实测结果是
Electron 主进程弹「A JavaScript error occurred in the main process」然后崩溃。

**做法**：
- 全量 smoke 只在**没有任务在飞**时跑
- 或者先用 `MCODE_SMOKE_JOBS=1 MCODE_SMOKE_HEAVY_JOBS=1` 降并发，
  但仍然不能与在飞的 Electron 套件同时跑
- 想做「当前基线」时，挑**不碰 Electron** 的子集跑，别跑全量

---

## 编号规则（2026-10-21 立，踩过一次坑）

**每张新卡的编号必须先用 `ls tasks/T*.md | sort -V` 查一遍，不能凭印象。**
路线图里预留但还没写卡的编号**也算已占用** —— 写卡时如果发现某编号被路线图预留，
跳到预留区之后的第一个空号。

已经撞过一次：写 Node-RED 线时从 T30 开始编号，撞了 GenOffice 路线图预留的
T30–T41 整片区域，导致一次执行对话拿到「T34」却找不到文件（实际那个编号在
Node-RED 线里是「执行归属」，而路线图里是「CLI 剩余能力」）。
Node-RED 线已整体挪到 **T42–T47**。

**当前编号分区**：

| 区间 | 归属 |
|---|---|
| T01–T27 | 早期任务（已完成或已取消） |
| T28–T41 | GenOffice 线（路线图 `tasks/GENOFFICE-ROADMAP.md`） |
| **T42–T47** | **Node-RED 线** |
| T48+ | 之后的新卡 |

---

## 我（总控）的职责

- 维护本索引与状态列
- 收到「编号 X 完成」后：读该任务文件的回写区 → 核对证据（提交 SHA、smoke 结果、
  变异验证）→ 必要时自己复跑 → 更新统一台账 `audit-ledgers/Mcode_统一审查台账.md`
- 与你交涉方向与优先级
- **不再自己写业务代码**，除非是核对时发现的小修补或你直接点名

---

## 下一步（总控判定）

**当前没有紧急项。** 已完成 7 张卡，剩 4 张：

| 优先 | 任务 | 为什么是它 | 前提 |
|---|---|---|---|
| **1** | **T02 自由 Pane** | ARC-005 台账反复点名、唯一没动的核心缺口；T12 已把视觉基线拍完，改了布局也不会让基线失真 | 会改 `sessionStore.ts`(7510 行)，**不要与任何改 store 的任务并行** |
| 2 | T05 Docs 第二轮 | ARC-007 主线 | **必须先拆**：原厂 `docs-main.ts` 有 76 个 handler / 6543 行，一次做完不现实（见下） |
| 3 | T06 续篇（Windows OS 沙箱） | 平台限制，非缺陷 | 需单独立项（AppContainer/WFP），工程量大 |
| — | T07 同壳整合 | 阻塞 | 等 T02 + T05 |

### T05 必须先拆分

实测：`genoffice/apps/docs/src/main/docs-main.ts` **6543 行 / 76 个 ipcMain 注册**，
而 Mcode 侧目前只迁了 3 个（字体度量、拼写语言）。原卡写的是「逐 handler 迁移」，
按 76 个一次交付会变成一张永远做不完的卡。

建议拆成三张，按**风险**而不是按文件顺序：

- **T05a 纯文档操作**（读写当前文件、渲染、导出、查找替换）—— 风险最低，
  handler 数最多但都可隔离验证。
- **T05b 需要新权限的**（附件、外部链接、剪贴板、加密）—— 每个都要默认拒绝 + 审批。
- **T05c 明确不要的**（云 AI、用户身份、遥测）—— 只需在 `mcode-ipc.ts` 写清为什么不要。

拆分工作我可以直接做，你说一声。

### 用户拍板：Node-RED 按 GenOffice 模式 vendor 源码（2026-10-21）

用户明确：**要 Node-RED 的源码集成，不是 npm 下载包。**

现状（已核实）：`runtimeSupervisor.ts:737` 要求
`<dataRoot>/workflow-engines/node-red/node_modules/node-red/` 存在，
即「用户机器上 npm install 一份」。**改不了它**，所以我们另写了 685 行的
`WorkflowCanvas.tsx` —— 两套画布并存。

改用 GenOffice 模式（`genoffice/` 的做法）：
vendor 独立 Git + 固定基线 commit + `mcode/integration` 分支 + 补丁存
`patches/node-red/` + `.gitignore` 排除 + 只改边界文件。

**关键收益**：能改它的编辑器，把 Mcode 的节点类型、审批标记、执行 owner
直接做进去 —— `WorkflowCanvas.tsx` 才有机会退场。

先派 **T13 调查卡**（不改产品代码），查清构建链、改动面、扩展点、体积代价、
许可证，再决定动不动手。

---

### 已完成的「复用审计」（2026-10-21）

用户问「有没有该抄却自己写的东西」。逐项核对 `open-claude-ui/code-examples/`
（33 个逆向件）与仓库现有实现，结论：

| 项目 | 逆向有 | 我们 | 判定 |
|---|---|---|---|
| 双栏分割拖拽 | `ArtifactsSplitPaneResizer` | 只有两向 dock | **该抄没抄 → T02** |
| 滚动跟随 | `useClaudeScrollPinning` | `LegendList` + turn 折叠悬挂 | 不重复（解决不同问题） |
| 响应式断点 | `ContainerResponsiveBar` 4 档 | 我们 7 档容器查询 | 设计取舍，非重复 |
| 确认弹窗 | `ConfirmationDialog`（要 framer-motion） | 226 行带业务逻辑 | 不重复（仓库无 framer-motion） |
| 按钮 | `CdsButton` | `ui/button.tsx` | 已统一（自建的 CdsButton 已删） |
| 图片灯箱 | `MediaLightboxViewer` | 411 行接真实预览 | 不重复 |
| 动效弹簧 | 4 个 spring 预设 | `linear()` 采样 | 不重复（纯 CSS） |

**顺手修掉一个真实死代码**：`--spring-btn` 定义完整但全仓零调用，已删除并把
断言翻成反向（`9d968d70`）。

**仍未复用的**：`DraggableSessionList`（会话拖放）、`CoworkAgentCanvas`（画布）、
`StreamingDiffViewer`、`ModelSwitcherWithTokenGauge` —— 这些是**我们还没有对应功能**，
不是重复。要做时应当直接抄，不要从零写。

---

### 已知未修（如实留档）

- ~~`maint-m35-smoke` **7/8**~~ **已由总控修复**：产品代码本身是对的
  （`await` + `!res.ok` + toast），是断言只认 `.then(` 写法、把 `await` 误判成没接。
  断言已改为「`await` 或 `.then(` 任一」，变异能准确变红；现 8/8。
- ~~`updater-tools-smoke` 构建期就断~~ **T26 已修**（`f98df6ff`）：桩补齐
  `accessSync`/`constants`/`lstatSync`，现 136/136。总控独立复跑确认。
- ~~`maint-m22-smoke` 15/16~~ **T26 已修**（`f98df6ff`）：判定是**断言 bug 不是产品 bug** ——
  搜索框里的 Space 本来就应该留给多词搜索，原脚手架误当勾选。现 16/16，
  且没有删断言（第 16 条改成判真实行为：搜索框 Space 不误选、编辑器焦点 Space 出「添加」按钮）。
- ~~`maint-m07-smoke` 94/103~~ **T25 已修**（`8f43c24e`）：**9 条红几乎全是脚手架**
  —— 故障注入只拦了 `node:fs/promises`，而 `atomicFile.ts` 用的是 `fs/promises`，
  注入被绕过；MC-024 还注错了点（rename 而非 link）。产品侧 `atomicReplaceFile`
  本来就是 tmp→fsync→rename 正确实现。唯一真实缺陷是 `ipc/files.ts` 冲突副本
  保存失败时没把原因回给调用者 —— 已修成 `{ok:false, conflict:true, error}`
  且不带 `conflictPath`。现 103/103，总控独立复跑 4/4 套件全绿。
- **T52 修复后待复核基线（2026-10-21）**：全量 503 套最初 481 PASS / 22 FAIL（并行开发中的中间快照），对 22 失败逐套复测后有 17 套通过；剩余 `module-ui`、`node-red-theme`、`node-red-e2e`、`skills-nodes-ui`、`vscode-l1` 五套仍有真实断言失败。**`test:all` 仍是红的，不能声称全绿**；具体日志/修复与验收缺口见 `tasks/T52-smoke-rescue.md`。

---

## 已修复的回归（留档）

**T06 曾在 Windows 上把「所有未声明 network 权限的可执行扩展」拒之门外**，
`module-protocol-integrity-smoke` 与 `module-extension-lifecycle-smoke` 双双全红。

**T11 已修复**（`5ac27b05`）：Windows 上不声明 network 的扩展恢复执行、走已有的
`NETWORK_GUARD`；声明 network 的仍然拒绝。总控复核：两套原红现已 `3 pass, 0 fail`。

**T10 附带修好了一个 harness 断链**：`executorOwnership.ts` 新增的落盘实现会拉入
`@main/lib/dataRoot.js` / `logger.js`（都 import electron），而三套既有 smoke 的
`run.sh` 没有 `--banner` 与这两个桩，导致 `executor-ownership`、`executor-owner-identity`、
`flow-migration` 因 `Dynamic require of "child_process"` 全红。总控补了 banner + 桩，
三套现为 17/17、9/9、249/249。

---

## 写任务卡前先查是否已在飞

有过一次真实教训：T03 卡写于 17:37，另一个对话 17:41 才提交同一块工作。写卡时这项工作
已经在跑，结果卡里的新增要求与在飞工作重叠，事后花时间才分清「交付没达标」还是
「我自己加码了」。

之后写任何任务卡**之前**：

1. 跑 `git log --oneline -20` 与 `git status --short`，看这块有没有刚落地或半成品；
2. 向用户确认当前有几个执行对话在跑、各自负责什么；
3. 已经在飞的工作**不要**写成新卡；确需补充时，把卡拆成
   「在飞范围（对方已承诺的）」与「增量要求（我新加的）」两段，分开放；
4. 核对结果时，只按**原派活范围**判定完成与否，新增要求单独记。

---

## 下一步（总控判定，2026-10-21）

**主线是 GenOffice 六 app 全功能接入** —— 用户原话：
「genoffice的要求是基本他的所有功能都保留，只是把助手ai替换掉，用我们项目的ai」

### 已实读源码的关键结论（不再是推测）

GenOffice 自己有一套完整的壳：`genoffice/apps/shell/src/main/`。
它给六个 app 各建一个 `WebContentsView` 塞进主窗口，方式是：

```ts
// shell/src/main/index.ts:507-547 —— 每个 app 一次
configureXxxRuntime({ preloadPath, rendererUrl, rendererFile, openGeneratedPath, createDocument })
// shell/src/main/tab-manager.ts:338-470 —— 每个 app 一个
const view = createXxxView(openPath)
this.shellWindow.contentView.addChildView(view)
```

**六个 app 全部已导出视图工厂**（可逐行核对）：

| app | 工厂函数 |
|---|---|
| docs | `docs-main.ts:6433 createDocsView(openPath)` |
| sheets | `sheets-main.ts:2444 createSheetsView({includeAiHandlers, openingWorkbook})` |
| slides | `slides-main.ts:5051 createSlidesView(openPath)` |
| pdf | `pdf-main.ts:2042 createPdfView(openPath)` |
| markdown | `markdown-main.ts:1327 createMarkdownView(openPath)` |
| html | `html-main.ts:1941 createHtmlView(openPath)` |

**Mcode 的 `DocumentViewHost` 已经具备所需全部能力**
（`contentView.addChildView` / `setBounds` / 保活 / 焦点 / 崩溃诊断）。
它缺的只有「谁来造这个 view」。

**AI 的真相**：
- `ai:stream` 只在 docs（`docs-main.ts:4084`）和 slides（`ai-ipc.ts:172`）里注册过；
  pdf / markdown / html 的主进程**根本没有 AI 实现**。
- 但六个 app 的渲染端 `ai/transport.ts` 完全同形（各 18 行），
  都在调同一个通道。
- 原厂壳自己也是 `registerAiIpc()`（docs 的那份）一份供全六 app 使用
  （`shell/src/main/index.ts:6625`）。

→ **「把 AI 换成我们的」= 提供一份 `ai:stream`/`ai:stream-chunk`/`ai:stream-cancel`
实现，挂到 Mcode 的 session 上。六个 app 共用一份。**
docs 已有可抄的：`genoffice/apps/docs/src/main/mcode-ai.ts`（206 行）。

### 六条线现状

| app | 宿主对端 | 卡 |
|---|---|---|
| docs | ✅ 完整（T05a/b/c + T22） | 无 |
| pdf | ❌ 未接（主进程 AI 也没实现） | **T28** |
| markdown | ❌ 未接（同上） | **T28** |
| html | ❌ 未接（同上） | **T28** |
| sheets | ❌ 未接（`createSheetsView` 一直可用） | **T29** |
| slides | ⚠️ 自搓了 3 个操作（原厂 155 条已在 `createSlidesView` 里） | **T29** |

### 可派顺序（**2026-10-21 16:20 更新**）

**已完成**：T01–T08、T10–T23、T24–T28、T42、T47、T48、T52、T55、T56
**接线完成待验**：T29（`dc974b2c`）→ 验收补齐见 **T53**
**在飞**：无（全量 smoke 正在复跑）

**当前可派（五张，互不冲突）**：

| 卡 | 文件 | 改哪 |
|---|---|---|
| **T53** T29 续篇（真实 sidecar 验 xlsx/pptx） | `T53-genoffice-sheet-slide-verification.md` | `scripts/genoffice-native-view-smoke/` |
| **T49** 扩展调用面 | `T49-extension-api-surface.md` | `main/modules/` |
| **T51** 让 AI 写扩展 | `T51-ai-writes-extensions.md` | `main/appControl/` |
| **T45** 删手写画布 | `T45-workflow-canvas-to-node-red.md` | `renderer/components/settings/workflows/` |
| **T50** 扩展 UI 贡献点 | `T50-extension-ui-contributions.md` | `contracts/modules.ts` + 渲染端（T24 已完成，不再冲突） |

**等前置**：T54 等 T53、T46 等 T45、T44 先核 T42 已做到哪。

### xlsx sidecar 已就位（T53 的前置）

总控从上游 `v0.11.0` 安装包提取，**没有装 Rust、没有编译**：

| 项 | 值 |
|---|---|
| 来源 | `GenOfficeSetup-v0.11.0-x64.exe` → 包内 `resources/native/xlsx-sidecar.exe` |
| 落点 | `genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe` |
| SHA-256 | `9e455b569179359d3b85768bac2619cb2628caf1ef1f44771b3652ef738925a5` |
| 大小 | 8,890,488 字节 |
| 实测 | 打开真实 `blank.xlsx` 返回 `ok:true`，解析出 Sheet1 |

版本 `v0.11.0` 与基线 `apps/shell` 的 `0.11.0` 一致 —— **不要换成更新或更老的 release**，
sidecar 有协议版本号会直接拒绝。完整来源与复现方法见同目录 `PROVENANCE.md`。

### T07 留下的三条未验（不在 T28/T29 范围内，如实留档）

- 真 Node-RED 编辑器里输入并拖动一条**未部署**的 flow，然后换 pane —— 没做。
  回写只验证了原生 `WebContentsView` 的反导航机制等价物。
- 带 document/flow 内容的**整窗退出重启后重开真编辑器** —— 没做。
- 圆角/裁剪是否被原生 OS 子视图盖住 —— 未逐像素截图，不能判定。

---

## 旧：T25/T26/T07 那轮的推荐（已被上面的主线取代）

---

## 推荐起手顺序（第一波，历史留档）

同时派几个都行，只要文件边界不重叠。第一波建议派这三个 —— 它们互不冲突：

| 顺序 | 任务 | 理由 |
|---|---|---|
| 1 | **T01 视觉基线** | 纯新增测试脚手架，不改产品代码，风险最低（已在进行） |
| 2 | **T06 MC-035 网络隔离** | 独立主进程领域，与 UI 不冲突；是安全债（已在进行） |
| 3 | **T10 owner 落盘** 或 **T08 三引擎对照** | 都可与其他线并行，文件边界干净 |

第二波（等第一波有回写后）：T02 → T03 → T04。
T05 与 T07 视 T02/T05 的完成情况再排。

---

## 铁律（每个任务文件里都会重复一遍）

1. **台账规则优先**：动任何结论前先读 `audit-ledgers/README.md`。
2. **不虚报**：跳过就说跳过，失败就说失败，附原始输出。
3. **不碰别人的文件**：任务文件里写死了边界；边界外的东西只读不写。
4. **变异验证**：新增断言必须先撤掉修复看它变红，再逐字节还原（`cmp`）。
5. **临时脚本写文件**，不写内联一行命令（PowerShell 转义 + 中文路径必炸）。
6. **只提交不推送**。
7. **完成后必须回写**任务文件的「结果回写区」，否则视为未完成。
