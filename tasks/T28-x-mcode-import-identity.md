# T28｜经编辑器 Import 进画布的图丢失 `x-mcode` 身份，Mcode 节点包未声明 defaults

- Status: done（2026-10-23 验收通过：73/73，提交 7ba94777）
- Category: **bug（P0 功能不可用）**
- Priority: **P0**
- Depends on: T8（`d58a0b1e`，发现这个缺陷）
- Exclusive writable files: Mcode 节点包的定义文件（`workflowEngines/` 下 node pack 相关）、新建回归套件。**开工前先确认精确路径**，写进回写区。

## Required Skills
- `research`: 需要读 Node-RED 上游的 `_def.defaults` 导出规则，确认正确的声明方式。
- `mcode-smoke`: 建回归，并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T8-node-red-electron-u1.md`（缺陷 2 的原话）、`docs/planning/node-red-vendor-integration-map.md`、`apps/desktop/src/main/workflowEngines/` 下的 node pack 与 `nodeTypes.ts`。

## T8 实测出的缺陷（原话）

> **P0**：经编辑器 Import 进入画布的图**丢失全部 `x-mcode` 身份**（上游只导出 `_def.defaults`，Mcode 节点包未声明）——「用户在原生编辑器手工导入 Mcode 图」这条路径结构性不可用。

## 背景

Node-RED 的节点在 `runtime.nodes.registerType(name, { defaults: {...} })` 里声明哪些字段属于该节点。**导出/导入时只序列化 `defaults` 里声明过的字段。**

Mcode 的节点在 tab 上挂了 `x-mcode: { docId, ... }` 这种元数据，**但这些字段没有在节点包的 `defaults` 里声明**，所以：

- **导出**（用户点「导出」拿到 JSON）→ `x-mcode` 被丢掉
- **导入**（用户把这份 JSON 导回来）→ 图还在，但 Mcode 不知道它对应库里哪份文档

**后果**：「手工导入 Mcode 图」这条路走不通——导进去的图是「孤儿」，无法关联回库。

## 目标

让 `x-mcode` 在导出/导入往返中保留。

### 必须做的事

**第一步：确认现状。**

1. 找到 Mcode 的节点包定义（`registerType` 的调用点）
2. 看 `defaults` 里声明了什么
3. 确认 `x-mcode` 现在挂在哪（tab 节点？）

**第二步：理解 Node-RED 上游规则。**

读 `node-red/` 上游源码，确认：
- `defaults` 里怎么声明一个对象字段
- 导出时哪些字段会被保留
- 有没有「自定义字段」的官方机制（不要 hack）

**第三步：实施。**

在节点包的 `defaults` 里声明 `x-mcode`，让它在导出/导入中保留。

**注意**：`x-mcode` 是挂在 `tab` 节点上的，而 tab 类型由 Node-RED 上游定义。**要确认能不能给 tab 加 defaults**，不能的话需要别的方案。

**第四步：验证往返。**

```
建一个含 x-mcode 的图 → 导出 JSON → 确认 x-mcode 在
→ 清空画布 → 导入那份 JSON → 确认 x-mcode 还在 → 确认能关联回库文档
```

**第五步：变异验证。**

把 `defaults` 里的声明去掉 → 往返断言必须变红 → 逐字节还原（`cmp`）。

## 边界

- **不改** Node-RED 上游源码（`node-red/`）。
- **不改** `patches/`。
- **不改** T2/T3/T4/T21/T27 的文件。
- 若发现必须改上游才能做到，**停下报告**，说明为什么，另开方案。
- **不宣称 ARC-006 完成**。

## 验收判据

1. 回写区给出：Mcode 节点包的 `registerType` 位置、`defaults` 现状、`x-mcode` 挂在哪。
2. 导出 JSON 里**含** `x-mcode`。
3. 导入后**仍含** `x-mcode`，且能关联回原库文档。
4. 往返前后 `docId` 一致。
5. 变异验证：撤掉 `defaults` 声明 → 断言变红 → `cmp` 还原。
6. 双包 typecheck 通过。
7. 既有 Node-RED 相关套件不回归。

## 结果回写（2026-10-23）

### 现状调查（判据 1）

- **`registerType` 位置**：Mcode 节点包有两条生成路径。
  - `apps/desktop/src/main/workflowEngines/mcodeNodePack.ts` 的 `agentNodeHtml()`（`mcode-agent`，默认值 `instruction`/`capability`/`outputVar`/`sessionId` 等）。
  - `apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts` 的 `htmlFor()`（其余五类 `mcode-conversation`/`mcode-branch`/`mcode-trigger`/`mcode-module-capability`/`mcode-node-red-call`）。
  - 两者由 `nodePackManifest.ts` 的 `expectedNodePackFiles()` 落成 `<userDir>/nodes` 下的六份 `.html`。
- **`defaults` 现状**：改动前六类的 `defaults` 只有各自的表单字段，**没有** `x-mcode`；内置类型（tab/inject/watch/switch/exec/function）的 `defaults` 由 editor-client 拥有，我们的节点包无从声明。
- **`x-mcode` 挂在哪（两处，纠正前一位执行者/任务书的「挂在 tab 上」说法）**：
  1. **tab 上**（`flowMigration.ts:1043`，`(tab as Record<string, unknown>)["x-mcode"] = structuredClone(docMeta)`）——**文档级**身份：`docId`、名称、engine、trigger、schema、`builtin`、`updatedAt` 等。用途是让一份 flow 被读回时能识别「这是库里哪份文档」。真引擎 `GET /flows` 没有 flow 级对象，tab 是唯一能活过往返的容器。
  2. **每个节点上**（`flowMigration.ts:824` 的 `nrNode["x-mcode"] = {...}`）——**节点级**身份：`nodeId`、`nativeId`、`type`/`nativeType`、`title`、`params`、`capability`、`position`、`unknown`、`edgeMeta`。用途是让每个原生节点都能映射回 Mcode 库节点 id（反向适配器 `flowToWorkflowDoc` 用它还原节点 id、参数与边注释；缺了它，节点身份会漂移成原生 id）。
  - 「两处」都有独立断言：B1/B2 对 tab 与六个节点逐字段相等；C 负控对 tab 与六类节点逐一确认丢失。

### 上游规则（实码取证，node-red 5.0.8）

- `@node-red/editor-client/src/js/nodes.js`：
  - `convertWorkspace(n)`（约 1253–1289 行）与 `convertNode(n)`（约 1293–1345 行）都只 `for (var d in n._def.defaults) node[d] = n[d]`。
  - `importNodes`（1920 行起）对 tab 走 `addWorkspace`（1023 行，`ws._def = RED.nodes.getType('tab')`），对普通节点按 `node._def.defaults` 逐个 `node[d] = n[d]`（约 2610–2625 行）；`applyNodeDefaults` 默认 **false**，只有显式开启时才在 `n[d] === undefined` 时填默认值。
  - 内置 tab 定义：`nodeDefinitions['tab'] = { defaults: { label, disabled, locked, info, env } }`（109 行）。
  - `registerNodeType`（约 232–310 行）对不在任何 node set 里的类型直接 `RED.notify(palette.event.unknownNodeRegistered)` 并 **return（丢弃整个定义）**；只在注册成功时 `emit("registry:node-type-added", nt)`（303 行）。
- 结论：声明 `x-mcode` 是唯一让导出/导入保留它的官方路径；tab 无法 `registerType`，只能**就地给内置定义对象的 defaults 加键**（节点 HTML 与页面脚本同走 `red.js` 的 `appendConfig`，节点包脚本在 flows 导入之前执行）。

### 实现方案与取舍

1. `mcodeNodePack.ts` 新增 `tabMetaDefaultsScript()`：一段随每份节点 HTML 执行的脚本，给 `MCODE_PATCHED_NATIVE_TYPES = ["tab","inject","watch","switch","exec","function"]` 的 `_def.defaults` 加 `"x-mcode": { value: undefined }`。已注册 → 当场补；未注册 → 挂 `registry:node-type-added`，注册时补（编辑器在全部节点集加载完才导入 flows，两种顺序都赶在导入前）。
   - **fail-closed**：`tab` 定义缺失 / `defaults` 不是对象 / 补后读不到 `x-mcode` → `console.error` + `throw`（页面上是一次显式失败，不是「导出的 JSON 看起来正常、身份悄悄没了」）。
   - `RED.events.on` 不存在而仍有未注册类型时，记一条响亮 `console.error`（不抛：某些精简编辑器可能不装核心节点集，那不是身份丢失）。
   - 刻意不用 `registerType("tab", …)`：上游会拒绝并丢定义（实测 `palette.event.unknownNodeRegistered`）。
2. 六类节点（`agentNodeHtml` + `htmlFor`）的 `defaults` 都声明 `MCODE_X_MCODE_DEFAULT_ENTRY`。`value: undefined` 是刻意的：拖新节点不凭空带 `x-mcode`，导入时上游会把 JSON 同名键原样抄进来。
3. `nodePackManifest.ts` 的安装版本号 **2 → 3**（编辑器资产变了，旧数据目录必须重写；T42 的清单带版本号）。`t42-node-pack-smoke` 改为断言常量本身，不写死数字。
4. `nodePackBundle.generated.ts` 由 `build/build-node-pack.cjs` 重新生成，逐字节确定性（两次生成 SHA-256 相同）。

### 半成品评估（承接 `0b5a4f57`）

- **可用**：`tabMetaDefaultsScript` 的机制与 fail-closed 设计、六类 defaults 声明、`upstreamEditor.ts` 的 vm 装载与真上游 `createCompleteNodeSet`/`import` 往返、md5 级别的 A/B/C/D 分区结构、`nodePackManifest.ts` 版本号提升的意图。
- **重做/补齐**：
  - 套件**没有退出码**（`process.exitCode = 1`）—— 断言变红时套件仍以 0 退出，全量跑会报 PASS（假绿）。已补。
  - 缺**运行时 fail-closed 断言**（原只有对脚本文本的 regex 检查）→ 新增 A2 段（桩 RED 执行脚本，正面「补丁生效时 defaults 里确实有 x-mcode」+ 三条失效路径必须抛错 + 晚注册事件路径）。
  - 负控 `stripDeclarations` 只对 `mcode-agent` 生效（它后面还有键、带逗号；其余五类 `x-mcode` 是最后一个键，只剥带逗号写法会漏）→ 已改为按条目本身剥并断言六份都真的剥干净。
  - 夹具只覆盖 tab + `inject`；补丁实际覆盖 tab/inject/watch/switch/exec/function → 夹具扩成 `manual`/`file`/`condition`/`code(node)`/`command` 五个节点，落点断言为 `["exec","function","inject","mcode-agent","switch","tab","watch"]`。
  - 核心节点定义原是手抄的最小桩 → 改为在 vm 里执行**真上游核心节点 HTML**（`@node-red/nodes/core/*.html`），`deferTypes` 时序可切换（before/after），验证 `registry:node-type-added` 真事件路径。
  - 安装版本号 `2 → 3` 的未提交改动（`nodePackManifest.ts`、`nodePackBundle.generated.ts`、`t42` 断言）是前一位执行者留下的版本提升工作，已纳入本次提交并加断言。

### 往返证据（判据 2/3/4）

套件 `apps/desktop/scripts/x-mcode-roundtrip-smoke/`（73/73 通过）在真上游 `nodes.js` + 真核心节点 HTML 上验证：

- **B1 导出**：tab 上 `x-mcode.docId === "wf_t28_roundtrip"`；六个迁移落点（`n_t28_trigger`→inject、`n_t28_watch`→watch、`n_t28_agent`→mcode-agent、`n_t28_cond`→switch、`n_t28_fn`→function、`n_t28_exec`→exec）的 `x-mcode` 均**逐字段等于**迁移器写入值。
- **B1b 顺序无关**：核心类型先于节点包注册（立即补）与晚注册（事件补）两条路径导出逐字段一致。
- **B2 导入**：新建编辑器（清空画布）导入导出的 JSON 后，tab 与六个节点的 `x-mcode` 全部还在且逐字段一致；二次导出与首次导出在 `x-mcode` 上深相等（往返稳定）。
- **B3 关联回库**：`flowToWorkflowDoc`（Mcode 真实反向适配器）恢复出的文档 `id === "wf_t28_roundtrip"`，节点 id 集合与库文档一致，`engine === "node-red"`。
- **补丁生效的直接判据**：B1/B1b 均断言真上游 `getType("tab").defaults` 里确实有 `x-mcode`，五个内置类型同样。

### 变异证据（判据 5）

1. **撤掉 defaults 声明**：把 `MCODE_X_MCODE_DEFAULT_ENTRY` 的键名改成 `"x-mcode-disabled"` → 套件变红：`B1 导出含 n_t28_agent 的 x-mcode（逐字段相等）` 与 `B3 往返后恢复的 Mcode 节点 id 与库文档一致`（恢复成原生 id `n_n_t28_agent`）。还原后 `cmp` 逐字节一致（SHA-256 `82b2533…`），套件回绿 73/73。
2. **使补丁空转**（`def.defaults[PROP] = …` 改成 `void 0`）→ 套件变红：A2 四条（`全类型已注册时补丁不抛错`、`补丁生效时 tab.defaults 里确实有 x-mcode`、`对已注册的内置节点类型同样生效`、`晚注册的类型在 registry:node-type-added 之后被补上`）。还原后 `cmp` 逐字节一致。
3. **退出码本身也验证了**：在打包产物上强制 `if (true)` 走失败分支，进程以 1 退出（不是「跑绿了但红了也报绿」）。

### 上游升级鲁棒性论证

- 若 Node-RED 改内置 tab 定义的**形状**（`getType("tab")` 不存在、`defaults` 不是对象、或 defaults 变冻结对象导致编辑不生效）→ 补丁**当场 `console.error` + `throw`**，不是静默失效；B 段用真上游源码在 vm 里跑，形状一变那条回归先红。
- 若上游把 `registry:node-type-added` 去掉 → 晚注册类型补不上；补丁改为记 `console.error`（非 tab 类型不抛，避免精简编辑器误伤），A2 的「晚注册事件路径」断言会红。
- 若上游改 `convertWorkspace`/`convertNode` 的导出规则（不再只抄 defaults）→ 往返断言与 C 负控同时会暴露（负控预期丢身份，如果不是按 defaults 判，C 也会红）。
- 若上游把内置 tab 定义改为可 `registerType` → 现有就地补仍然有效（补丁逻辑不依赖注册方式），但「为什么不能 registerType」的注释需更新；不影响正确性。

### 验证

- `x-mcode-roundtrip-smoke`：73/73。
- 回归：`t42-node-pack-smoke` 19/19、`mcode-node-pack-smoke` 390/390（含真 Node-RED 引擎重启后六节点仍加载）、`mcode-node-close-race-smoke` 86/86、`flow-migration-smoke` 249/249、`flow-migration-identity-smoke` 21/21、`flow-native-param-smoke` 28/28、`flow-snapshot-isolation-smoke` 14/14、`flow-editor-authority-smoke` 9/9、`flow-backup-boundary-smoke` 18/18、`node-red-deploy-reconciliation-smoke` 75/75、`node-red-e2e-smoke` PASS、`workflow-engine-selection-smoke` 16/16、`t85-workflow-migration-preflight-smoke` 34/34、`t21-orphaned-adapters-wired-smoke` 33/33、`t27-load-entry-deadlock-smoke` 40/40、`executor-gate-d-smoke` 85/85。
- 双包 typecheck：`apps/desktop` 与 `packages/contracts` 均 0 错误（判据 6）。
- **提交 SHA**：`7ba94777`（基于 `0b5a4f57` 半成品）。

### 未覆盖项

- **真 Electron 手势级往返**（用户点 Export → 清空 → Import）仍是 T8 的 U1 旅程；本套件只到「真上游 editor-client 序列化函数 + 真核心节点 HTML」这一层。
- **真引擎 `GET /flows` 读回**：`mcode-node-pack-smoke` 覆盖了引擎重启加载，但「原生编辑器导出→引擎导入→读回」的完整链路未在本套件中重跑，留给 `node-red-e2e-smoke`/U1。
- **外部手写 flow**（没有 `x-mcode`）仍按 `flowToWorkflowDoc` 的尽力而为语义处理，不是本卡目标。
- **不宣称 ARC-006 完成**。

