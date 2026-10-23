# T36｜三套 smoke 的夹具过时（T65/T50/正则漏算 schema 包装）

- Status: ready-for-agent
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
