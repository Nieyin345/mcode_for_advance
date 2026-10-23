# T48｜AI 看不见 Node-RED 节点 —— **已关闭：前提不成立**

- Status: **wontfix（前提不成立，2026-10-23 关闭）**

---

## 关闭理由（2026-10-23，D 会话实测推翻，总控核实）

**「AI 看不见 Node-RED 节点」这个前提是错的。**

### 节点工具一直存在，只是不在我搜的地方

总控的证据是两条 `grep` 零命中：

```bash
grep -n "node-red|nodeRed|node_red" apps/desktop/src/main/appControl/tools.ts   → 0
grep -n "engineNode|nodeTypes|node-types" apps/desktop/src/main/appControl/tools.ts → 0
```

**但节点工具在 `mcp/mcodeServer.ts`** —— 那是一个独立的 MCP server（`mcode-workflow`），不在 appControl 的工具表里。

D 列出的 14 个工具：

| 工具 | 档 | 作用 |
|---|---|---|
| `workflow_list` | 只读 | 列工作流 |
| `workflow_get` | 只读 | 取一份（带版本号） |
| **`node_types_list`** | 只读 | **卡说「不存在」的那个** |
| `agent_profiles_list` | 只读 | |
| `session_read_log` | 只读 | |
| `workflow_save` | 审批 | 新建/覆盖（无 expectedRevision = 新建） |
| `workflow_remove` | 审批 | |
| `node_type_write` | 审批 | |
| `agent_profile_save` / `agent_profile_remove` | 审批 | |
| `agent_peers` / `agent_notify` / `agent_ask` | 通信 | |

`node_types_list` 的 description 原文：

> 列出当前可用的**节点类型**，以及每种类型的参数（key、值的形状、必填、可选值）。
> **动手写工作流之前先调它** —— 不知道有哪些类型、参数叫什么就写，只能凭空编一个，
> 而 `workflow_save` 会直接拒掉。

**卡面「必须做到」的 1、2、3 条全部已实现**，而且比卡面要求更完整（带 `problems` 清单）。

### 三家引擎都挂了

| 引擎 | 挂载点 |
|---|---|
| Claude | `ClaudeAgentSdkProvider.ts:1284` `buildWorkflowMcpServer(...)` |
| Pi | `pi-sdk/mcodeExtension.ts:264` `workflowEngineBridge.descriptors()` |
| Codex | `codex-sdk/CodexAgentSdkProvider.ts:4` |

### 有套件盖住

`mcode-admin-smoke` **289/289**，三条直接验它：

```
ok  只读集里有 node_types_list
ok  node_types_list 不收参数
ok  node_types_list 列出内置那个类型        ← 真调用，返回里含 mcode.agent
```

## 总控的错误

**两次**：
1. 只在 `appControl/tools.ts` 里搜，没搜 `mcp/mcodeServer.ts`；
2. 从「grep 不到」得出「不存在」—— **同一个错误今天犯了第二次**（T16 那次也是搜索范围写窄）。

D 的原话值得记：

> 你给的两条 grep 零命中，**如果我不多想一步就会直接去 `tools.ts` 加工具，结果会造出第二套节点工具**，与 `mcode-workflow` 并存。

**这正是「先确认问题还在」这条规矩救的第三次。**

## 但这张卡没白开：转成 T54

D 发现了一个真实的可发现性问题：

> **`node_types_list` 在 `mcp/mcodeServer.ts`，而 `appControl/tools.ts` 里什么都没有 —— 两套工具面是分开的。**
> 任何去找「AI 能做什么」的人都会先看 `appControl/tools.ts`，**然后得出「没有节点工具」的结论**。

**这是可发现性缺陷，不是能力缺陷。**

**T54**：让 `app_api_list` / `app_guide` 能看见并指路到 `mcode-workflow` 的工具面。
