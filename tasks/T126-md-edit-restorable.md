# T126｜`document_md_edit` 走 T125 的 `restorable` 路

- Status: ready-for-agent（**不急**，P2）
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
