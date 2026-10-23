# T40｜`withRendererToolRegistry` 零调用点 —— `document.tool_call` 的渲染端路线在生产里永远走不到

- Status: ready-for-agent
- Category: **bug（P0 功能不可用）**
- Priority: **P0**
- Depends on: T24（`ce2913f8`，交付了工具面）、T0（`6bd8289e`，同轮往返）
- Exclusive writable files: `apps/desktop/src/main/ipc/index.ts`（接线点）、`apps/desktop/src/main/document/documentToolRendererBinding.ts`（若需调整）、新建回归套件。

## Required Skills
- `codebase-design`: 判断该在哪里接线，以及为什么原来漏了。
- `mcode-smoke`: 建回归，并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T24-document-tool-surface-redesign.md`、`tasks/T0-genoffice-native-tool-roundtrip.md`、`apps/desktop/src/main/document/documentToolRendererBinding.ts`、`apps/desktop/src/main/ipc/index.ts`、`apps/desktop/src/main/document/documentToolRuntime.ts`。

## B 会话的静态发现（我已核实）

**`documentToolRendererBinding.ts:58` 导出的 `withRendererToolRegistry`，在整个仓库的产品代码里没有任何调用点。**

```bash
grep -rn "withRendererToolRegistry" apps/desktop/src/ packages/
# → 只有定义那一行
```

而生产代码装的是**未包装**的 ports：

```ts
// apps/desktop/src/main/ipc/index.ts:227
documentViewHost.setDocsAiPorts(docsAiPorts);   // ← 未包装
```

## 后果（E2 推断，需 T30 的真 Electron 验证）

`activeRendererBindingFor(filePath)`（`documentToolRendererBinding.ts:106`）依赖一个 `active` 注册表：

```ts
const list = active.get(keyOf(filePath)) ?? [];
if (list.length === 0) return { ok: false, reason: "该文件当前没有正在运行的受信文档 AI 请求，渲染端工具通道不可用。" };
```

**如果 `withRendererToolRegistry` 没被调用，`active` 永远不会被填。**

于是 `document.tool_call` 走渲染端路线时会**永远得到「没有活跃绑定」**，退回到 CLI 路线（如果该 app 有）或直接失败。

**这正是 T24 交付的能力，而它没接上。**

## 为什么套件没抓到

T24 的套件（59/59）测的是**包装后的** ports——它自己在测试里调了 `withRendererToolRegistry`。

**生产代码装的是未包装的。** 这是「套件测了正确的东西，但产品装配的是另一份」——与 T21「悬挂适配器」同一类。

## 工作顺序

**第一步：确认。**

1. `withRendererToolRegistry` 真的零调用点？
2. `active` 注册表在什么时机被写？只有 `withRendererToolRegistry` 能写吗？
3. 不包装时，`document.tool_call` 的实际行为是什么？（跑一次看看）

**第二步：修。**

在 `ipc/index.ts` 的接线点改成：

```ts
documentViewHost.setDocsAiPorts(withRendererToolRegistry(docsAiPorts));
```

**但要先确认**：
- `docsAiPorts` 是不是唯一的注入点？
- `slidesApi` / `sheetsApi` 有没有同样的包装器，也漏了？
- 包装后会不会改变既有行为（比如 CLI 路线的 fallback）？

**第三步：建回归。**

**关键**：断言必须打在**生产装配路径**上，不是测试自己包装的 ports。

做法建议：用 `fakeIpc` 模式驱动真实的 `ipc/index.ts` 装配，然后断言 `setDocsAiPorts` 收到的是**被包装过的** ports（比如能观察到 registry 被填）。

**第四步：变异验证。**

撤掉包装 → 断言必须变红 → 逐字节还原（`cmp`）。

## 验收判据

1. 回写区确认：零调用点成立、`active` 的写入路径、不包装时的实际行为。
2. 生产接线点已改为包装版本（或论证更好的做法）。
3. **断言打在装配路径上**，不是测试自己的包装。
4. 变异验证：撤掉包装 → 断言变红 → `cmp` 还原。
5. T24 的套件 59/59 不回归。
6. 双包 typecheck 通过。
7. **不得**宣称 T30 完成——那需要真 Electron，且用户要求暂时不要弹窗。

## 边界

- **不改** `documentToolRuntime.ts` 的核心逻辑（T24 交付）。
- **不改** `documentToolSurface.ts`。
- **不碰** `workflowEngines/`、`modules/ModuleHost.ts`、`appControl/policy.ts`。
- 若发现其他「有包装器但没接上」的同类问题，**列出来，逐个说明**。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T40-renderer-tool-registry-unwired.md` 末尾追加 `## 结果回写（2026-10-23）`：确认结果、修法、装配路径断言的做法、变异证据、同类问题清单、提交 SHA。

---

## B 会话的补充核查（2026-10-23，已逐行核实）

### `active` 的 8 处引用，写入路径只有一条

```
L38   const active = new Map(...)          定义
L73-75  active.get / active.set            【唯一写入】withRendererToolRegistry.run() 进入段
L79-82  active.get / delete / set          同一函数 finally 的撤销
L107    active.get                          activeRendererBindingFor（只读）
L124    active.get                          hasActiveRendererBinding（只读）
L144    active.values()                     soleActiveRendererBinding（只读）
L160    active.clear()                      clearRendererToolRegistry（测试专用，注释写明「生产不调用」）
```

**结论：没有第二条写入路径，也没有任何间接入口。**

### 这不是「接错地方」，是「从一开始就没接」

```bash
git log -S "withRendererToolRegistry(" --all
# → 只有 ce2913f8（T24 引入）一个提交，从未有过调用方
```

全仓库 import 这个模块的只有三处，全部是**只读**：
1. `ipc/document.ts:48` → `activeRendererBindingFor`
2. `appControl/tools.ts:1119` → `soleActiveRendererBinding`
3. `documentToolRendererBinding.ts:58` → 定义本身

### 最小修复（B 给的）

```ts
// ipc/index.ts:227
documentViewHost.setDocsAiPorts(withRendererToolRegistry(docsAiPorts));
```

`withRendererToolRegistry` 是纯包装，`run` 的 4 个参数原样转发。

### ⚠️ 但注入点有两处，不是一处（E 在动手时发现，总控核实）

```ts
// ipc/index.ts —— 两处喂的是**同一个登记簿**
const registryWrappedDocsAiPorts = withRendererToolRegistry(docsAiPorts);

// ① vendor 视图 AI 通道（registerGenofficeViewAiIpc 的 ports）
registerGenofficeViewAiIpc(ipcMain, (sender) => {
  const context = documentViewHost.vendorAiContextForSender(sender);
  return context ? { context, ports: registryWrappedDocsAiPorts } : null;
});

// ② 文档视图宿主
documentViewHost.setDocsAiPorts(registryWrappedDocsAiPorts);
```

**只包一处的话，另一条路上的 AI 请求不会登记绑定，`document.tool_call` 在那条路上仍然永远拿不到活跃绑定。**

用**同一个常量**保证两条路是同一份包装，比分别调两次 `withRendererToolRegistry(docsAiPorts)` 更安全（后者会创建两个独立的 Map，各自登记各自的）。

**这一条是卡上原来没写的，E 发现得对。**

### 修复后的行为变化（重要）

| 路径 | 用哪个查找 | 语义 |
|---|---|---|
| **生产（修复后）** | `activeRendererBindingFor(filePath)` | **按文件精确匹配**（更严） |
| agent 侧 | `soleActiveRendererBinding()` | 「全仓库恰好一个」兜底 |

**生产装配用的是前者，所以修复后行为是更严格的那个。** 实施者要在回写里确认这个差异不会让 agent 侧出问题。

## 结果回写（2026-10-23）

**提交**：`9487eaa4` — fix(T40): 把 withRendererToolRegistry 接回生产装配（两处注入）

### 第一步确认（全部成立，另发现一处卡上没写）

1. **零调用点成立。** `grep -rn "withRendererToolRegistry" apps/desktop/src/ packages/`
   只命中定义那一行（`documentToolRendererBinding.ts:58`）。
2. **`active` 的写入路径只有一条**：`withRendererToolRegistry` 的 `run`
   进入段 `active.set`、`finally` 里撤销。其余 6 处都是只读（`activeRendererBindingFor` /
   `hasActiveRendererBinding` / `soleActiveRendererBinding`），`clearRendererToolRegistry`
   写明「测试专用」。
3. **不包装时的实际行为**：`run` 照常执行，但登记簿全程为空 →
   `activeRendererBindingFor(filePath)` 恒回 `{ ok: false, reason: "该文件当前没有正在
   运行的受信文档 AI 请求…" }` → `ipc/document.ts:349` 的 `surfaceFor()` 得到
   `rendererOpen: () => false`，且**不装** `invokeRendererTool` / `rendererToolDefinition`
   → `document.tool_call` 只能走 CLI 分支或失败。

**★ 卡上没写的一处**：`ipc/index.ts` 有**两条**注入，不是一条。

```
:170  registerGenofficeViewAiIpc(..., () => ({ context, ports: docsAiPorts }))
:227  documentViewHost.setDocsAiPorts(docsAiPorts)
```

两处喂的是**同一张**登记簿。**只改 227 那一行，:170 那条路上的请求仍然不登记** ——
原卡给的最小修复是不完整的。已改为同一个常量 `registryWrappedDocsAiPorts` 供两处使用。

### 修法

```ts
// ipc/index.ts，装配段开头
const registryWrappedDocsAiPorts = withRendererToolRegistry(docsAiPorts);
```

`withRendererToolRegistry` 是纯包装：`describe`/`confirm` 原样转发，`run` 只在
`invokeRendererTool` 是函数时登记（`typeof invokeRendererTool !== "function"` 时直接转给
原实现，不登记也不报错）。所以**没有改变任何既有行为**，只是补上了原本缺失的登记。

### 回归：断言打在装配路径上

新套件 `apps/desktop/scripts/t40-renderer-registry-smoke/`（13 条，全绿）。

**做法**：真调 `registerIpcHandlers()`（electron 整包换桩，`ipcMain` 是记名替身、重复注册
当场抛），然后从 `documentViewHost` 里取出它**实际收到**的那个 ports 对象断言。没有用
T24 套件那种「测试自己调 `withRendererToolRegistry`」的写法。

关键四条：

| 断言 | 证明什么 |
|---|---|
| 宿主收到的 ports `!== docsAiPorts` | 生产装的不是原始对象 |
| `run` 执行**中途**登记簿查得到该文件 | 包装层真的会登记（不是空壳） |
| 结束后 `activeRendererBindingFor()` 回 `ok: false` | 引用计数撤销干净，不泄漏 |
| **对照组**：同一底层 ports 不包装直接跑，中途查不到 | 病灶直接复现 |

外加两条源码级断言（无头下 vendor 通道够不到，只能用源码钉住）：两条注入引用同一常量、
不得残留 `setDocsAiPorts(docsAiPorts)`。

### 变异证据

把 `const registryWrappedDocsAiPorts = withRendererToolRegistry(docsAiPorts)` 改成
`= docsAiPorts`：

```
FAIL 宿主收到的是**包装过**的 ports,不是原始的 docsAiPorts — {"wiredIsOriginal":true}
FAIL 装配代码里 withRendererToolRegistry 被调用了(不是零调用点) — {"wrapsCount":0}
FAIL 两条注入都用同一个包装常量 — {"hasConst":false,...}
```

`cmp` 逐字节还原（`RESTORED-BYTE-IDENTICAL`）。

### 验证

- `t40-renderer-registry-smoke` 13/13（提交后重跑仍 13/13）
- `t24-document-tool-surface-smoke` 59/59（不回归）
- `memory-codex-smoke` 234/234（`ipc/index.ts` 的另一处覆盖）
- `smokes-for.sh src/main/ipc/index.ts` 已自动发现新套件
- 双包 typecheck 绿

### 同类问题清单（卡要求「列出来，逐个说明」）

1. **`ipc/index.ts:170` 的 vendor 视图 AI 通道** —— 与本卡同一个 bug 的第二处，**已一并修**（见上）。
2. **T24 套件自身的测法** —— 不算产品缺陷，但它是本卡能漏到今天的原因：
   `t24-document-tool-surface-smoke` 的 import 里**完全没有**
   `documentToolRendererBinding`，它对渲染端路线的覆盖是零。新套件补的正是这一块。
3. **`slidesApi` / `sheetsApi`** —— 检查过：`withRendererToolRegistry` 只针对
   `DocsAiPorts`，没有对应的 slides/sheets 包装器存在，不存在「有包装器没接」的同类项。

### 关于「修复后行为更严格」

卡末提到生产用 `activeRendererBindingFor(filePath)`（按文件精确匹配）、agent 侧用
`soleActiveRendererBinding()`（全仓库唯一）。**修复后没有任何变化** —— 这两条查找函数本来
就是这样，本卡的修复只是让它们终于有数据可查。不存在"收紧"。

### 未做 / 需要知道

- **不得宣称 T30 完成**（按卡上第 7 条）：真 Electron 下的端到端仍需要 U1，且用户要求
  暂时不要弹窗。
- 本卡只动 `ipc/index.ts` 与新建套件；`documentToolRuntime.ts` / `documentToolSurface.ts`
  未动。
