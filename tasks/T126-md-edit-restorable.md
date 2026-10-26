# T126｜`document_md_edit` 走 T125 的 `restorable` 路

- Status: delivered（2026-10-26；相关 smoke 8/8 PASS；Desktop tsc 有范围外阻塞，见回写）
- Category: 核心闭环（与 T123/T124/T125 同一条链）
- Depends on: T125（`9821e69c`）
- Exclusive writable files:
  - `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts`
  - `apps/desktop/scripts/t125-restorable-smoke/main.ts`（延伸，不新建套件）

## Required Skills
- `mcode-smoke`

---

## 零、开工前核

```bash
git status --porcelain apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts
grep -n '"document_md_edit"' apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts
grep -n 'document_md_edit' apps/desktop/src/main/appControl/tools.ts | head -3
```

**写卡时（2026-10-24 15:55，基于 H 的报告）**：`grep '"document_md_edit"' SdkMessageAdapter.ts` → **零命中**。

> ⚠️ 这条来自 H 的一次 grep。**执行前自己核一遍。**

## 一、这个洞现在有了明确的修法

**T124 证明过「照原卡修会让事情变糟」**：`document_md_edit` 改的是 `.docx`，`before` 读不到，强行记进 `turn.files` 会让 `restoreFiles` 用空 `before` 覆盖用户文件。

**T125 提供了正确的路**：`restorable: false` —— 进卡片、标不可撤销、`restoreFiles` 跳过。

**所以 T126 就是把 `document_md_edit` 接到那条路上。**

## 二、修法

在 `SdkMessageAdapter.ts` 里，`document_tool_call` 那个分支之外，**再加一个并列分支**（因为 `document_md_edit` 是独立的工具名，不是 `document_tool_call` 的 `input.tool`）：

```ts
// 【T126】document_md_edit 是独立工具名（不是 document_tool_call 的 input.tool），
// 它 edit 的是 .docx（经 docs apply），所以产物同样读不出 before。
// 走 T125 的 restorable:false 路 —— 进任务中心、标不可撤销。
if (b.name === "document_md_edit") { ... }
```

**⚠️ 先确认它的参数名**：是 `filePath` 还是 `file_path`？**`getToolFilePath()` 只认 `file_path`（`NotebookEdit` 认 `notebook_path`），如果 `document_md_edit` 用的是 `filePath`，必须自己取，不能复用那个函数。**

**这是 T123 第一版那个坑的同一形态**（`b.name` vs `b.input.tool`）：**属性名猜错 → 条件恒假 → 分支一次不进 → 套件仍绿。**

## 三、判据

1. **`document_md_edit` 改一个已存在 docx → `turn.files` 非空，`restorable === false`**。
2. **`classifyTurn` 从 `create:false` 变 `create:true`**（两段输出）。
3. **`restoreFiles` 跳过它，且它出现在 `unrestorable` 桶**（不是 `conflicts`）。
4. **`apply_ops` / `create_document` 行为零变化** —— `t125-restorable-smoke` 27/27、`t123-office-artifact-smoke` 14/14。

> ⚠️ **不要用 `kind` 做判据**（2026-10-24 H）。docx 永远属于「读不出 `before`」那一类，而 `kind` 只反映「turn 之前存不存在」—— 同一个工具改新文件和改旧文件会给出 `created` 和 `modified` 两种都正确的结果。
>
> **唯一承载判断的信号是 `restorable === false`。** 写 `kind === "modified"` 做断言会用错样本，而且它「看起来也能过」（改已存在文件时确实过）。

## 四、变异（正控/负控分开）

| 变异 | 正控（该红） | 负控（该绿） |
|---|---|---|
| 去掉新分支 | 2 | — |
| **参数名写错**（用 `file_path` 而实际是 `filePath`） | **2** | — |
| 判成 `restorable: true`（默认值） | 1（「不可撤销」那条） | — |

**第二行是核心判据** —— 它模拟 T123 第一版的真实错误形态（属性名不对 → 条件恒假 → 分支不进但全绿）。

## 五、为什么这张卡是 P2

**`document_md_edit` 的使用频率远低于 `apply_ops`。** 用户说「改一下这份报告」时，模型走 `apply_ops` 的概率高于 `document_md_edit`。

**而 T125 已经覆盖了最常见的那条路。** 这张卡补的是边角。

**如果发现 `document_md_edit` 在 `CLI_TOOL_MAP` 里根本不存在（工具没接上）**，那就什么都不做，回写里写清 —— **「这个工具没接线」也是合格结论。**

## 六、回写

`tasks/T126-md-edit-restorable.md` 末尾：

1. **参数名的实测结论**（`filePath` 还是 `file_path`）
2. 修完前后两段 `classifyTurn`
3. 套件数字、变异（正控/负控分开）、提交 SHA
4. 你觉得不对但没改的地方

## 结果回写（2026-10-26）

### 参数与调用链实测

- `apps/desktop/src/main/appControl/tools.ts` 将 `document_md_edit` 注册为独立工具，参数字段是 `filePath`；它不是 `document_tool_call` 的 `input.tool`。
- `getToolFilePath()` 只读取 `file_path`（`NotebookEdit` 例外读取 `notebook_path`），所以通用快照分支无法捕获这个工具的目标路径。

### 修复内容

- 在 `SdkMessageAdapter.ts` 增加独立的 `b.name === "document_md_edit"` 分支，提取 `filePath`，沿用 `normalizeToolFilePath()` 并调用 `FileSnapshot.recordPre()`。
- 没有把 `document_md_edit` 加进 `FILE_MUTATING_TOOLS`，没有改工作区围栏、审批或 rewind 语义。
- 在既有 `t125-restorable-smoke` 中增加真实 `SdkMessageAdapter`、`FileSnapshot`、`classifyTurn`、`settleTurn` 和 `restoreFiles` 的集成检查，没有新建套件。

### 红绿证据

- 修复前：新增判据让 `t125-restorable-smoke` 从原有绿态变为 **30/35**；`turn.files` 为空、分类仍为 `create:false`、`settleTurn` 不建任务，`unrestorable` 也没有该路径。
- 修复后：`t125-restorable-smoke` **35/35**。`classifyTurn` 前后输出：
  - 前：`{"create":false,"failed":false,"why":"这一轮没有产出文件，是问答不是任务"}`
  - 后：`{"create":true,"failed":false,"why":"产出 1 个文件"}`
- 相关回归 **8/8 suites PASS**：`t125-restorable-smoke`、`t123-office-artifact-smoke`、`file-snapshot-smoke`、`task-message-auto-create-smoke`、`t100-task-center-smoke`、`document-router-smoke`、`genoffice-file-routing-smoke`、`office-mcode-handoff-smoke`。
- 两项代码变异均使新增判据正确变红（30/35）：禁用 `document_md_edit` 分支；把真实参数名 `filePath` 错写为 `file_path`。还原后最终回归仍为 **35/35**。
- 第三项 `restorable:true` 变异也已验证：未修改生产 `fileSnapshot.ts`，而是在 `.tmp` 临时副本中将其唯一的 `restorable: false` 改为 `restorable: true`，用同一 T125 smoke 执行后按预期变红（23/35）。反例中撤销把测试 DOCX 从 10 字节写成 0 字节，并将其错误放入 `restored`；这证明安全断言能抓住该回归。所有临时 mutant/build/test/data 文件已删除，生产文件未变。

### 其他验证与限制

- `npx tsc --noEmit -p packages/contracts/tsconfig.json`：PASS。
- `npx tsc --noEmit -p apps/desktop/tsconfig.json`：被范围外的两个 unresolved import 阻塞，均位于未跟踪文件 `apps/desktop/scripts/theia-native-u1/journeys/product.ts`（`../../src/main/ipc/dbGuardedIpc.js`、`../../src/main/ipc/theiaInstalled.js`）。本任务未修改该并行工作文件。
- `git diff --check`：PASS。
- 实现提交：`46612ac8`。
- 未达成判据：本卡规定的功能与回归判据均达成；全 Desktop typecheck 仍有上述独立外部阻塞，需由对应工作线处理。
