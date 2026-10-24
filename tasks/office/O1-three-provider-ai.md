# O1｜三家引擎各自驱动 AI 选区编辑：证明「不是换了个 provider 就坏」

- Status: **delivered**（2026-10-24；套件 `o1-three-provider-ai-smoke` 46/46 绿，变异 6 组全中）
- Category: **Office / E2E-4 否决型判据**
- Priority: **P0 —— 用户最强调的需求是「原版 AI 交互」，而现在只有 mock 证明**
- Depends on: `genoffice-ai-ask-smoke`（主链路已通，用 mock 端点）
- 独占写入边界：
  - `apps/desktop/scripts/o1-three-provider-ai-smoke/**`（新建）
  - `apps/desktop/scripts/genoffice-ai-ask-smoke/**`（**只允许追加新段**，不改现有 20 条断言）
  - **不得改** `apps/desktop/src/main/document/docsAiPorts.ts`（除非发现真缺陷，另开卡）

## Required Skills

- `mcode-smoke`：真 Electron + CDP 套件的写法
- `systematic-debugging`：三家引擎的失败形态完全不同，要能分别定位

## 一、现状（我自己跑过的，不是读代码猜的）

| 事实 | 证据 |
|---|---|
| AI 选区交互主链路**全通** | `genoffice-ai-ask-smoke` 20 条：chip→气泡→队列→发送→文档改动→落盘→围栏 |
| 用的是 **mock `/chat/completions`** | 该套件 `probe.ts` 里的 mock 端点 |
| 三 SDK 的生产接线**已存在** | `docsAiPorts.ts:59` `SUPPORTED = new Set(["claude-sdk","pi-sdk","codex-sdk"])` |
| `resolveDocsAiSession` 真校验 provider + 工作区围栏 | 同文件 |

**所以缺口不是「接线没做」，是「三家各自的差异没被验过」。**

## 二、为什么这仍然是 P0

`docsAiPorts.ts` 只说「这三个 providerId 允许」。**允许不等于能跑。** 三家在下列地方完全不同：

| 差异点 | claude-sdk | pi-sdk | codex-sdk |
|---|---|---|---|
| 流式 chunk 的形状 | 不同 | 不同 | 不同 |
| 工具调用 / 结构化输出 | 各家协议不同 | | |
| 错误与中断语义 | 不同 | | |
| 取消（AbortSignal）行为 | 不同 | | |

**mock 端点只模拟了其中一种形状。** 另外两家在真实运行时可能：
- 流被误判成结束（用户看到「AI 说完了」但文档没变）；
- 工具结果回不去（模型说「已修改」而文档没动）；
- 取消后继续写（用户按了停止，文档还在被改）。

**这三种都是「用户看得见但说不清」的坏形态。**

## 三、判据（不需要真实 API 额度）

**⚠️ 关键约束：本机没有任何 API 凭据**（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` 全都未设置）。
**所以本卡不许要求「真调 API」** —— 那要用户配凭据并决定花额度，不是执行会话能决定的。

改成**用每家的真实协议形状**去驱动，而不是用我们编的 mock：

### 3.1 每条 provider 用一个「协议级替身」

不是「一个通用 mock」，而是**按每家的真实消息形状**造替身：

1. 读该 provider 的 **MessageAdapter / Provider 实现**（`src/main/providers/`），
   确认它把上游事件翻译成 `RuntimeEvent` 的确切形状；
2. 替身**输出该形状的真实序列**（包括边界情况：空 chunk、工具结果、报错、取消）；
3. 断言：**经过 `docsAiPorts` 之后，文档真的被改了**。

**这样验的是「我们的适配层吃不吃得下这家的形状」，不依赖网络。**

### 3.2 三家各一组，每组的必验项

| # | 验什么 | 为什么 |
|---|---|---|
| 1 | 正常流 → 文档被改 → 落盘 | 基线 |
| 2 | **流中途报错** → 不静默成功 | 报错被吞是「以为改好了其实没改」 |
| 3 | **取消（abort）后不再写** | 用户按停止后文档还在变 = 数据损坏 |
| 4 | **未知 providerId 被拒**（负控） | 证明 `SUPPORTED` 真的在拦 |
| 5 | **工作区外路径被拒**（负控） | 围栏不能因为换 provider 就失效 |

**第 4、5 是负控**：如果它们红了，说明负控本身写错了；如果它们绿了但第 1–3 也绿，才说明判据分得清。

### 3.3 不许做的

- **不许把三家都接到同一个通用 mock 上** —— 那等于只验了一家，另外两家白测。
  验证方法：**三份替身必须是不同的代码**，且各自引用该 provider 的真实事件形状。
- **不许改 `docsAiPorts.ts` 让测试通过**。它是被测对象。

## 四、★ 旧红 → 新绿

- 旧：只有 mock 一条路，三家差异无证据。
- 新：三家各有一组「形状正确 + 错误/取消/负控」的证据。

**交付时给出句话结论：三家分别有哪些形状没被适配层正确处理。**

## 五、变异要求

对每一组，至少做两次变异：

1. **撤掉该 provider 的适配分支** → 那组必须红（证明它真的走了这家）；
2. **把取消处理改成无效**（让 abort 后仍写）→ 第 3 条必须红。

**第 2 条特别重要**：如果 abort 变异后仍绿，说明那条断言没在验「取消后不写」。

## 六、结果回写区

（执行会话在此追加：三家各自的形状清单、每组的红绿、变异记录、套件结果、提交 SHA）

---

## 七、结果回写区（执行会话，2026-10-24）

### 7.1 交付物

- 新套件：`apps/desktop/scripts/o1-three-provider-ai-smoke/`
  - `main.ts` —— 三家各一组 + 负控（46 条断言）
  - `shared.ts` —— 渲染端替身（`FakeDocsRenderer`，含 vendor 的脏检查 save 闸）+ 工具契约
  - `shapes/claude.ts` / `shapes/pi.ts` / `shapes/codex.ts` —— **三份互不相同的协议替身**
  - `stubs/harnessEnv.ts` —— 宿主替身（仓储/订阅/回合句柄；工具调度器用生产实现）
  - `run.sh`
- **未改** `docsAiPorts.ts`（被测对象，一字未动）与 `genoffice-ai-ask-smoke` 现有 20 条断言。

### 7.2 三家各自的消息形状清单（从 adapter 源码读出来的真实序列）

| 环节 | claude-sdk | pi-sdk | codex-sdk |
|---|---|---|---|
| 入口 | `SdkMessageAdapter.dispatch(m)` 按 `m.type` 分派 | `PiMessageAdapter.dispatch(event)` 按 `event.type` | `CodexMessageAdapter.handleNotification(frame)` 按 `frame.method` |
| 流式文本 | `stream_event` → `event.type=message_start / content_block_start / content_block_delta{delta.type=text_delta} / content_block_stop` | `message_update` → `assistantMessageEvent.type=text_delta{contentIndex, delta}` | `item/agentMessage/delta` `{threadId, itemId, delta}` |
| 工具调用 | 独立 `assistant` 消息里的 `tool_use` 块；SDK 执行 in-process MCP 工具（`buildClaudeExternalSdkTools` 的 `handler`） | `message_update`(toolcall_start) + 独立 `tool_execution_start{toolCallId,toolName,args}`；执行走 customTool 的 `execute` | `item/started`(`item.type=dynamicToolCall{id,tool,arguments}`)；执行走 `dispatchCodexExternalToolCall` 后以 `item/completed{contentItems}` 回来 |
| 工具结果 | `user` 消息里的 `tool_result{tool_use_id,is_error,content}` → `tool.result.content` 是**块数组** | `tool_execution_end{result,isError}` → `tool.result.content` 是 **`{content:[...]}` 对象** | `item/completed` 的 `contentItems` 文本**拼接成字符串** → `tool.result.content` 是 string |
| 完成 | `result{subtype:"success", stop_reason}` + `flushFinal()` | 终态 `agent_end{willRetry:false, messages}`（`handleAgentEnd` 直发 turn.done） | `turn/completed{thread:{status}}` |
| 中途报错 | `result{subtype:"error_during_execution", result:<msg>}` → adapter 发 `error` 事件 | `agent_end` 末条 assistant `stopReason:"error"` → `error` 事件 | `error` 通知 `{willRetry:false, error:{message}}`（+ `turn/completed{failed}`） |
| 取消 | `abortSignal` → `handle.interrupt` → provider `ac.abort()`；在途 tool_use 仍可能竞争送达 | `session.prompt()` 抛出 → `finalizeTurn("interrupted")` | `markAborted()` / `finalizeAborted()` → `finishTurn("interrupted")` |
| 工具名前缀 | `mcode_renderer__` | `app_external__` | `mcode_renderer__`（与 Claude 同名但协议不同） |

适配器行号：Claude `dispatch` 467–557 / `handleAssistant` 1291–1329 / `handleUser` 1565–1587 / `handleResult` 1674–1817；Pi `dispatch` 195–360 / `handleAgentEnd` 365–400；Codex `handleNotification` 264–459 / `handleItem` 463–618 / `emitDynamicToolResult` 683–712。

### 7.3 每组的红绿（正常 46/46）

| 组 | 正常流 | 中途报错 | 取消后不写 | 负控（未知 provider / 工作区外） |
|---|---|---|---|---|
| claude-sdk | ✅ 6/6 | ✅ 2/2 | ✅ 3/3 | 共用受控组 ✅ |
| pi-sdk | ✅ 6/6 | ✅ 2/2 | ✅ 3/3 | 共用受控组 ✅ |
| codex-sdk | ✅ 6/6 | ✅ 2/2 | ✅ 3/3 | 共用受控组 ✅ |
| 负控组 | — | — | — | 7/7（含三家正控） |

补充断言：`save` 恰好一次（正常流）、`save` 从未请求（取消流）—— 见 7.5 的发现。

### 7.4 变异记录（先写预期红几条，再跑）

| # | 变异 | 预期红 | 实际红 | 归属 | 结论 |
|---|---|---|---|---|---|
| M1 | 撤掉 Claude 工具粘合（handler 直接返回 error） | 4 | 4 | 全在 `[claude-sdk]` | 该组真的走 Claude 分支 |
| M2 | 撤掉 Pi 工具粘合（execute 直接返回 error） | 4 | 4 | 全在 `[pi-sdk]` | 该组真的走 Pi 分支 |
| M3 | 撤掉 Codex 工具粘合（dispatchCodexExternalToolCall 直接 fail） | 4 | 4 | 全在 `[codex-sdk]` | 该组真的走 Codex 分支 |
| M4 | **取消接线失效**（harness `interrupt` 不 abort 任何信号） | 6 | 6 | 三家各 2 条 | **取消断言真的在验取消** |
| M5 | 打开 provider 围栏（SUPPORTED + 宿主 registry 都收任意 id） | 3 | 3 | 负控组 | `SUPPORTED` 真的在拦 |
| M6 | 关掉工作区围栏（`pathWithin` 恒 true） | 2 | 2 | 负控组 | 围栏真的在拦 |

全部变异：源文件逐字节还原（`cmp` 校验，`git diff` 为空）；无残留 `MUTATION:` 标记。

**M4 为什么是 6 而不是 9 —— 这不是断言没验到，是一条独立的第二道闸：**
撤掉 abort 后，每家仍绿的第三条是「文档盘上仍是原文」。原因是 `docsAiPorts.dispatchDocsAiTurn`
的 `emit` 自身也查 `signal.aborted`（不把任何 chunk 交给渲染端），订阅回调也在
`signal.aborted` 时早退——**没有 `done` chunk，渲染端就不会请求 save**。而「渲染端执行了
replace_blocks」与「tool.result 不是 success」这两条**都红了**，说明禁止的写入确实发生了
（文档内存态被改），只是落盘被第二道闸拦住。第一道（host 工具派发闸）与第二道（chunk 闸）
各守一半，是纵深防御，不是死断言。

**M5 的一个额外实测（记录，不"修"）：** 只改 `SUPPORTED`、不动宿主 registry 时是 **0 红**。
因为 `resolveDocsAiSession` 还要求 `providerRegistry.get(providerId)` 非空，而生产
registry（`registry.ts:93-95`）恰好只注册这三家——同一道围栏的第二处。所以 M5 必须同时
打开两处才会红；这不是判据弱，是**围栏本身就是两道**。

### 7.5 一个被这套件自己抓出来的假绿（已修）

第一版 `FakeDocsRenderer.save()` 无条件写盘，于是「中途报错 → 未落盘」在
「save 把原文原样写回」时**也成立**——代理指标（盘上字节）失效的那类输入（硬规矩 28）。
补上 vendor 真实存在的脏检查（`App.tsx:5386-5396` 的 `!anyDirtyRef.current` 早退）后，
该断言改成「文档未改 **且** save 从未被请求」，并给正常流配了「save 恰好执行一次」的正控。
改完后它还立刻红了一次（`saveCalls:1`，因为 save 被请求但被脏检查挡下 = 0 次写入），
促成了 `saveRequests` / `saveCalls` 两个计数的区分。

**提交 SHA：`e77fe9f1`**（8 个文件，1452 行新增；`git show --numstat` 核对无越界路径）。

### 7.6 验证命令与结果

```
pnpm test:smoke o1-three-provider-ai-smoke   → o1-three-provider-ai-smoke: 46/46 通过（exit 0）
npx tsc --noEmit -p apps/desktop/tsconfig.json   → 仅剩 6 条错，全部在
    apps/desktop/scripts/o0-format-fidelity-smoke/（另一会话在途的 O0 目录，非本卡文件）
npx tsc --noEmit -p packages/contracts/tsconfig.json → exit 0
```

（用排除 O0 目录的临时 tsconfig 复核过：本套件与全部被改文件 0 错误。）

### 7.7 一句话结论（卡 §四要求）

**三家在「流式 chunk / 工具调用协议 / 工具结果形状 / 错误信封 / 取消」五点上确实完全不同；
现有适配层三家都吃下去了** ——正常流文档被改并落盘，中途报错不静默成功，取消后即使 SDK
竞争性送达 tool_use 也不写盘。**没有发现哪一家「形状没被正确处理」。** 另有两处边界如实记录：

1. **取消后「文档没被改」由两道闸共同保证**（host 工具派发闸 + docsAiPorts 的 chunk 闸）；
   撤掉第一道时，内存态仍会被一个竞争送达的 tool_use 改掉（M4 证明了这一点），
   但落盘被第二道拦住。若将来有人删掉 chunk 闸，取消语义会从「不写盘」退化成
   「写进内存但没落盘」——用户可能看到编辑器内容闪一下变化。
2. **`docsAiPorts` 的围栏是两道**（`SUPPORTED` + registry 注册），单改一处不会失效——
   这是有意的纵深，但意味着「改 SUPPORTED 加一个 provider」并不足以让新 provider 可用。

### 7.8 未做的事 / 觉得不对但没改的

- **没有真调任何 API**（本机无凭据，卡 §三明令）。替身按真实协议形状驱动，验的是适配层；
  真模型的行为（工具参数是否合法、会不会一轮发多次 tool_use）不在本卡范围。
- **`codex-sdk` 的取消路径**：替身**故意没调** `markAborted()`（那是适配器自己的丢弃逻辑），
  以验证 host 的取消闸独立生效。生产里 Codex provider 会先 `markAborted()` 再
  `finalizeAborted()`——真实运行时第一道是适配器丢弃、第二道才是 host 闸。卡里要的是
  「host 的取消行为」，这里验的就是 host 侧。
- **`t0-genoffice-native-tool-roundtrip-smoke` 与 `genoffice-ai-ask-smoke` 未改动**，
  本卡只在 `docsAiPorts` 外层加新证据。
- **未跑全量**（按仓库规矩需总控批准）。

---

## 2026-10-25 增补：停止请求后仍可触发原生编辑工具的竞态修复

这属于 O1 已验过的「取消后不再改动」判据的**额外并发入口**，因此回写到现有 O1，不新造同根因任务。

**旧代码真实红例 A**：用户 abort `docsAiPorts.run` 后，SDK 的 `handle.interrupt()` 已被调用但 `handle.done` 尚未 settle；此时 SDK 又发一个有效 `replace_selection`，`createNativeEditorToolBridge` 的请求级 AbortController 直到 `finally` 才触发，因此渲染端被调用 **1 次**且结果竟是 `success`。新断言原实现 `t0` 输出 **55/56 PASS**，具体红例 `status: success, rendererInvocations:1, interrupted:1`。修复：在 `apps/desktop/src/main/document/docsAiPorts.ts` 的中止回调里先同步中断请求级工具桥，再请求 SDK interrupt；`finally` 的清理仍保留。

**旧代码真实红例 B**：工具校验结束，但尚未执行 `Promise.resolve().then(...invokeRendererTool)` 的微任务时用户取消；旧代码 ACK 虽为 cancelled，仍调用了编辑器 **1 次**。第二断言旧实现 `t0` **56/57 PASS**，`status: cancelled, queuedRendererCalls:1`。修复：`nativeEditorToolTransport.ts` 在异步派发前再次检查请求与 SDK 工具调用两路 `AbortSignal`，直接返回取消而不调用渲染端。

**修复后的测试**：`t0-genoffice-native-tool-roundtrip-smoke` **57/57 PASS**，包含两项专门判据（执行计数必须 0，而非只检查 cancelled 回包）。`o1-three-provider-ai-smoke` 原本三家 **46/46 PASS**，`genoffice-ai-ask-smoke` 与新增 `o7-coverage-smoke` 同批四套 smoke **4/4 PASS**。Mcode Desktop/Contracts 双包 TypeScript 检查 0。所有测试使用隔离协议替身与受控内存编辑器，无真实账号/文档写入；未声称真实在线 SDK 消耗额度的 U1 已完成。
