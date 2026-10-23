# T33｜`document.read` 被误放进 BLOCKED；`document.toolCall`/`markdownEdit` 档位偏弱

- Status: ready-for-agent
- Category: **bug（P0 安全 + 功能）**
- Priority: **P0**
- Depends on: none
- Exclusive writable files: `apps/desktop/src/main/appControl/policy.ts`、`apps/desktop/scripts/genoffice-cli-smoke/main.ts`、新建回归套件。

## Required Skills
- `security-best-practices`: 档位判定是安全边界，要论证每条改动的影响面。
- `mcode-smoke`: 建回归并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T19-extension-api-surface.md`（回写区第 9 节）、`apps/desktop/src/main/appControl/policy.ts`、`apps/desktop/src/main/appControl/tools.ts`。

## 已核实的两个缺陷（D 会话调查 + 我独立验证）

### 缺陷 A：`document.read` / `document.capabilities` 误放进 BLOCKED 表

`policy.ts:149-152` 附近的注释写着：

```
// 【ARC-007】文档能力:读走只读档;编辑/转换写盘 —— 走 write 档(弹审批),
// 与其它写功能同一条纪律。capabilities 是只读诊断。
"document.read": "read",
"document.capabilities": "read",
```

**但这两行在 `const BLOCKED: Record<string, string>` 里面**（`policy.ts:62` 起），而 BLOCKED 的**值是被拒理由**，不是档位。

**后果**：`policyFor("document.read")` 返回 `{level:"blocked", reason:"read"}`，UI 文案变成「这个功能不开放：read」，agent 路径变成「这个功能不开放给 agent：read」。

**注释的意图是「只读档」，实现是「谁都不开放」。**

### 缺陷 B：`document.toolCall` / `document.markdownEdit` 档位偏弱

`policy.ts:236-237` 只把 `document.edit` / `document.convert` 钉进 DANGER。

**T24 新增的两个方法没进 DANGER**：
- `document.toolCall` —— 可执行任意原生工具，**含写操作**
- `document.markdownEdit` —— 直接改 Markdown 并落盘

它们靠**动词兜底**落到 `write` 档。

**危害**：`write` 档允许「始终允许」（`tools.ts:527-530` 的 `isToolAlwaysAllowed`），`danger` 不允许。

**同一件事（改文档）两条路**：
- `document.edit` → danger → **每次问**
- `document.toolCall` → write → **可以永久记住**

**并且这构成 T19 的绕过路径**：扩展拿到 `document.edit` 权限后，调 `document.toolCall` 会落 write 档，从而绕过 T19 的逐次审批。

## 工作顺序

**第一步：核实。**

自己读 `policy.ts` 确认这两处，并查：
- `document.toolCall` / `markdownEdit` 的 handler（`ipc/document.ts:387`、`:407` 附近）**是否真的不做任何审批**
- agent 侧的原生工具路径 `document_tool_call` 是怎么判的（`tools.ts:3108` 的 `isMutatingDocumentTool`）——**那是正确的做法，本卡应该对齐它**

**第二步：修 A。**

把两条从 `BLOCKED` 移到 `EXPLICIT`（或等价的正确档位表），值改为 `"read"` 作为**档位**而非理由。

**同时修那条被字面量骗过的断言**：`genoffice-cli-smoke/main.ts:286` 现在用 `policy.includes('"document.read": "read"')`，BLOCKED 表里那行正好满足它。**改成断言 `policyFor("document.read").level === "read"`。**

**第三步：修 B。**

把 `document.toolCall` / `document.markdownEdit` 归到 `danger`，与 `document.edit` 同档。

**对齐依据**：agent 原生工具路径的 `isMutatingDocumentTool` 已经能正确区分会改文档的工具。**同一能力不该有两个判据。**

**第四步：变异验证。**

- 把 `document.toolCall` 改回 write 档 → 对应断言必须变红
- 把 `document.read` 改回 BLOCKED → 对应断言必须变红
- 逐字节还原（`cmp`）

## 文件边界（独占）

**可写**：`appControl/policy.ts`、`genoffice-cli-smoke/main.ts`、新建回归套件。

**不要碰**：
- `packages/contracts/src/appPermission.ts`（T34 会改，是生成物）
- `modules/ModuleHost.ts`（T19 刚交付）
- `workflowEngines/`、`document/`、`renderer/`
- `build/vendor-licenses/`

## 硬约束

- **不改** 36 个权限名。
- 若发现 `document.read` 是否该开放给 agent 需要产品决策，**先按注释的意图（只读档）修，并在回写里标注这个决策点**。
- **必须提交。**

## 遇到问题先检索

用户定的最高原则：**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T33-policy-tier-fixes.md` 末尾追加 `## 结果回写（2026-10-23）`：两处缺陷的核实结果、修法、`document_tool_call` 的判据对齐情况、变异证据、提交 SHA、需要产品决策的点。

## 最终回复

只列：任务编号与标题；提交 SHA；两处缺陷各自修好没有；验收判据是否全部达成。
