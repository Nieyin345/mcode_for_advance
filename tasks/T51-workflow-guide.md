# T51｜给模型「工作流怎么搭」的规范（对齐 T47 的设计指南）

- Status: **done（2026-10-23 验收通过：33/33，提交 `a2041247`）**
- Category: feature（P0 产品能力）
- Depends on: T47（文档侧的同形卡，已完成）、T48（已关闭：节点工具一直存在）

## 补记：这张卡是总控漏写的

派活时只在消息里说了，没有写卡文件。B 会话按「卡只能由总控写」的规矩**没有擅自建卡**，把回写放在了消息里。**这是总控的疏漏。**

## 实测结论（B 会话，总控核实）

### 一、Mcode 内置节点的说明**本来就不缺**

```bash
grep -n "workflow.nodeTypes" apps/desktop/src/main/appControl/policy.ts
# → "workflow.nodeTypes": "read"     ← 模型经 app_api_call 就够得着
```

`nodeTypes.ts` 里每个内置节点的**每个参数都有 `help`**，每个节点还有大段 `usage`（`mcode.conversation` 那段有 8 段：什么时候用 / 什么时候别用 / 上下文只增不减 / 跑的时候对话被占住）。

**所以「模型不知道内置节点怎么用」不成立。**

### 二、Node-RED 原生节点的帮助可以复用，但不在主 HTML 里

| 查了什么 | 结果 |
|---|---|
| `core/**/*.html` 的 `defaults: {}` | 有（36 个），但 **11 个混着 `function(v,opt)` validator**，正则解析不可靠 |
| `core/**/*.html` 的 `data-help-name` | **0 个** |
| **`locales/en-US/**/*.html` 的 `data-help-name`** | **49 个节点 / 36 个文件**，纯 HTML，质量很高 |

inject 的帮助里连 cron 陷阱都写了：「20 minutes will be at the next hour」。

## 方案：C（混合），但两半来源不同

- **节点说明走 A**：直接取 Node-RED 的 `locales/en-US` 原文，**不重写**（重写会漂移、也不权威）；
- **方法论走 B**：Node-RED 的帮助只讲单节点输入输出，**不讲「一条 Mcode 工作流该怎么组织」**——那是 Mcode 的产品判断，上游没有。

**不选纯 A**：上游没有「怎么搭一条流」的方法论。
**不选纯 B**：自己重写 49 个节点的说明既会漂移又不权威。

## 交付

新模块 `orchestration/workflowGuide.ts` + 新工具 `workflow_guide({topic, node})`：

| topic | 作用 |
|---|---|
| `design` | 怎么组织一条 Mcode 工作流（Mcode 方法论） |
| `debugging` | 出错了怎么查 |
| `nodes` | 列 49 个 Node-RED 节点 |
| `nodes` + `node:"inject"` | 单个节点的原文帮助 |

## 套件：33/33（真读 Node-RED 文件，无 mock）

- 49 个节点、`problems.length === 0`（**没跳过任何文件**）；
- inject 帮助里断言了**只在上游原文里才有**的 cron 陷阱句子；
- 负控：未知节点 / 未知主题 / 读不到目录 —— 全部显式报错。

**变异**：`--mutate=empty-help` → **3 条红**，形态是「根本取不到」而不是「内容不对」。

**回归**：app-control 574/574、T43 57/57、T47 27/27、extension-authoring 24/24；双包 typecheck 通过。

## 顺带修掉一个真缺陷（否则这次交付会被藏起来）

加 `workflow_guide` 后 **app-control 立刻变红 573/574**：「描述符与工具表一致」。

**根因**：`engineTools.ts` 的 `isAppToolName` 是「前缀在 `app_`/`document_`/`extension_` 里 **且** 在表里」——**前缀门挡在表成员资格前面**，新前缀 `workflow_` 就被 Codex dispatcher 判为「不是 app 工具」。

**修法不是再补一个前缀**（T24/T20 已经各踩一次这个坑），而是**去掉前缀门**，让表本身就是白名单。

B 的原话：

> 判据是表成员资格，不是前缀猜名。**前缀门只是叠在它上面的一层冗余，并且是唯一会漏的那一层。表本身就是白名单：不在 `appMcpTools()` 里的名字一律 false。**

**安全边界已核实**：`isAppToolName` 唯一生产调用点是 Codex 兜底分派，它调的 `invokeAppTool` 第一行就是 `appMcpTools().find(...)`，查不到直接拒绝。**前缀门是冗余的，去掉不扩大任何能力面。**

## 未做的（B 会话列出，总控认可）

1. **没把 Node-RED 的 `defaults` 参数表给模型** —— **11/36 混着 validator JS，正则解析会给出错误的参数说明**。要做得上 AST，**另开卡 T56**。
   - **「会给出错误的参数说明」比不给更糟**：模型会照着错的参数写，然后 `workflow_save` 拒绝，而它不知道是被误导了。
2. 没覆盖第三方节点包（用户自己装的），只扫仓库内快照。
3. 没验证真 Electron 里模型能否调用 —— 与 T47 同一边界，需要真模型回合。

## 一个已有红（与本卡无关）

`approval-bridge-parity-smoke` 报 `ReferenceError: dispatchCodexExternalToolCall`。B 用 **HEAD 版本的 `engineTools.ts`** 复跑过，同样红，`cmp` 逐字节还原确认与本次改动无关。

看起来是该套件的 eval 桩没跟上 `nativeToolProtocol.ts` 里新导出的符号。**转 T55。**
