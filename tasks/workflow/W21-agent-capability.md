# W21｜`mcode-agent` 的 `capability: "read"` 在 Node-RED 路径上不生效

- Status: ready-for-agent
- Category: **安全边界（声明的限制没生效）**
- Priority: **P1 —— 用户在节点上选了「只读」，实际不约束**
- Depends on: W8（§6 第 2 条）
- 来源：W8 主动报告

## Required Skills
- `mcode-smoke`：无头主进程套件。
- `security-best-practices`（**可选**）：只读 vs 可写的边界判断。

## 缺陷（W8 发现，我复核过）

`mcode-agent` 节点有 `capability: "read" | "write"` 参数（用户能选）。它的说明写着这是**能力**。

但生产路径 `runSelectedSession`（`nodePackProductionPorts.ts:29-85`）**从头到尾没读 `payload.capability`**：

```ts
const params = paramsOf(payload);
const sessionId = asString(params.sessionId);
if (!sessionId) throw Error("Mcode sessionId is required...");
const session = SessionRepo.get(sessionId);
...
const instruction = asString(payload.instruction);
const input = payload.input;
const prompt = promptOverride ?? [instruction, ...].join("\n\n");
// ↑ 没有 capability
```

而**旧侧是有约束的**（W8 指出）：`nodeSessionFor` 会用 `permissionModeForCapability` 推权限模式。

### 后果

| 用户做的事 | 期望 | 实际 |
|---|---|---|
| 在节点上选 `read`，说明写「只读检查」 | 这个 agent 不能改文件 | **能改** |
| 在节点上选 `write` | 能改 | 能改（**这个是对的**） |

**这不是提权** —— `read` 的用户本来也没被限制。**是「声明的限制没生效」。**

**但它比提权更难发现**：提权是「本该拒的没拒」，这个是「用户以为拒了而其实没拒」，
**而 UI 上那个下拉框看起来是生效的**。

## ⚠️ 派活时总控追加：旧侧的 `read` **不是「禁止写」**，别做错

我读了 `apps/desktop/src/main/orchestration/runner.ts:275-290`，函数原文：

```ts
/**
 * 能力 → 权限模式的映射(方案「能力」那张表)。粗粒度是**刻意的**:v1 只到
 * "这一步大概会做什么",按工具名的白/黑名单留到以后。
 *
 * `read` 映射到 `plan` 不是"禁止写",而是**让写变得可见**:写类工具一律弹审批,
 * 用户看得见就不算悄悄发生。项目边界的硬拒是另一套,始终生效、不受这里影响。
 */
export function permissionModeForCapability(capability: WorkflowCapability): PermissionMode {
  switch (capability) {
    case "read":  return "plan";          // ← 写类工具弹审批，不是拒绝
    case "write": return "acceptEdits";
    case "exec":
    case "net":   return "default";
  }
}
```

**用在 `runner.ts:2845`**：`const permissionMode = permissionModeForCapability(node.capability ?? manifest.capability);`
然后写进 `SessionRepo.updateSettings(...)` 的 `permissionMode`。

**所以「等效于旧行为」的正确目标是：**

| `capability` | 旧侧行为 | 新侧该做什么 |
|---|---|---|
| `read` | `permissionMode: "plan"` —— **写类工具会弹审批**（不是拒绝） | 让那一轮以 `plan` 模式派发 |
| `write` | `permissionMode: "acceptEdits"` | `acceptEdits` |

**这条纠正了我上面第二节里那句「`read` 的 agent 写文件被拒」** —— 准确的说法是
**「写文件会触发审批」**。你按这个去写断言，不要按我原来那句。

**如果你的实现让 `read` 变成「硬拒绝」，那不是等效，是行为变强了** ——
可能在旧图上造成功能倒退（以前能弹审批通过，现在直接不让写）。
**要变强的话，理由要单独论证。**

## 任务

### 一、先查清楚：旧侧到底怎么做的

**已经查完了（见上）**，但你要核实两件我还不知道的：

1. **`SessionRepo.updateSettings` 之后，`permissionMode` 真的被用来派发了吗？**
   即：那个字段是「被读了之后真的生效」，还是「记下来但没人用」？
   **这正是本卡要修的那类问题 —— 不要在新的地方复制它。**
2. **`capability` 从哪来**：`node.capability ?? manifest.capability` —— 节点级优先，
   缺了用清单默认值。迁移器写不写 `capability`？（`flowMigration.ts` 里查一下）

### 二、在 native 路径上真正生效

`runSelectedSession` 拿到了 `session`，它可以据此决定怎么派发这一轮。

**三种可能的做法（你论证选哪个）：**

| 方案 | 做法 | 风险 |
|---|---|---|
| **A. 传进 `permissionMode`** | 把 `capability` 映射成会话的权限模式，随这一轮派发 | 要确认 SDK 支持 per-turn 覆盖，而不是只认会话级 |
| **B. 在 prompt 里声明** | 加一句「你只能读」（**这是假的**，模型可以不理） | **不接受** —— 那就是把「限制」变成「建议」 |
| **C. 在 Host 侧拦截工具调用** | 复用 `useApprovalArming` 那套审批 | 最重，但最真 |

**B 不可接受**，理由写进回写：**模型可以不遵守 prompt，而 `permissionMode` 不行。**

### 三、必须有一条「真的生效了」的证据

**这条是本卡的核心验收。**

不能只断言「`capability` 字段被读到了」—— 那证明不了限制生效。
要断言：**`capability: "read"` 的那一轮，派发时用的 `permissionMode` 是 `"plan"`。**

怎么做由你定（假 port 记录收到的 `permissionMode` 是一种；真起一个 agent 看它写文件时弹不弹审批是另一种）。
**但必须能回答：「如果我把 `capability` 的处理删掉，这条会红吗？」**

**⚠️ 如果你能做出「真起 agent，看它写文件时弹审批」那条，优先做它** ——
因为「`permissionMode` 被传进去了」和「`permissionMode` 真的影响了行为」是两件事，
而这整张卡的教训就是「字段存在 ≠ 生效」。**做不到就照实说做不到。**

## 验收判据

1. **旧侧的实际行为有源码依据**（不是照 W8 的话）；
2. **方案有论证**，且明确说清「为什么不用 prompt 声明」；
3. **有一条「read 时 `permissionMode` 是 `plan`」的断言** —— 不是「字段被读到了」；
4. **正控**：`write` 时是 `acceptEdits`（否则「永远 plan」也全绿）；
5. **变异验证**：
   - 删掉 `capability` 的处理 → 第 3 条必须红；
   - 把它改成恒 `"read"` → 第 4 条必须红；
6. `tsc` EXIT=0；
7. 不跑全量。

**第 3、4 条要分开写** —— 只有一条断言时，「永远返回同一个模式」也能过。

## 边界

**可以改：**

- `apps/desktop/src/main/workflowEngines/nodePackProductionPorts.ts`
- `apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts`（**⚠️ W17 在改，先 `git status`**）
- 新建 `apps/desktop/scripts/mcode-agent-capability-smoke/`

**不许碰：**

- `apps/desktop/src/main/orchestration/scheduler.ts`（旧执行器）
- `apps/desktop/scripts/mcode-node-pack-smoke/`
- `apps/desktop/src/renderer/**`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

**⚠️ 与 W17 / W18 / W19 的冲突**：四张卡都想碰 `nodePackProductionPorts.ts`。
**开工第一步 `git status --porcelain apps/desktop/src/main/workflowEngines/`，
有未提交改动就停下来告诉我。**

## 回写

`tasks/workflow/W21-agent-capability.md` 末尾追加 `## 结果回写`：

1. 旧侧的实际行为（带行号）；
2. 方案与论证（尤其「为什么不用 prompt 声明」）；
3. 「read 被拒」那条断言是怎么落地的；
4. 两个变异各红在哪一条；
5. **定级有没有变**（如果旧侧其实也没真约束）；
6. **你没能验证的东西**；
7. **W8 / 这张卡上写错的地方**。

## 一条判断标准

**「我把限制写进了参数」和「限制生效了」是两件事。**

这个仓库里有太多「字段存在、没人读」的例子（`engine-trust.json` 无 writer、
`msg.mcode.condition` 无生产者）。这一条是它的第三种形态：
**字段被读了，但读了之后什么也没做。**

## 结果回写

**执行时间**：2026-10-24 夜（session W21 执行会话）。**未 commit**（按派活要求）。改动文件：
`apps/desktop/src/main/workflowEngines/nodePackProductionPorts.ts` + 新建
`apps/desktop/scripts/mcode-agent-capability-smoke/`（`main.ts` 46 条 + `run.sh` + `stubs/`）。

### 1. 旧侧的实际行为（带行号，逐个核实过）

| 事实 | 出处 | 结论 |
|---|---|---|
| `read → plan`、`write → acceptEdits`、`exec/net → default` | `runner.ts:282-292` | **真的映射**，且注释原文「`read` 映射到 `plan` 不是"禁止写"，而是**让写变得可见**」 |
| `permissionMode` **真的被用来派发**，不是记下来没人用 | `runner.ts:2845` 算出 → `:2855-2857` `SessionRepo.updateSettings` → `:1818` `bindSession` → `:1822` **`runtimeManager.setPermissionMode`** | 旧侧有两层：落盘的行 + **显式重钉活闸门**（因为 `bindSession` 幂等、只在首次播种） |
| `bindSession` 把 `session.permissionMode` 播种进 `ApprovalBridge` | `RuntimeManager.ts:981` | 会话绑定时种一次 |
| provider 每次工具调用读**活的**模式 | `RuntimeManager.ts:977` `getPermissionMode` → `ClaudeAgentSdkProvider.ts:984` `ctx.getPermissionMode()` → `shouldAutoApprove(mode, tool)` | **字段确实被消费**——不是「记下来没人用」 |
| `shouldAutoApprove("plan", 写工具)` = `false` → 走到 `requestApproval` 弹卡 | `mcp/toolRules.ts:205-212` + `ClaudeAgentSdkProvider.ts:1003-1009`（无审批通道时 **fail-closed 拒绝**） | `read` = 弹审批；无审批 UI 时按拒绝落地 |
| `capability` 从哪来 | `flowMigration.ts:334-336`（写进 Node-RED 原生节点）、`:521-529`（`capabilityFromNativeNode`，原生字段优先）、`:1232` | **迁移器写 `capability`**；`mcodeNodePack.ts:237-239` 再规范化成 `"read" \| "write"`，`:379` 放进 payload 顶层 |
| 生产端口（修复前） | `nodePackProductionPorts.ts` `runSelectedSession` 全函数 | **从头到尾没读 `payload.capability`** —— 缺陷如实存在 |

**所以「定级」**：原卡 P1 / 安全边界成立，**但旧侧确实真约束**（不是只记了字段）。定级不变。

### 2. 方案与论证

**选 A（传进 `permissionMode`），不是 B，也不是 C。** 具体：

- `runSelectedSession` 读 `payload.capability ?? params.capability`（顶层优先，params 是迁移兜底），
  只接受 `"read" | "write"`；其余（缺失 / `exec` / 非字符串）→ **沿会话自己的模式**（不发明权限）。
- 映射 `read → "plan"`、`write → "acceptEdits"`。
- **两条路都写**（缺一条都不算生效）：
  1. 派发给 `sendTurn` 的**会话对象**带这个模式 —— 引擎侧 SDK 的 `Options.permissionMode` 从它来；
  2. **`runtimeManager.setPermissionMode(sessionId, …)`** —— `ApprovalBridge` 的活闸门，provider 每次
     工具调用前读它、再问 `shouldAutoApprove`。`bindSession` 幂等且只在首次播种，不显式重钉的话
     一个早就绑过的会话仍握着自己那一行的模式。
- **`finally` 里还原**成会话行当时（重新读库）的模式。理由：生产端口借的是**用户的 chat 会话**
  （节点没有自己的会话行），不还原就把用户的下一句普通消息也拖进 `plan`。
- **不做成硬拒绝**（卡页 §「派活时总控追加」）：`plan` 下写类工具弹审批、用户可批准；做成 deny
  会比旧侧更强，可能在迁移图上造成功能倒退。
- **`conversation.run` 不套用**：旧侧 `showsNodeCapability` 只对 `runner.kind === "prompt"` 为真
  （`@contracts/nodeType.ts:1398-1400`），对话节点走主对话、用它当前的权限；新端口沿用。
- **`branch.decide` 显式剥掉** `payload.capability` + `params.capability`：分支表单从来没有这个字段，
  手搭的 msg 不能借模型选路改权限。

**为什么不用 B（prompt 里声明）**：**模型可以不遵守 prompt，而 `permissionMode` 不行。**
prompt 是建议，`canUseTool` / `shouldAutoApprove` 是执行层拦截。把限制写进 prompt 等于把
「限制」降级成「劝告」——这正是本卡要修的「字段存在、没生效」问题换了个位置重演。

**为什么不用 C（Host 侧拦工具调用）**：`permissionMode` 这条路**已经是** Host 侧拦截 ——
`shouldAutoApprove` 就在 `canUseTool` 里，不是模型的自觉。C 指的那套 `useApprovalArming`
是为**网页工具桥**另建的闸门；这里复用同一条 `ApprovalBridge`，没有第二套判定。
再包一层只会造两份「哪些工具算写」的清单（硬规矩 2 的反面）。

### 3. 「read 时 `permissionMode` 是 `plan`」那条断言怎么落地的

**行为，不是参数。** 套件保留**真的 `RuntimeManager` + 真的 `ApprovalBridge` + 真的
`shouldAutoApprove`**，只把**引擎实现**换成假 provider（`scripts/mcode-agent-capability-smoke/`）。
假 provider 的 `startTurn` 照 `ClaudeAgentSdkProvider` 的 `canUseTool` 做同一件事：

```
先问 ctx.isToolAlwaysAllowed?.(tool)
→ 读 ctx.getPermissionMode?.()        ← 真 ApprovalBridge 的活 Map
→ shouldAutoApprove(mode, 写工具)      ← 真判据(mcp/toolRules.ts)
→ 不自动放行就走 ctx.requestApproval(真桥,emit approval.request 等结算)
```

断言打在**判定那一刻读到的 mode**、**弹没弹卡**、**用户批准后决定是不是 allow** 三处：

- `★ read:写类工具没有自动放行`、`★ read:写类工具弹了审批卡`、
  `★ read:引擎在判定工具的那一刻读到的模式是 plan`、
  `★ read:用户批准后决定是 allow —— 是「看得见」,不是「禁止」`。
- 「不是硬拒绝」那条：**用户点拒绝**时 `decidedAllow === false`，但那一轮仍能收口
  （拒绝是工具结果，不是崩溃）。
- **判据 import 真身**：`permissionModeForCapability` 与 `shouldAutoApprove` 都从生产代码 import。
  生产端口里那张五行映射**由真身守着**：第 0 节用真身逐值比对 + 行为读数（`reqModes`），
  漂移就红。

### 4. 变异：预期红几条 / 实际红在哪

**预期与正控分开列**（先写再跑）：

| 变异 | 预期红 | 实际红 | 对上了吗 |
|---|---|---|---|
| **A 删掉 `capability` 处理**（`capabilityOf` 恒 `null` = 修复前） | 13 | **13** | ✅ 精确 |
| **B 恒 `"read"`**（`return "read"`，不看值也不看缺省） | 11 | **12** | 多 1 条，见下 |
| C 只删桥上 `setPermissionMode`（保留派发对象的模式） | （没预期，防御性加的） | 10 | — |
| D 只删 `finally` 里的还原 | （没预期，验还原断言不空） | 8 | — |

**A 的 13 条**（都是「本该被 capability 改掉却没改」）：§0 三条（read→plan、write→acceptEdits、
read≠write）、§1 一条（`★ read:引擎读到 plan`——注意 §1 的「弹了卡」在 A 下**仍绿**，
因为 `default` 也弹卡；**只有 mode 那条是判别器**）、§2 四条、§3 三条、§5 两条。
§4/§6/§7 全绿（它们断言的是「沿会话模式」，A 下本来就不改）。

**B 的 12 条**：上表 11 条里去掉 §0 的 read 那条（read 仍是 plan），加上 **§7 的
`★ branch 模型选路不读 capability`** —— 因为 `return "read"` 连「字段缺失」也当 read，
分支那条剥掉字段后仍被翻成 plan。这正是「恒返回同一个」该有的**更宽**的爆炸半径，
不是断言写错。

**C 证明了 §1 真的在验闸门不是参数**：派发对象带着 `plan`，但桥上没写，假 provider 读
`ctx.getPermissionMode()`（桥的值）读到 `default` → `★ read:引擎读到 plan` 红。
如果 §1 只断言 `sendTurnCalls[0].session.permissionMode`（W19 那种做法），C 下它会**全绿**。

**D 证明了「还原」断言不空**：删掉 finally 的还原后 `★ 收口后活闸门还原成 acceptEdits` 与
`★ 还原后写类工具又被自动放行` 精确红；另外还红了 §4/§6/§7 共 6 条 —— 因为残留的 `plan`
漏进了后面所有「沿会话模式」的用例。这既是变异证据，也是「不还原会怎样」的实证。

**还原核对**：每次变异后 `git diff` 确认改动在文件里再跑；四轮跑完 `cmp` 逐字节相等，
`sha256 = 9dbfca2f…9012925`（与开工备份一致）。备份路径保留目录结构（`.tmp/w21-bak/`），
不是只用 basename。（变异全部结束后，只对生产文件做过一处**注释措辞**修正 —— 把
「five string literals」改成「the two mode strings pinned to the real function」，
因为前者与代码不符；改后重跑三套：本章 46/46、W19 170/170、pack 393/393。）

### 5. 定级有没有变

**没有变。** 复核结论：**旧侧确实真约束**（不只是记了个字段）。
- `permissionMode` 被 `sendTurn` 真正消费；provider 每次工具调用读**活的**模式，
  `shouldAutoApprove` 是执行层拦截；
- 旧侧还多一道显式 `setPermissionMode(nodeSession.id, nodeSession.permissionMode)`
  （`runner.ts:1822`），说明它知道 `bindSession` 幂等、必须重钉；
- 所以缺陷是「新侧把一条旧侧真有的限制丢了」，不是「旧侧也没有」。

### 6. 我没能验证的东西

1. **真三家 SDK 的 `canUseTool` / `tool_call` 守卫**：本套只驱动宿主这一侧的闸门
   （`ApprovalBridge → shouldAutoApprove`），那是 `permissionMode` 生效的落点，也是
   `ClaudeAgentSdkProvider` 真正的安全线（它把 UI 的 `plan` 翻成 SDK 的 `default`，
   `ClaudeAgentSdkProvider.ts:534`，安全性**靠的正是**这道宿主闸门）。Pi / Codex 各自的
   `shouldAutoApproveForPi` / `normalizeCodexMode` 没有被本套驱动 —— 但它们读的是**同一个**
   `getPermissionMode`，模式值的到达路径被验到了，消费判据不在这套覆盖内。
2. **真起一个 CLI agent 看它写文件弹不弹审批**（卡上「优先做」的那条）：**做不到**——
   需要真的 `claude` CLI 子进程 + 真人点审批卡，无头环境两样都没有。我没有用更弱的断言
   冒充它：套件验的是宿主闸门，不是 CLI 的最终行为，这一点写进了文件头「验不了的」。
3. **审批卡的视觉 / 焦点 / 键盘**：无头给不出。
4. **`mcode-conversation` 的 capability**：旧侧对 conversation 也不生效（`showsNodeCapability`），
   新端口沿用「不读」；但**没人验过**用户在对话节点表单上选 read 时的**期望**是什么。
   我按「与旧侧等效」处理，没有按「用户意图」发明新行为。这是一个**产品判断**，不是技术结论，
   需要产品确认（如果对话节点的 read 也应生效，那是另一张卡）。

### 7. W8 / 这张卡上写错的地方

| 位置 | 写的 | 实际 |
|---|---|---|
| 卡 §缺陷 表格 | 「在节点上选 `read`…这个 agent **不能改文件**」 | **不是禁止，是弹审批**（卡页 §「派活时总控追加」已纠正；我按纠正后的写了） |
| 卡 §一.2 | 「`node.capability ?? manifest.capability` —— 节点级优先，缺了用清单默认值。迁移器写不写 `capability`？」 | **写**：`flowMigration.ts:334-336` / `:521-529` / `:1232`，而且原生字段优先于 `x-mcode.params["capability"]` |
| 卡 §一.1（我核实的） | 「`SessionRepo.updateSettings` 之后，`permissionMode` 真的被用来派发了吗？」 | **是**。落盘行 + `bindSession` 播种 + provider **每工具**读活值；不是「记下来没人用」 |
| 卡 §边界 | 「`mcodeNodeTypes.ts`（⚠️ W17 在改）」 | 我**没碰**它。开工 `git status` 时 `workflowEngines/` 只有 `nodePackBundle.generated.ts` 一处别人未提交的改动（与我的文件无关，也没碰） |
| 卡 §方案 C | 「复用 `useApprovalArming` 那套审批」 | `permissionMode` 这条路**本身就是**宿主侧审批（`canUseTool` → `shouldAutoApprove`）；`useApprovalArming` 是网页工具桥的另一套，不是唯一「真」的做法 |

**另外两条卡上没写、执行中发现的事实**（记录，不改卡）：

- **生产端口自己从不 `bindSession`**（`nodePackProductionPorts.ts:4` 文件头把它写成**有意的**
  「unbound session fails closed」）。`sendTurn` 对未绑定的会话返回 `null` → 端口报
  「Mcode session busy」。生产里会话基本都已被绑过（建会话 `lib/sessionStart.ts` 绑、
  发送 `ipc/claude.ts:312` 再绑一次并覆盖这一轮模式），所以是窄路；但 **sql.js 重启后
  还没被任何路径绑过的会话**、或建行之后被 `dispose` 掉的会话，直接挂节点会报 busy。
  **fail-closed（报错，不静默），不是安全洞**；但这说明「端口自己绑定」这件事没做过判断，
  需要产品/技术决定是否该由端口 `bindSession`（本卡不改，记录在此）。
- 端口借用户 chat 会话时，**每次模式切换会清掉该会话的「始终允许」记录**
  （`ApprovalBridge.setPermissionMode` 的设计：换了策略就撤销旧策略下的授权）。
  代价写进了生产代码注释；方向是安全的（重问一次），但用户会觉得"刚点过的始终允许又忘了"。

## 总控验收（2026-10-24，工作流总控）

**结论：通过，而且做得比卡要求的好。**

### 我复核了什么

| # | 项目 | 我的验证 |
|---|---|---|
| 1 | `permissionMode` 真的被消费（定级 P1 的前提） | 读了 `RuntimeManager.ts:1635`（`permissionMode` 进 `sendTurn`）与 `:977`（`getPermissionMode()` 每工具读活值）。**成立** |
| 2 | 新套件 | 我自己跑了一遍：`mcode-agent-capability-smoke` **PASS**，EXIT=0 |
| 3 | 边界 | `git status` 确认没碰 `flowMigration.ts` / `mcodeNodeTypes.ts` / `scheduler.ts` / 两个 node-pack 套件 |
| 4 | 映射复用真身 | 读了 diff：`import { permissionModeForCapability }`，**没有抄一份** |

### 它超出了卡的要求：验的是闸门而不是传参

我卡里写「如果你能做出『真起 agent，看它写文件弹不弹审批』那条，优先做它」。

**它做到了一半，而且方向对**：保留真的 `RuntimeManager` + `ApprovalBridge` + `shouldAutoApprove`，
只把**引擎实现**换成假 provider；假 provider 的 `startTurn` 照 `ClaudeAgentSdkProvider`
的 `canUseTool` 读 `ctx.getPermissionMode()` 再问 `shouldAutoApprove`。

**所以断言是「写类工具弹不弹卡、批准后是不是 allow」，不是「参数传进去了」。**

**它还用变异 C 证明了这一点**：只删桥上的 `setPermissionMode`（保留派发对象的模式）→ 红 10 条，
包括 `★ read:引擎读到 plan`。**如果 §1 只断言 `sendTurnCalls[0].session.permissionMode`（W19 那种做法），C 下会全绿。**

**这条变异值得记**：它是「传参 ≠ 生效」的判别器，而且是**主动加的防御性变异**（不在我要求的两个里）。

### 它的记账有三处值得学

1. **A 变异里指出「§1 的『弹了卡』仍绿，因为 `default` 也弹卡；只有 mode 那条是判别器」**
   —— **主动说出自己哪条断言没判别力**，这比「全绿」有信息量。
2. **B 多红 1 条不掩饰**，并解释「恒 read 连『字段缺失』也吃掉了，爆炸半径本来就该更宽」。
3. **D 证明「还原」断言不空**，还顺带实证了「不还原会把后面所有用例拖进 plan」——
   这个副作用本身是用户可见的（端口借的是用户的 chat 会话）。

### 它报的两条卡外发现，我判为「记录即可，不改」

1. **生产端口从不 `bindSession`**：它自己的判断是「窄路、未绑时报 session busy、不静默、不是安全洞」。
   **我同意**，但这条值得进 README 的缺口清单（G9），因为「为什么可以不 bind」需要有人知道。
2. **每次模式切换会清掉该会话的「始终允许」**：`ApprovalBridge.setPermissionMode` 的设计，
   方向安全（更保守），但用户会觉得「刚点过的始终允许又忘了」。
   **这是产品体验问题，不是缺陷。** 记在 README，将来若要改，要论证「保留 always-allow 是否安全」。

### 它纠正卡上的地方，我接受

- 卡 §一.2 问「迁移器写不写 `capability`」→ **写**（`flowMigration.ts:334-336`，原生字段优先）。
- 卡 §方案 C 说「复用 `useApprovalArming`」→ **不准确**：`permissionMode` 这条路**本身就是**宿主侧审批
  （`canUseTool` → `shouldAutoApprove`）；`useApprovalArming` 是网页工具桥的另一套。
  **我把「另一套审批」当成了「唯一的真审批」，是错的。**
