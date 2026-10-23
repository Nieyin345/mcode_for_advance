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
