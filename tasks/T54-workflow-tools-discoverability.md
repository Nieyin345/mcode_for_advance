# T54｜两套工具面分开：`app_api_list` 看不见 `mcode-workflow` 的 14 个工具

- Status: **done（2026-10-23 验收通过：17/17，提交 `100a538e`）**
- Category: bug（可发现性）
- Priority: P1
- Depends on: T48（关闭时发现的真问题）

## 缺陷

`app_api_list` 的数据源是 `apiEntries()` → `API_CATALOG`（`apiCatalog.generated.ts`），即 RPC 方法目录。

而 `mcode-workflow` 的 14 个工具在 `mcp/mcodeServer.ts:208` 的 `workflowMcpTools()`，**一个名字都不在 API_CATALOG 里**。

**两套完全独立的注册，不是 wrapper：**

| 工具面 | 覆盖 | 挂载 |
|---|---|---|
| appControl | `app_api_list` / `app_api_call` 覆盖 RPC | — |
| `mcode-workflow` | 14 个 MCP 工具 | Claude 走 `buildWorkflowMcpServer`；Pi/Codex 走 `workflowEngineBridge` |

**没有任何一处把两者连起来。** 所以任何去找「AI 能做什么」的人都会先看 `appControl/tools.ts`，然后得出「没有节点工具」的结论——**总控就是这么得出 T48 那个错误前提的。**

## 修法：(A)+(B)，不做 (C)

### 为什么不做 (C)

把 14 个名字塞进 `app_api_list` 的返回是**有害**的：那张表的语义是「能被 `app_api_call` 调的方法」，混进 MCP 工具会让模型用 `app_api_call({method:"node_types_list"})` 去调——那条路根本不通。

### (A) `app_api_list` 无参数说明里加第六道门

原来只有 ①–⑤，新增：

> ⑥ **看/写工作流本身**（有哪些节点类型、节点参数、新建或改一份工作流）：那是 mcode-workflow 那套**工具**（`node_types_list` / `workflow_get` / `workflow_save` …），**不是** `app_api_call` 的方法 —— 直接按工具名调；要看清单用 `app_guide({topic:"workflow-tools"})`。

### (B) `app_guide({topic:"workflow-tools"})` 返回完整清单 + 操作顺序

```
node_types_list（看节点与参数）
  → workflow_get（改之前先取版本）
  → workflow_save（存；新图第一步必须是 mcode.main；新建不传 expectedRevision）
```

## 实现

- `apps/desktop/src/main/appControl/guide.ts`（+85：`WORKFLOW_TOOL_SURFACE` 14 条 + `workflowToolsDetail()` + 并进 `guideTopics()` / `buildGuideDetail()`）；
- `apps/desktop/src/main/appControl/tools.ts`（+7：`app_api_list` 说明加第六道门）；
- 新建 `apps/desktop/scripts/t54-workflow-tools-discoverability-smoke/`（17 断言）。

## 套件里最值钱的一条

**清单必须与 `workflowMcpTools()` 逐条一致**（少一个、多一个都红）。

**这一条当场抓到了 D 自己的错**：第一版只写了 13 个，漏了 `session_list`：

```json
{"declared":13,"real":14,"missingFromList":["session_list"]}
```

**为什么值得这么写**：清单是第二份抄写，两份必然漂。让套件把它们钉在一起，下次 `workflowMcpTools()` 加工具时这里会红。

**它还抓到第二个错**：最初把 `session_list` 标成只读，套件比对 `WORKFLOW_READONLY_TOOLS` 报不一致——**它确实要审批**（读得到本机有哪些对话）。

## 变异证据（两次）

| 变异 | 结果 |
|---|---|
| **A 删掉第六道门** | **5 条红**，全部 `{"matched":"(没匹配到)"}` |
| **B 从清单删掉 `node_types_list`** | **3 条红**，点名 `{"missingFromList":["node_types_list"]}` |

两次 `cmp` 逐字节还原。

## 一个 D 自己抓到的断言缺陷

变异 A 第一次跑出来的 detail 是：

```
FAIL ★ 无参数说明里有第六道门 — "⑥ 安装\n      // 与回滚都在 modules.install…"
```

**正则 `⑥[^\\]*` 匹配到了别处的 `⑥`** —— 那个文件里还有两处（`modules.install` 的注释、workshop 对账步骤）。**也就是说这条断言在原位也「碰巧绿」，只是碰巧。**

改成锚定**整段**（从 `"  ⑥ **看/写工作流本身**` 起，到 `要找**有没有**某个能力` 止），并加一条「那段话确实在 `app_api_list` 的说明串里」的防空过。

**「变异不仅证明断言能红，还暴露了它红得不对」** —— 今天第二次出现（C 在 T44 也说过同一句）。

## 关联套件

- `agent-guide-smoke` **44/44**（`app_guide` 的套件，加 topic 后不回归）；
- `mcode-admin-smoke` **289/289**（`workflowMcpTools` 那套）；
- 双包 typecheck：contracts exit 0，desktop 两个文件 0 错。

## 未做的

1. **没把 14 个工具的描述也搬进 guide** —— 只给名字 + 一句话 + 操作顺序。详细参数仍在 `node_types_list` 里（**那是唯一真源，搬过来就漂了**）。
2. **`session_list` 的默认可见性没动** —— 它在 `workflowMcpTools()` 默认返回里，但被 `SESSION_LOG_TOOLS` 在公网那条路摘掉。本卡只描述现状，不改行为。

## 一处失误（D 如实报告）

> 我一开始用 `cat >> tasks/T54-*.md` 写回写，**那个文件不存在，等于我自己建了一张空卡**。发现后已删除（`git status` 确认它从未被提交过）。

**按新分工，卡只能由总控写。** 这是总控漏写卡导致的（第三次），D 的处理是对的。

---

## 结果回写（2026-10-23，D 会话，总控整合）

- **实现**：`guide.ts`（+85：`WORKFLOW_TOOL_SURFACE` 14 条 + `workflowToolsDetail()` + 并进 `guideTopics()` / `buildGuideDetail()`）；`tools.ts`（+7：`app_api_list` 说明加第六道门）；新建 `t54-workflow-tools-discoverability-smoke/`（17 断言）。
- **证据**：17/17；变异 A（删第六道门）5 红、变异 B（删清单一条）3 红，均 `cmp` 还原；`agent-guide-smoke` 44/44、`mcode-admin-smoke` 289/289；双包 typecheck 通过。
- **过程**：清单一致性断言当场抓到漏写 `session_list`；变异 A 暴露出原正则误命中文件里另外两处 `⑥`，已改为整段锚定 + 防空过守卫。
- **未做**：没搬工具描述（DRY：`node_types_list` 是唯一真源）；没改 `session_list` 可见性。
- **提交 SHA**：`100a538e`
