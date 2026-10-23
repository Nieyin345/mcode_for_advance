# T41｜`contributionsOf` 只有一层可选链，`modules` 缺失时设置页白屏

- Status: ready-for-agent
- Category: **bug（P1 产品缺陷）**
- Priority: P1
- Depends on: T36（`09e343b5`，C 在修夹具时确认了这个风险）
- Exclusive writable files: `apps/desktop/src/renderer/components/modules/ModuleContributions.tsx`、其调用方、新建回归套件。

## Required Skills
- `frontend-design`: React 19 的错误边界与卸载行为，以及空状态该怎么呈现。
- `mcode-smoke`: 建回归，并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T36-stale-smoke-fixtures.md` 回写 §4、`apps/desktop/src/renderer/components/modules/ModuleContributions.tsx`、`apps/desktop/src/renderer/components/ui/`（`ErrorNote` / `EmptyState`）。

## C 会话确认的缺陷（我已复核源码）

```ts
// ModuleContributions.tsx:19
return catalog?.modules.flatMap(module => module.contributions.filter(...)) ?? [];
```

**只有一层可选链。** `catalog?.` 挡住了「目录还没读到」（`undefined`），**没挡住「回包存在但 `modules` 缺失」**。

**后果**：`catalog?.modules` 是 `undefined` → 对它调 `.flatMap` → **同步抛错** → React 19 整棵子树卸载 → **白屏，用户看不到任何解释**。

### 影响面比「设置页」大得多（总控复核，4 个调用点）

```bash
grep -rn "contributionsOf" apps/desktop/src/renderer
```

| 调用点 | 时机 | 炸掉的范围 |
|---|---|---|
| `RightPanel.tsx:122` | **渲染期直接调用**，无 `useMemo`、无 error boundary | **常驻面板** → 整棵应用树卸载 → **整个主界面白屏** |
| `CommandPalette.tsx:208` | `useMemo` 内，命令面板每次打开时 | 命令面板（Ctrl+K）打不开 |
| `ModuleContributions.tsx:37` | `useMemo` 内，`ModuleViewDock` | 模块视图坞 |
| `ModuleContributions.tsx:19` | 定义 | — |

**`RightPanel` 是常驻的**，所以这条不是「设置页白屏」，是「主界面白屏」。优先级不变（P1，需要主进程真的少返回 `modules` 才触发），但断言必须覆盖 `RightPanel` 这条，只测设置页会漏掉最严重的那条。

**真实触发路径不止测试桩**：主进程 `modules.catalog()` 的返回值若因版本漂移、降级安装、或 IPC 序列化裁剪而少了 `modules` 字段。

## 为什么这是 P1

它违反仓库硬规矩第 3 条：

> **坏东西显式报出来，不静默跳过。**

而现在的行为更糟：**直接炸掉整页**。

## 工作顺序

**第一步：确认触发路径。**

1. 造一个 `catalog` 存在但 `modules` 缺失的响应（fakeIpc 或组件测试）
2. 确认 `contributionsOf` 真的抛
3. 确认 React 19 真的导致白屏

**第二步：修。**

C 建议的最小修法：

```ts
catalog?.modules?.flatMap(...) ?? []
```

**但只加可选链不够** —— 那会变成「静默返回空列表」，是另一种静默。

**必须同时**：把「目录形状不符」**显式报出来**。

两种呈现方式，选一种并论证：
- **(A)** 在调用方渲染 `ErrorNote`（`components/ui/` 已有），说明「模块目录格式异常」
- **(B)** 在 `useRpc` 的 `toastOnError` 或 `catalog.error` 里置错误

**参考**：`components/ui/` 的 `ErrorNote` / `EmptyState` —— 仓库硬规矩 7 要求先看这些再造。

**第三步：建回归。**

断言必须打在**用户看到的东西**上（C 的硬规矩）：`modules` 缺失时，设置页**不是白屏**，而是显示一条明确的错误提示。

**第四步：变异验证。**

把 `?.` 去掉 → 断言必须变红 → 逐字节还原（`cmp`）。

## 验收判据

1. 回写区确认触发路径成立（能复现白屏）。
2. 修法：可选链 + **显式错误呈现**，两者都要。
3. 断言立在用户可见的界面上：`modules` 缺失 → 有错误提示，不是白屏。
4. 变异验证：去掉 `?.` → 断言变红 → `cmp` 还原。
5. `settings-panels-electron-smoke` 46/46 不回归。
6. 双包 typecheck 通过。

## 边界

- **不改** `modules.catalog()` 主进程侧的实现（那是数据源头，本卡只处理消费端）。
- **不改** `api-stub.js`（T36 刚交付）。
- **不碰** T39/T30/T40 正在改的文件。
- 如果发现**其他组件**也有同样的单层可选链问题，**列出来**，逐个说明。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。** React 19 的错误边界行为如果有疑问，查官方文档。

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T41-contributions-optional-chain.md` 末尾追加 `## 结果回写（2026-10-23）`：触发路径复现、修法与呈现方式选择、断言做法、变异证据、同类问题清单、提交 SHA。
