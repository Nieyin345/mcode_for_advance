# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

Mcode：本地优先的通用 Agent 桌面客户端（Electron + React 19 + TypeScript），pnpm + turbo monorepo（`apps/desktop` + `packages/contracts`）。它不自己实现 Agent 能力，而是把三家引擎（Claude Code SDK / Pi / Codex）接进来，上面提供工作流编排、自动化触发器、资料库、插件系统。

**目标用户是技术型个人用户与小团队，不是某个垂直领域。** 场景能力（科研、写作、法律、金融……）全部通过扩展、工作流、自动化组合出来，不许硬编码进宿主；科研数据分析/报告生成只是端到端验收用例。扩展是长期主线，近期四条线是 UI 工作台 / GenOffice 六编辑器 / Node-RED 工作流 / 共享底层能力。产品决策以 `docs/planning/mcode-product-roadmap.md` 为准（Grilling Q1–Q51 恢复稿见 `.scratch/mcode-product-roadmap/`）。

三份更深的文档，改代码前值得翻：

- **`AGENTS.md`**（导航版）—— 权威文档索引、仍然有效的关键提醒、产品方向摘要。系统细节（进程架构、SDK 消息适配、rewind/文件快照、编辑器驻留、组件与图标规范、Codex 协议硬事实、浏览器工具等）全文在 `docs/archive/AGENTS-2026-10-19-full.md`，需要时查；那份的「当前进度」表已过期，不是当前方向来源。
- **`docs/planning/mcode-product-roadmap.md`** —— 用户确认的产品路线：产品定义、四条主线、任务/验收/执行环境规则。
- **`docs/testing.md`** —— 测试入口、日志与 CI 策略。同目录下还有 `优化方向.md`（优化指导 + 进度台账）、`前端待办.md`。历史任务书 `Status-and-Plan.md` 已归档到 `docs/archive/Status-and-Plan-2026-09-18.md`，只作追溯。

## 常用命令

```bash
pnpm dev          # 启动开发（turbo，HMR）
pnpm build        # 构建
pnpm typecheck    # 双包 tsc
pnpm test         # 关键回归（真实执行，无 Turbo 测试缓存）
pnpm test:all     # 全量 smoke（动态发现）
```

快速单包类型检查（不等 turbo）：

```bash
npx tsc --noEmit -p apps/desktop/tsconfig.json
npx tsc --noEmit -p packages/contracts/tsconfig.json
```

### 验证（做完一件事的标准）

```bash
pnpm test:all                               # 全量，0 失败是基线（动态发现套件）

# 改一处小东西时**别跑全量** —— 先问哪几套覆盖它：
bash apps/desktop/scripts/smokes-for.sh src/main/<改动的文件>.ts
```

跑单套：

```bash
bash apps/desktop/scripts/<name>-smoke/run.sh
# 例：pnpm test:smoke scheduler-smoke
# Windows 用上面的 pnpm 命令，自动寻找 Git Bash，避免 PATH 中的 WSL bash.exe
```

很多主进程套件走「esbuild 打包 + stubs 换桩」的无头模式——验证主进程逻辑不需要起 Electron。渲染端组件可用 `.tmp/` 下现成的预览台（`ask-preview` / `retry-preview` / `card-preview`）在真浏览器里核对。

**两样都干净才算完：全量 smoke + 双包 typecheck。** 入口、日志和 CI 策略见 `docs/testing.md`。

`pnpm lint` 尚无包级 lint 实现，不能当作有效门禁；本轮只接入真实测试。

⚠️ **别把「跑绿了」当成「验过了」。** 新写的断言要先撤掉修复、看它真的红，再装回去。
这个仓库里已经有过两次「测试绿着而问题还在」：一次是断言测的是**别人的职责**，
一次是套件跑绿但**根本没覆盖到**被改的文件（`smokes-for.sh` 就是为它写的）。

## 架构大图

```
渲染端 (renderer, contextIsolation, 无 nodeIntegration)
   ↕ 唯一桥:window.api
preload (contextBridge + zod 校验)
   ↕ IPC
主进程 (Node.js): 33 个模块目录
   orchestration/ library/ memory/ mobile/ plugins/ browser/ lsp/ terminal/ relay/ …
```

看懂这几条才动得了手：

1. **契约先行**。IPC 方法（`RpcMap` 446 个）的 schema 定义在 `packages/contracts/src/ipc/`（按域拆 32 个模块，索引是 `rpcMap.ts`）→ preload 白名单 → 主进程 handler。加一条 IPC 要走全三层，缺一层调用端就看不到。
2. **AgentProvider 抽象**。每家引擎一个 Provider + 一个 MessageAdapter，把各家事件归一成 provider 中立的 `RuntimeEvent`。行为对齐（预算、回退、结构化输出、子代理、elicitation）在各 Provider 里做。第四个 provider 是网页模型（浏览器扩展桥驱动真实网页 LLM 页面）。**SDK 不锁死版本**：升级要过兼容矩阵与回归，不许静默切换引擎。
3. **工作流编排**。图模型 + 调度器（就绪即派发、并发上限默认 4）+ **10 个**内置节点类型（`nodeTypes.ts:612` 的 `BUILTIN_NODE_TYPES`）。执行分派只有一个入口：`manifest.runner.kind` 查注册表，没有就落兜底（模型轮；`module-capability` 例外——缺执行器时 fail-closed）。插件可注册自己的节点类型。关键区分：**子 agent 节点跑在隐藏子会话；主代理（`mcode.main`）与对话节点跑在主对话里**，用户看得见。
   **方向注意**：产品路线已定 Node-RED 为唯一工作流/自动化内核（原生画布 + runtime + registry + nodes），上述自有图模型是迁移期现状，不是目标终态。迁移期内**禁止长期保留两套执行器或双触发**，见 `docs/planning/node-red-vendor-integration-map.md`。
4. **sql.js 持久化**（纯 WASM SQLite，**没有 FTS5**，全文检索走 ripgrep）。统一数据根。
5. **i18n**：zh/en 双词典在 `lib/i18n/{zh,en}/`，**zh 是 `MessageId` 类型的源**——缺 key 直接 typecheck 失败。用户可见的字符串不许硬编码。

## 硬规矩（来自产品路线与历史任务书，实测救过场）

1. **先补测试，再动刀**。大重构前给要改的路径写断言。
2. **共享实现只有一份**。「用户点的」和「AI 调的」必须走同一个函数。
3. **坏东西显式报出来，不静默跳过。**
4. **重构用 AST 定边界，不手抄代码**——这个仓库注释密度很高，手抄必改坏。
5. **临时脚本先写文件再执行**（`.scholar_tmp/` 或 `.tmp/`），不写内联一行命令（PowerShell 多层转义 + 中文路径必炸）。
6. **git 取消暂存用 `git restore --staged`**，永远不要 `git checkout HEAD -- <文件>`（后者连工作区一起覆盖）。
7. **渲染端新代码读数据一律走 `useRpc`**（`src/renderer/hooks/useRpc.ts`），不许再手写
   `await api.*` + 自己的 loading/catch —— 429 处散装调用就是这么攒出来的。写操作（mutation）
   仍在事件处理器里显式 `await api.*`。老代码不强迁：动到哪个面板，顺手迁哪个面板。
   界面的空状态 / 错误提示 / 加载态 / 表单行 / 状态徽标，先看 `components/ui/` 的
   `EmptyState` / `ErrorNote` / `Spinner` / `Skeleton` / `Field` / `Badge`，没有再造。
8. **执行完成 ≠ 验收通过**。任务由验收证据决定是否完成；失败就返修、重验或请求用户介入，
   不许拿「报告已写」「测试跑绿」冒充产品通过。E1/headless 不等于真实 Electron U1。
9. **AI 可配置但不可自授权**。AI 能发现、提议、生成、配置能力；需要授权的操作仍由用户批准，
   未知或损坏状态 fail-closed。「AI 能控制功能」不等于「能绕过权限」。
10. **执行环境由用户选，AI 不调度**。项目可记住默认环境、单任务可覆盖；环境不可用就明确报错，
    不自动切换到别的环境。

## 环境事实（踩过的坑）

- **sql.js 的 `db.export()` 会重置连接上的 pragma（含外键）**——导出只有 `exportBytes()` 一个出口，新增导出点必须走它，否则 `ON DELETE CASCADE` 静默失效。
- 主进程里**没有 cookie 的 HTTP 请求做不到**（要走内嵌浏览器那条路）。
- **子代理返回空 ≠ 失败。** 曾经这里写着「API 并发上限 1，绝对不要开子代理 / 并行工具调用」，那是**读错了**：几次子代理立刻返回空被当成"被掐掉"，而同一批里有三个是过了 **20～40 分钟**才带着完整报告回来的 —— 空只是"还没干完"。用户说的实际上限是 **30**。真正要守的是**派活按文件切、不按问题切**（每个代理只给"改哪个文件的哪个函数、改成什么样、别碰别的"），并且**别让两个代理改同一个文件** —— 那才是并行会咬人的地方。
- 手机端（`AppMobile.tsx` + `webApi.ts`）是**独立组件树**，走无 preload 的 HTTP 桥。共用组件里每加一个 RPC 都要在 `webApi.ts` 补一项，漏了会同步抛错、React 19 整棵卸载。
- preload 不热更：改 preload 后「新命名空间 = undefined」说明没真正重启 dev，不是写错了。
- Windows 子进程输出是控制台代码页（中文机器 GBK）：解码先严格试 UTF-8、失败退回 GBK，用原始字节，别数替换字符。
- **无头验证数据时，`dataRoot` 必须指向 `mcode.db` 的副本**——sql.js 重写整个文件，指向真库会毁数据。

### 多会话并行时的两条硬约束（2026-10-23，都是真实事故后加的）

**一、提交必须带路径。**

```bash
git add <明确路径1> <明确路径2>
git commit -m "<信息>" -- <明确路径1> <明确路径2>
```

`git commit` **后面必须跟 `-- <paths>`**。**禁止 `git commit -a` / `git add -A` / `git add .` / 不带路径的 `git commit`。**

⚠️ **`-m` 必须放在 `--` 前面。** `git commit -- a.ts -m "x"` 会报 `pathspec '-m' did not match any file(s)`——`--` 之后的一切都被当成路径。正确顺序是 `git commit -m "x" -- a.ts`。

⚠️ **改共享索引（`tasks/README.md`、`tasks/README.md` 类）前先 `git status`，只追加，提交后核对 `numstat`。**

事故：A 加一行索引行时整份读改写，把另一个会话当时**未提交**的状态列工作一起提交了（48 行新增里只有 1 行是它的）。没造成丢失（逐行核对过是完整合并态），但**提交归属错了**，事后没人能从提交信息看出发生了什么。

**核对方法**：`git show --numstat HEAD` 看一眼，如果 `tasks/README.md` 的 `+` 远多于你实际写的行数，说明卷进了别人的改动。

事故：总控 `git add` 两张卡后执行不带路径的 `git commit`，把另一个会话在途的 438 行代码卷进了 doc 提交。暂存区是进程间共享的，你 `add` 完之后别人也可能 `add`，不带路径的 `commit` 会把他的一起交掉。

**二、改文件时保持可编译。**

加 JSX 标签就同时加闭合，拆 JSX 就一次拆完。**不要让文件在磁盘上处于语法错误状态超过几分钟。**

事故两次：一个会话写 `i18n/ide.ts` 字符串未闭合，另一个会话的 30 次采样全部 `Unterminated string literal` 白跑；另一个会话写 `RightPanel.tsx` JSX 未闭合，两个会话的 `tsc` 门禁红着在等。

**预计要 10 分钟以上才能改到可编译**时，先 `git stash`，或把新组件单独写成文件最后一次性接入。

**跑测试前的标准前置：**

```bash
git status --porcelain
npx tsc --noEmit -p apps/desktop/tsconfig.json      # exit=0 才继续
```

**打包期失败（`X [ERROR]` / `Unterminated string literal` / `No matching export`）不等于被测对象失败。** 这个仓库为这件事栽过两次，2026-10-23 是第三次。

**三、交付完成必须主动回报，不要等总控来问。**

并行执行时总控同时盯 3～4 个会话，靠 `git log` 猜谁做完了不可靠，而且会漏掉「做完了但有疑问」的情况。

**每张卡交付后立刻 `SendMessage` 给 `总控`**，至少包含：

1. 提交 SHA；
2. 套件结果（多少条、全绿还是红）；
3. 回写区在哪张卡的哪一节；
4. **有没有未做的事、有没有你觉得不对但没改的地方。**

**「做完了」不是回报的时机，「做完并且说清楚」才是。** 没回报的交付，在总控眼里等于没做——它不会去翻 `git log` 确认每个人。

## 产品主线与复用来源

**最终效果 = Claude 桌面端的 UI；其余能力一律优先复用上游源码做二开，不从零写。** 遇到「要不要自己实现」时，先按 L1→L4 找证据：

| 线 | 复用什么（仓库内已有） | 许可 |
|---|---|---|
| UI 工作台 | `open-claude-ui/` Claude 桌面端逆向成果（CDS token 由 `gen-cds-tokens.mjs` 提取） | MIT |
| 文档 | `genoffice/` 六原生编辑器（docs/sheets/slides/pdf/markdown/html） | Apache-2.0（`ee/` 企业条款不得拷入） |
| 工作流 | `node-red/` 5.0.8 源码（原生画布 + runtime + registry + nodes） | Apache-2.0 |
| 扩展 | `ModuleHost` + VS Code API 薄映射（`docs/planning/extension-vscode-compat.md`） | 各自审查 |

L1 直接复用 → L2 薄宿主适配 → L3 可审计 fork → L4 最小自有逻辑（L4 必须附「已检索上游仍无对应能力」的源码证据）。三条线共享的硬边界：**不另造 Agent loop**、**不造第二套 Office/工作流/插件运行时**、**不引入默认 YOLO/跳过审批**。

## 执行任务体系

- **正式执行卡**在 `tasks/T<number>-*.md`，索引 `tasks/README.md`；旧卡归档在 `tasks/archive/legacy-2026-10-22/`，编号不复用、状态不作新验收。
- 派活按**独占文件边界**拆，不按问题名称拆：同一文件同一时间只能有一个执行对话负责。开工先声明精确可写文件集，发现重叠即停。
- 每张卡必须有 `## Required Skills`（只列相关的）、独占写入边界、验收判据、旧红→新绿要求、结果回写区。
- **写回即完成**：执行对话把结果追加到卡末尾就算交付；有遗留另开新卡，不做「部分完成」的二次判定。
- 规划票在 `.scratch/<feature-slug>/`（`spec.md` + `map.md` + `issues/`），它不替代 T 卡的执行验收。产品路线恢复稿在 `.scratch/mcode-product-roadmap/`。

### 分工是硬的：卡只能由总控写（2026-10-23 用户当面纠正后加的）

**用户看不下去了才说的**：「为什么 a 对话要写任务卡啊，你是怎么是你分配任务，还还是这些子对话分配任务呀，我都被整糊涂了」

**我之前搞错了，具体错在：**

- 让 A 去改 `tasks/T42-u1-silent-mode.md` —— **那是 E 正在做的卡，A 不该碰**；
- 让 D 去改 `tasks/README.md` —— **索引是总控的职责**，结果 D 卷进了别人未提交的工作；
- 让 D 改 13 张卡的 `Status` —— 本质还是让执行会话做总控的事。

**现在的分工：**

| 角色 | 做 | 不做 |
|---|---|---|
| **总控** | 写卡、派活、验收、维护 `tasks/README.md`、核实前提 | **不写代码** |
| **执行会话** | 做卡上的活、写**自己那张卡**的回写区 | **不写别人的卡、不改索引、不派活** |

**核实工作可以派**（D 的核查表就有价值），**但产出物由总控整合进卡里**。

**判断方法**：如果某件事的产物会让「另一个执行会话读到错误信息」，那它就该由总控做——因为总控对全部卡的一致性负责。

### 写卡前必查三件事（2026-10-23 五张卡被现实推翻后加的）

**这一天里有五张卡的前提是错的，四张靠执行会话回头纠正。** 原因统一：写卡时没核现状。

**一、这个问题还没被修吗？**

```bash
git log --oneline -8 -- <目标文件>      # 看最近有没有相关提交
grep -n "<关键符号>" <目标文件>          # 看代码现在长什么样
```

**实例**：T44 写「`genoffice-source-smoke` 原地篡改真实工作树」，而 T31 四小时前已改成克隆到副本并加了断言。**卡描述的是修复前的代码，白开一张。**

**二、这个符号有几个调用点？**

```bash
grep -rn "<符号名>" apps/desktop/src/ | wc -l
```

**实例**：T40 写「一行修复，注入点 `ipc/index.ts:227`」，实际有**两处**注入（`registerGenofficeViewAiIpc` 和 `setDocsAiPorts`），只包一处等于没修。

**三、验收判据的方法写了吗？**

**「断言打在 X 上」不是判据，是愿望。** 必须写怎么打、参考哪个套件的哪一段。

**实例**：T40 写「断言必须打在装配路径上」，但没写方法，最后是执行会话自己想出「用未包装的 ports 做对照组」。**最难的判断留给了执行者猜。**

**正面样板**（照这个写）：`apps/desktop/scripts/t40-renderer-registry-smoke/main.ts` 的 `★ 对照组:未包装的 ports 中途查不到绑定(病灶复现)` —— **对照组证明断言分得清修没修**。没有对照组的套件，全绿也可能什么都没验（T24 的 59/59 就是）。

**六、任何断言的价值，都不超过它取证方法的正确性。**

D 会话在同一天里先说了「否定断言比肯定断言耐放」，随后自己推翻：

> **这条规律本身有前提**：否定断言只在**搜索范围正确**时才成立。更准确的说法是：**任何断言的价值都不超过它取证方法的正确性。**

**而这条规律也适用于「变异验证」本身**，有一个特别隐蔽的形态（2026-10-23，E 踩到两次）：

变异脚本里写 `assert s.count(old) == 1`，而 `old` 已被更早的一次编辑替换掉，`count == 0` → **脚本在写文件之前就抛 `AssertionError` 退出**。此时**文件根本没被改、被测套件也从没跑起来**，但人会把它误读成「跑过了、证据被吞」。

**两种形态要分清**：一种是「改了但没生效」（跑出 0 条红），另一种是「根本没改、也没跑」（连红都没有）。**判断方法**：变异后先 `git diff <文件>` 看改动在不在，再跑套件；或者脚本里把 `assert` 换成显式 `if count != 1: sys.exit(2)`，让失败可区分。

实例（同一天）：

- 「`electron-u1` 骨架 grep 不到任何套件引用」——搜索范围只写了 `scripts/*/main.*`，而 U1 套件用 `journeys/`、`run.mjs`、`editor-flow.ts`。全目录重搜：**19 处引用、5 套套件**；
- 「`policyFor("framework.list")` 返回 read」——那个名字当时根本不存在，`read` 是兜底逻辑对**任何**未注册名字的答复（`nonexistent.list` 也一样）。**一个从不说不的分类器，它的肯定不是证据**；
- 「T7 六条 6/6 全绿」——那是在 HEAD 的 `show:true` 形态下测的。工作区已被改成 `show:false`，**旧绿不是新形态的证据**。

**所以看到任何断言（自己写的、卡上的、别人报的），先问：它是在什么范围、什么形态下取的证？** 范围变了、形态变了，那份证据就作废了。

**四、交付时改 `Status`。** 2026-10-23 查过：T1–T44 全部还写着 `ready-for-agent`，包括二十多张已交付、有回写的。**字段不维护就等于没有。**

**五、卡上的叙述会过期，而且比状态行更危险。**

状态行是字段，人知道它可能没维护；**而「零调用方」「15 套打包失败」「`grep installConfirm` 零命中」这些叙述读起来是事实陈述，人会直接采信。**

实例（同一天）：

- 卡上写「`genoffice-source-smoke` 原地篡改真实工作树」——T31 四小时前已修；
- 卡上写「15 套 smoke 打包失败」——实测 11 套，另外 4 套早已按 T52 修过；
- 卡上写「609 行与 1631 行的适配器零生产调用方」——T21 已接线，且那两行是**文件**行数不是「悬挂部分」的行数；
- README 写「`grep installConfirm` 零命中」——T18 早已交付。

**所以派活前读卡时，凡遇到事实性断言，都当成「写卡那一刻的判断」，不是现在的事实。** 尤其是数字、行号、「零/没有/从不」这类绝对说法。

## Agent skills

50 个 skill 装在本机 `.claude/skills/`（该目录被 gitignore，不进版本库）。名字、来源、用途、能否由模型自行调用的完整清单在 **`docs/agents/installed-skills.md`**。新建 T 卡时 `## Required Skills` 只从那份清单选。

### Issue tracker

Engineering Skill specs and planning tickets live as local Markdown files under `.scratch/<feature-slug>/`. Use one `spec.md` per feature and one file per ticket under `issues/`. See `docs/agents/issue-tracker.md`.

The authoritative execution ledger is `tasks/README.md`. New execution cards start at `tasks/T0-*.md`; legacy cards are preserved unchanged under `tasks/archive/legacy-2026-10-22/` with an SHA-256 inventory. Do not reuse legacy T numbers or treat archived status as fresh acceptance. Formal MC/ARC/UXG defect and architecture IDs in `audit-ledgers/` remain unchanged. Every new T task card must include a `## Required Skills` section listing only relevant skills and their purpose; do not bulk-add all installed skills or rewrite archived cards.

### Triage labels

Use the five canonical state labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context domain documentation layout: root `GLOSSARY.md` and `docs/adr/`. Read relevant existing documentation before proposing changes. Create or update these documents only when domain terminology or architectural decisions are actually resolved. See `docs/agents/domain.md`.
