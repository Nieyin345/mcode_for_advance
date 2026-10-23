# T36｜三套 smoke 的夹具过时（T65/T50/正则漏算 schema 包装）

- Status: done（2026-10-23 验收通过：已交付，提交 09e343b5）
- Category: **bug（测试夹具）**
- Priority: P1
- Depends on: none
- Exclusive writable files: `apps/desktop/scripts/renderer-pure-smoke/`、`settings-panel-smoke/`、`settings-panels-electron-smoke/`（含其 `api-stub.js`）。

## Required Skills
- `mcode-smoke`: 理解夹具与断言的边界，判断「产品变了」还是「断言写死了旧形状」。
- `code-review`: 确认修的是夹具，没有顺手放宽产品检查。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/renderer-pure-smoke/`、`settings-panel-smoke/`、`settings-panels-electron-smoke/`。

## C 会话实测的三条（都单独复跑稳定复现）

### ① `renderer-pure-smoke` 319/320 —— MC-098 `readMonacoSelection 返回 lines`

**夹具过时**：`b41d41e4`（T65）把捕获逻辑抽到 `ide/monacoCitationSelection.ts:84-88`，正则还钉在 `FileEditor.tsx` 上。

**佐证**：产品没坏——同套另两条 MC-098 仍绿，真入口 E1 `ide-quote-snapshot-smoke` 本次 PASS。

**修法**：把断言指向真实位置，或改成读真实导出行为而非源码正则。

### ② `settings-panel-smoke` 153/154 —— `toggleEnabled`

**夹具过时**：源码现在是 `api.hooks.save({ hook: HookSpecSchema.parse(next) })`，正则没算 schema 校验这层包装。

**逻辑本身正确。**

### ③ `settings-panels-electron-smoke` 31/32 —— MC-045 真 App 挂不起来

**夹具过时**：`contributionsOf` 读 `catalog.modules.flatMap`，而探针 `api-stub.js` 的 `makeNamespace` 对未显式列出的命名空间回 `Promise.resolve({})`，`modules.catalog()` 回 `{}`。`7eb548c9`（T50）把 `ModuleViewDock` 接进布局后真 App 会渲染它，探针没补桩。

## 工作顺序

**第一步：逐条确认 C 的诊断。**

不要直接改——先自己跑一遍看红在哪，再读源码确认它说的「产品变了、夹具没跟」成立。

**如果发现某条其实是产品坏了，停下报告，不要改夹具。**

**第二步：修夹具。**

三条各自的最小改动。**不许放宽断言**——只让它指向产品的真实位置。

**第三步：变异验证。**

每条撤掉修复 → 对应断言变红 → 逐字节还原（`cmp`）。

## 额外考虑（C 提的第二条观察）

> `contributionsOf` 对 catalog 有 `catalog?.modules` 保护，但对「回包存在却缺 modules 字段」没有保护——形状漂移就白屏。

**这条不属于本卡**（它要改产品代码）。但如果你在修 ③ 时确认这个风险真实存在，**在回写里点名，我另开卡**。

## 验收判据

1. 三条各自：确认诊断成立（或推翻）。
2. 三套全部转绿。
3. 变异验证：撤修复 → 变红 → `cmp` 还原。
4. **不放宽任何断言**。
5. 双包 typecheck 通过。

## 边界

- **只改夹具（`scripts/` 下）**，不改产品源码。
- **不改** `run-smokes.mjs`。
- **不碰** T28/T20/T29/T30 正在改的文件。
- 若某条诊断不成立，**停下报告**，别硬修。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T36-stale-smoke-fixtures.md` 末尾追加 `## 结果回写（2026-10-23）`：三条各自的诊断确认、修法、变异证据、提交 SHA、发现的产品风险。

---

## 结果回写（2026-10-23，C 会话）

### 0. 三条诊断的独立复诊结论

**三条全部成立，没有一条是「产品坏了」。** 每条我都先单独复跑看到具体的红，再读源码确认。
另外每条都补了一条**判据没有放松**的证明（见各条）。

### ① `renderer-pure-smoke` 319/320 —— MC-098，诊断成立

**复跑**：`FAIL ★ MC-098:选中时把行号范围与正文一起冻结(readMonacoSelection 返回 lines)`，
detail 里能读到 `lines: { start: sel.startLineNumber, end: lastQuotedLine }` —— 说明**产品里有
这个字段**，只是断言看错了文件。

**源码确认**：`FileEditor.tsx:805` 的 `readMonacoSelection` 现在是一行委托
`captureMonacoCitationSelection(editorRef.current)`；`role` / `lines` 在
`ide/monacoCitationSelection.ts:87-88`。缺陷由 `b41d41e4`（T65）抽取时引入。

**修法（判据不变，只改指向）**：
- ① 改为读 `monacoCitationSelection.ts`，正则**原样保留**（仍要求 `role: "assistant"` 与
  `lines: {` 在同一个返回对象里，200 字符窗口 ── 即「同一份快照」）。
- ①b **新增**一条：`FileEditor` 那一层必须是委托给 `captureMonacoCitationSelection`，不是自己
  另写一份。这条比原来更强 —— 原文只钉了一处实现，现在钉住「没有第二份实现」。
- ②③ 两条原样未动。

**结果**：`renderer-pure-smoke: 321/321 通过`（原 320 条 + 新增 1 条）。

**变异**：把 ① 的正则改回读 `FileEditor.tsx` → **红**
（`FAIL ★ MC-098:选中时把行号范围与正文一起冻结`，detail 列出 `lines: {...}` 但不匹配）→
`cmp` 逐字节还原。

### ② `settings-panel-smoke` 153/154 —— toggleEnabled，诊断成立

**复跑**：`FAIL ★ 钩子开关 toggleEnabled 检查 {ok:false} 并走 toast 报错`，detail 显示
`["api.hooks.save({ hook: HookSpecSchema.parse(draft) });", "api.hooks.save({ hook: HookSpecSchema.parse(next) });"]`
—— 产品代码里那句**就在那儿**，只是多了一层 `HookSpecSchema.parse()` 包装。

**源码确认**：`HooksPanel.tsx:318` 的 `api.hooks.save({ hook: HookSpecSchema.parse(next) })`
后面紧跟 `if (!res.ok) { useToastStore.getState().push({...}) }`，逻辑完全正确。

**修法（判据不变，只允许包装层）**：正则从 `hook:\s*next\s*` 放宽到
`hook:\s*(?:HookSpecSchema\.parse\()?next\)?\s*` —— **只**多认这一层 schema 校验。
后面的 `if (!res.ok) { useToastStore.getState().push(` 仍逐字要求。
失败时 detail 现在会打出全部两处 `api.hooks.save({...})` 调用，便于下次定位。

**结果**：`settings-panel-smoke: 154/154 通过`。

**变异**：正则退回 `hook:\s*next\s*` → **红**（同上那条断言）→ `cmp` 还原。

### ③ `settings-panels-electron-smoke` 31/32 —— MC-045，诊断成立

**复跑**：`FAIL SPE ★ MC-045 前置:真 App 能挂起来`，`renderError` 是
`TypeError: Cannot read properties of undefined (reading 'flatMap') at contributionsOf`。

**源码确认**：`ModuleContributions.tsx:18` 读 `catalog.modules.flatMap`；探针
`api-stub.js` 的惰性 Proxy 对未显式列出的命名空间回 `Promise.resolve({})`，于是
`modules.catalog()` 的 `.modules` 是 `undefined`。`7eb548c9`（T50）把 `ModuleViewDock`
接进 `ThreePaneLayout` / `ClassicShell` 之后，真 `App` 一定会渲染它。缺陷成立。

**修法**：在 `api-stub.js` 里补一个**显式**的 `modules` 命名空间，回**真实形状**的最小目录
（`modules: []` / `capabilities: []` / `workflowTargets: []` / `modulePermissions: {}` /
`moduleStaleConsents: {}`），**不是 `{}`**。空模块表 = 全新安装的真实状态，面板应正常渲染。

**结果**：`settings-panels-electron-smoke: 46/46 真 Electron 断言通过`（原 31 条 + 之前因
前置失败被挡住的 15 条）。

**变异**：删掉整个 `modules` 桩块 → **红**，错误与原始缺陷**逐字一致**
（`reading 'flatMap' at contributionsOf`）→ `cmp` 还原，SHA-256 回到 `02d2cd1a…`。

> 变异过程里我自己犯过一次错：用 Python 切片删块时切错了边界，制造出 `Uncaught SyntaxError`，
> 那一轮的红是**语法错误造成的**，不是断言承重。发现后还原、改用精确行号重做，才有了上面这条
> 有效的变异证据。记在这里是因为「红得不对」比「不红」更容易骗人。

### ④ 你问的产品风险：**确认成立，建议开卡**

`contributionsOf` 的保护只有一层：

```ts
return catalog?.modules.flatMap(...) ?? [];
```

`catalog?.` 只挡住「目录还没读到」（`undefined`），**没挡住「回包存在但 `modules` 缺失」**。
实测用源码文本核对：有 `catalog?.`（true）、没有 `catalog?.modules?.`（false）。

真实触发路径不止测试桩：主进程 `modules.catalog()` 的返回值若因版本漂移、降级安装、或
IPC 序列化裁剪而少了 `modules` 字段，`contributionsOf` 会在 `useMemo` 里同步抛错 →
React 19 整棵子树卸载 → **设置页白屏，且用户看不到任何解释**。这与仓库硬规矩「坏东西显式
报出来，不静默跳过」相反：现在是「坏东西直接炸掉整页」。

建议另开卡的最小修法：`catalog?.modules?.flatMap(...) ?? []`，同时把「目录形状不符」
显式报进 `catalog.error`（而非静默返回空列表 —— 那会变成另一种静默）。

### ⑤ 边界与验证

- 改动只在这三个 `scripts/` 套件目录内：`renderer-pure-smoke/main.ts`、
  `settings-panel-smoke/main.ts`、`settings-panels-electron-smoke/api-stub.js`。
- **未改**产品源码、**未改** `run-smokes.mjs`、**未碰** T28/T20/T29/T30 的文件。
- 三套结果：`renderer-pure-smoke 321/321`、`settings-panel-smoke 154/154`、
  `settings-panels-electron-smoke 46/46 真 Electron`。
- 双包 typecheck：`packages/contracts` exit 0、`apps/desktop` exit 0
  （注：过程中有一次 desktop tsc 报 `x-mcode-roundtrip-smoke` 的错，那是**另一个会话正在改**
  的未提交文件，属 T28 边界；复跑两次均为 0 错误，我的三个文件不产生任何诊断）。
- 三次变异全部 `cmp` 逐字节还原。

### 6. 提交

见提交 SHA。
