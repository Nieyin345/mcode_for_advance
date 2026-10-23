# T33｜`document.read` 被误放进 BLOCKED；`document.toolCall`/`markdownEdit` 档位偏弱

- Status: done（2026-10-23 验收通过：30/30，提交 75f702d0 + b6b39b30）
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

## 结果回写（2026-10-23）

**提交**：`75f702d0` — fix(T33): 收正 document.* 的审批档位（整域，不只是卡上那三条）

### 一、核实结果：范围比卡上写的大得多

用 `policyFor()` 直接探（不是读源码猜），修前实际档位：

| 方法 | 修前 | 应该是 | 出处 |
|---|---|---|---|
| `document.read` | **blocked**（`reason:"read"`） | read | 卡上缺陷 A |
| `document.capabilities` | **blocked**（`reason:"read"`） | read | 卡上缺陷 A |
| `document.apps` | write | read | **卡上没写** |
| `document.toolsList` | write | read | **卡上没写** |
| `document.toolDescribe` | write | read | **卡上没写** |
| `document.markdownRead` | write | read | **卡上没写** |
| `document.render` | write | read | **卡上没写** |
| `document.edit` | danger | danger | 正确 |
| `document.convert` | danger | danger | 正确 |
| `document.markdownEdit` | write | **danger** | 卡上缺陷 B |
| `document.toolCall` | write | **danger** | 卡上缺陷 B |

**是 `document.*` 整个域的档位都不对**，不只是卡上那三条。

两条互不相关的病灶：

**① 只读被写进了 BLOCKED 表。** `document.read` / `document.capabilities` 躺在
`const BLOCKED: Record<string, string>` 里，而 **BLOCKED 的值语义是「拒绝理由」**，
不是档位。于是 `policyFor()` 返回 `{level:"blocked", reason:"read"}`，UI 文案变成
「这个功能不开放：read」。原注释写的是「读走只读档」——**意图与实现完全相反**，
而且后果比"档位偏弱"严重：是彻底不可用，不是多弹一次卡。

**② `READ_VERB` 要求动词在开头。** `policy.ts:391`：

```ts
const READ_VERB = /^(list|get|read|status|search|info|…)/;
```

`markdownRead` / `toolsList` / `toolDescribe` / `apps` / `render` 全是「前缀 + 动词」，
一个都命中不了，全部落进 `return { level: "write" }` 兜底。

### 二、修法

**没有改正则。** 把 `^` 放宽成「任意位置」会让 `browser.historyClear`（清地址栏历史）、
`git.checkout`（切分支、改工作区）这类**名字里带只读动词、实际会写**的方法一起被放行
——那正是 `EXPLICIT` 表上方那段注释记的坑。**逐条钉死比放宽一条全局正则安全得多。**

- 七条只读 → `EXPLICIT` 标 `read`
- `document.toolCall` / `document.markdownEdit` → `DANGER`
- `document.read` / `document.capabilities` 从 `BLOCKED` 移出

**为什么写用 `danger` 而不是 `write`**：两者都弹卡，差别是**能不能「始终允许」**
（`tools.ts` 的 `isToolAlwaysAllowed`）。`write` 允许记住，于是用户点一次「始终允许」，
此后每次文档写入都不再问。这同时是 **T19 的绕过路径**：扩展拿到 `document.edit`
权限后改调 `document.toolCall`，就绕开了逐次审批。

### 三、`document_tool_call` 的判据对齐（卡上第三步）

**agent 侧早就是对的**。`appControl/tools.ts:3241-3245`：

```ts
const mutating = name === "document_md_edit"
  || (typeof scope.tool === "string" && (resolvedApp === undefined || isMutatingDocumentTool(resolvedApp, scope.tool)));
const denied = await gateAppAction(ctx, mutating ? "danger" : "read", …);
```

而 IPC 侧 `ipc/document.ts` 的 handler **没有任何第二层闸**（grep 过 `gateAppAction` /
`approval`，零命中）——它完全依赖 `policyFor` 的档位。所以本卡是**补上 IPC 侧缺失
的那一半**，让两条路同判据。**没有改 `isMutatingDocumentTool`，也没有引入第二套判据。**

### 四、回归

新套件 `apps/desktop/scripts/t33-document-policy-smoke/`（30 条）：

- **全部调 `policyFor()` 问行为**，一个字面量扫描都不留；
- 七条只读必须 `read`，且显式钉「不是 blocked、不是 danger」；
- 四条写必须 `danger`，且**四条档位完全一致**（堵掉"从松的那条绕过去"）；
- `BLOCKED` 表里不得出现任何 `document.*` —— 这类错误（值当档位写）在类型上抓不到
  （两边都是 `Record<string, string>`），只能盯源码切片。

**顺带修掉 `genoffice-cli-smoke` 的一条假绿**（卡上要求）：

```ts
// 修前：policy.includes('"document.read": "read"')
// 当时 document.read 在 BLOCKED 表里，而 BLOCKED 的值正好也叫 "read" ——
// 这一行字面量同时满足「出现在文件里」和「长得像只读档」。
// 修后：
check(…, policyFor("document.read").level === "read", …);
```

### 五、变异证据

| 变异 | 结果 |
|---|---|
| `document.read` 移回 `BLOCKED` | 3 条红，`{"actual":"blocked","expected":"read"}` |
| `document.toolCall` 从 `DANGER` 删除（回落到兜底 write） | 3 条红，`{"actual":"write","expected":"danger"}` |

两次都 `cmp` 逐字节还原（`RESTORED-BYTE-IDENTICAL`）。

### 六、验证

`t33-document-policy-smoke` 30/30（提交后重跑仍 30/30）、`app-control-smoke` 574/574、
`policy-engine-smoke` 207/207、`genoffice-cli-smoke` 54/54、`t24-document-tool-surface-smoke`
59/59、`module-app-call-smoke`、`document-read-smoke`、`t40-renderer-registry-smoke` 13/13、
双包 typecheck 绿。

### 七、需要产品决策的点（卡上要求标注）

1. **`document.read` 是否该开放给 agent** —— 按卡上要求「先按注释的意图（只读档）修」，
   已改为 `read`。若产品决定 agent 不该读文档内容，应改回 `blocked` 并**改写注释**
   （原来的错就是「注释说只读、实现是 blocked」，两边不一致才骗过断言）。
2. **`document.render` 归 read** —— 它写的是 `<dataRoot>/docs/export-tmp/`（临时目录），
   不碰用户工作区。若认为"任何写盘都该问"，这条要重新定档。

### 八、未做 / 需要知道

- **没有真 Electron 验证**：档位是纯查表逻辑，本套验的就是 `policyFor()` 本身；
  UI 上那句话（「这个功能不开放：read」）是否真的消失，要 T30 的 U1 才能看到。
- **不改 36 个权限名**（卡上硬约束）—— 只动了档位表，权限名一个没碰。
- 提交流程按总控新规矩：`git add <paths>` + `git commit -F- -- <paths>`。已核对
  `git show --name-only 75f702d0`，只有本卡的 4 个文件，没有卷进别人的改动。
