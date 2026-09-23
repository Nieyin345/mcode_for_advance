# 三引擎能力对照（2026-09-20 清点）

范围：Claude Code SDK / Pi / Codex 三家，加上一份渲染端全量扫描。
四份原始报告在 `.scholar_tmp/survey-{claude,pi,codex,ui}.md`。

**这份文件要回答的问题不是"哪家缺什么"**，而是：

> 哪些看着是三家各自的毛病，拆开一看其实是**同一处共用代码**的锅？

因为那才决定工作量。三家各修一遍是 3 份活，共用件修一处是 1 份活。

---

## 一、先看结论：共用件的锅（修一处，三家受益）

### 1. 设置页三块面板对所有引擎无条件挂着 ★最值得先做

`GeneralPanel.tsx:387/390/396` —— `<TurnBudgetPanel />`、`<FallbackModelsPanel />`、
`<OutputStylePanel />`，**一句能力位判断都没有**。

结果三家三种"填了没用"：

| 引擎 | 预算面板 | 回退面板 | 输出风格 |
|---|---|---|---|
| Claude | 能用（有原生旋钮） | 能用 | 能用 |
| Pi | **token 口径是会话累计**，越用越容易误触发；花费永远是空 | 宿主那层生效，provider 忽略 | 面板自己写了"仅 Claude 生效" |
| Codex | 只有 token 没有花费，**USD 上限永不开火** | 进程崩溃只报错不重试 | 同左 |

同一个坑的三个面。而且**同一个设置页里已经有对的做法**：
`SettingsPage.tsx:123` 用 `requiresCapability` 把"子代理"导航项按能力位滤掉了。
这三块没用同一套机制。

还有一条更直接的：回退链在自定义端点会话上被静默关掉
（`RuntimeManager.ts:934-940`，条件 `!session.customModelId`）——**配了自定义网关的人
正是最需要兜底的，偏偏对他关着，且关得没有一句话**。

### 2. 状态栏是按"只有 Claude"写的，却是三家共用这一根

- `claude:healthCheck`（`ipc/claude.ts:144`）探的是 **default provider**，却被
  `StatusBar.tsx` 当全局状态画 → 用 Pi/Codex 时状态栏红着 `claude not found`
- `MODEL_LABEL`（`StatusBar.tsx:13-18`）是 Claude 专属表（Auto/Fable/Opus/Sonnet），
  而 `default` 是所有引擎共用的"未选"值 → Pi/Codex 会话里显示 "Auto"
- `chat.approval.title` = `"Claude 请求执行工具"`、`chat.approval.question` =
  `"Claude 有一个问题需要回答"`（`zh/chat-composer.ts:78/92`）—— 这三张卡是三家共用
  的无条件实现（`ChatPane.tsx:3773-3836`），**Pi/Codex 会话照样显示 "Claude"**

### 3. 工作流提示词 + 节点上的「限定 MCP/插件/技能」只对 Claude 生效

- `req.workflowPrompt`：宿主每轮解析并传下去（`RuntimeManager.ts:1097/1126`），
  全仓只有 `ClaudeAgentSdkProvider.ts:1383` 读它 → **Pi 静默丢弃，Codex 忽略**。
  而契约专门为它改过一次，注释写着"差别缩小成 append 一个字符串"。
  最难看的是 `:1100` 那行日志还在打 `workflow active: xxx` —— **日志说反话**。
- 节点上的 `req.mcpServerNames` / `req.pluginNames` / `req.skills`
  （`RuntimeManager.ts:1110-1143`）三家一视同仁地填，Pi 和 Codex 从头到尾没读过。
  而节点检查器给用户渲染的 help 写着「限定本步骤可用的 MCP 服务器」。**用户勾了，不生效。**

### 4. 契约声明了一批能力位，渲染端从来没读过

全仓 grep（`renderer/` 大小写不敏感）：`supportsElicitation`、`supportsApproval`、
`supportsAskUserQuestion`、`supportsMcp`、`supportsResume`、`supportsStreaming`、
`capabilityIds` —— **全部零命中**。

读了的只有三个：`supportsFork`（`SidebarShared.tsx:113`）、
`supportsCustomSubagents`（`SettingsPage.tsx:123`）、`supportsInject`（`ChatPane.tsx:1547`）。

所以不是"全没用"，是**用了一小半**。没用的那一半里有一批是同一种形状：
声明了能力，界面不去问，直接按"三家都能"渲染。

### 5. 三家都犯了同一类 i18n 问题（方向还相反）

- Claude 侧硬编码**英文**：`StatusBar.tsx:47-48` 的 `claude not found` /
  `claude ready` / `checking claude…`（词典里从来没这三个 key）、
  `SdkMessageAdapter.ts:1777` 的 `?? "Unknown error"`、`:1755` 的 `Permission denied (…)`
- Pi 侧把 **SDK 原始错误串**摊给用户：`PiAgentSdkProvider.ts:456-462` 直接放
  `(err as Error).message`
- 同一份代码里别处又是硬编码**中文**

硬编码英文等于**绕过 `MessageId` 类型检查**，typecheck 抓不到。

### 6. 计划模式：三家共用同一个卡片和标记，行为却是三样

| 引擎 | Plan 模式下 | 界面文案 |
|---|---|---|
| Claude | **拒绝**写（严格只读） | "只读探索,所有写操作都需审批" |
| Pi | **弹审批让你决定**（`mcodeExtension.ts:327-334`） | 上面那句，逐字相同 |
| Codex | 只是提示词约束，sandbox 中途降不下来 | 同上 |

Codex 那份报告自己说这是**最该改的一条**——不是补实现，是**让界面说实话**。

---

## 二、各家独有的真问题（要分别修）

### Claude

| 问题 | 现象 | 位置 |
|---|---|---|
| `supportsAskUserQuestion` 恒 true | 模型问了个问题，界面**什么都不弹**，那句话消失在流里。在自定义网关+某些模型上必现 | `ClaudeAgentSdkProvider.ts:714`，注释许了"runtime 可以否定它"，但**那条路没写**。连带 `SdkMessageAdapter.ts:160-270` 整个 SentinelScanner 兜底是**死代码** |
| fork 不复制撤销历史 | fork 出来的会话往回撤只到自己 fork 之后 | `ClaudeAgentSdkProvider.ts:767-768` 注释自己承认，界面一个字不提 |
| 四件事失败用户看不到 | 点"批准"卡片还留着；点"回滚"文件没回滚。用户以为点漏了 | 四处只 `console.error`：`sessionStore.ts:10324/10303/10385/10593`。同一文件里 fork 失败**做了 toast** |
| `parseTurnBudget` 吞坏 JSON | 预算填了没反应 | `lib/turnPolicy.ts`，JSON 解析失败直接返回 undefined |

### Codex

| 问题 | 现象 | 位置 |
|---|---|---|
| 写死了 macOS 包名 | Windows/Linux 上**永远匹配不上**，还污染设置里"来源/是否安装"的显示 | `codexBinaryResolve.ts:159` 去找 `@openai/codex-darwin-arm64`，而本该用同一个函数 `:111` 已算好的 `pkg` |
| 两份文件头说反了 | 留一句跟代码相反的话比没注释更带偏人 | `CodexAppServerClient.ts:21` 说 per GUI session，`CodexAgentSdkProvider.ts:35` 说 per TURN。**真身是 per TURN**（`:327` 建、`:601` dispose） |
| 结构化输出无调用方 | 没现象——压根走不到 | 实现了，全仓无生产者 |
| `supportsElicitation` 是没人读的旗标 | — | 但 Codex 明明实现了（`:816`） |

### Pi

| 问题 | 现象 | 位置 |
|---|---|---|
| 结束原因永远是「正常结束」 | 被长度截断（说一半停住）显示成正常完成，还弹"回合完成" | `PiMessageAdapter.ts:507-511` 无条件 `return "end_turn"`。**SDK 明明报得出来**（`pi-ai/dist/types.d.ts:282` 有 `length`/`toolUse`），那句"Pi 不区分"的注释不成立 |
| bash 写的文件不进「本轮修改」卡片 | 助手用 `sed -i` / `echo >` 改的文件，卡片里没有，**撤销本轮也恢复不了** | `mcodeExtension.ts:284` 只挂在 write/edit 分支。Claude 侧靠 `FILE_MUTATING_TOOLS` 集合判，而 bash 在 Pi 这边是合法的写文件手段 |
| 「Max」档选得出来、配不了 | 选了 Max 某些模型毫无变化，模型配置里也没地方配 | 声明 8 档（`PiAgentSdkProvider.ts:83-92`），但 `PI_THINKING_KEYS` 只有 6 个 |

---

## 三、值得注意的"做了但到不了"

这一类不是 bug，是**白做的功夫**：

1. **结构化输出**：Claude 实现了原生 + 降级两条路（`:870-877`），
   `SdkMessageAdapter.ts:1664-1677` 连"格式不对"的中文卡片都写好了 —— **全应用没有一个调用方**。
   Codex 有完整实现，同样无调用方。Pi 是唯一真走了这条路的（靠提示词+解析）。
2. **`turn.done` 的 reason 分流**：`NotificationManager.ts:129` 和
   `sessionStore.ts:8862` 都写了 `reason === "tool_use"` 分支 —— Pi 永远走不到（恒 `end_turn`）。
3. **`supportsElicitation` / `supportsApproval` / `supportsAskUserQuestion`**：
   契约里声明了是为了让界面知道"该不该给用户看这个"，现在声明了没人读 = 装饰。

跟用户提过的 `library.fullTextSearch` 是同一个形状。

---

## 四、还没定的（需要产品判断或下一步验证）

1. **Pi 其实能插话**，`supportsInject: false` 是"没接"不是"做不到"。
   `sendUserMessage(content, {deliverAs:"steer"})` 正是契约里 `inject` 的语义，
   provider 一处都没调（grep `steer` 零命中）。**要不要接是产品判断。**
2. **Claude 的 `turn.done` 会不会给出 `max_tokens`** —— 只看到它从 `stop_reason` 透传，
   没法确认 CLI 实际上报的取值集合。这条要定了，"Claude 看得出截断、Pi 看不出"才是完整对比。
3. **浏览器只读清单有两份手抄**：`mcodeExtension.ts:135-145` 与 `providers/toolGate.ts:56-66`
   今天逐字相同（9 个名字），但增删一个漏改一处，就会出现"同一操作 Pi 要审批、Claude 不用"。
   `toolGate.ts` 是共用件。
4. **Max 档是否真落到 SDK 默认值** —— 没查到 pi-ai 的 provider 默认思考参数，是推论。
5. **`thread/start` 的 sandbox（kebab）与 `turn/start` 的 sandboxPolicy（camelCase tagged object）**
   两套拼写 —— 代码注释自述如此，没在活的 app-server 上验过。

---

## 五、界面上的通用毛病（渲染端扫描的结论）

- **"引擎清单"在渲染端抄了 6 份**（`engineFilter`、`SkillsPanel`、`ContextPanel`、
  `hooksView`、`CustomModelsPanel`、`McpPanel` 的内联联合），**没有一处是单一事实源**。
  约 55 处引擎判别点里，**该分的约 17 处、债约 30 处、半债约 8 处**。
- **同一个引擎三种叫法**：Agent/MCP/模型配置页写 "Claude"，上下文页写小写 `claude`，
  技能页只写字母 "C"。
- **Codex 的工具卡一张都不折**，时间线上类别徽标全是「其他」、图标全是通用机器人 ——
  三张表只列了 Claude + Pi（`MessageBlocks.tsx:237-247`、`turnFlowModel.ts:200-227`、
  `MessageBlocks.tsx:1756-1781`）。
- **用哪家引擎，输入框都写 "Claude is working…"**（`ChatPane.tsx:4130` 硬编码英文）。
  紧挨着的 `:4134-4138` 反而是按 `canInject` 挑 i18n 键的正确写法。
- **「用 AI 解决冲突」的模型下拉只列 Claude 网关模型，选完开出来的是 claude-sdk 会话**
  —— 选项和实际执行不是一回事（`GitPanel.tsx:63-76` + `MergeConflictResolveDialog.tsx:124`）。

**好消息一条**：不支持的能力**要么不显示、要么藏起来**（chip 消失 / 菜单项消失 /
设置入口消失），逐条核过，**没有一处是"显示了、点了没反应"**。
唯一的例外是未来引擎 —— `ProviderDropdown.tsx:74-79` 对未知 provider 直接 `return true`。

---

## 六、一句话

换引擎之后，用户能感觉到的只有**输入框多打一个错字**和**侧栏那颗 chip 换了图标名字**。
界面上的差异都是"少一颗按钮 / 多一列开关"，**没有任何一行字解释为什么不一样**
—— 而且现在还被两条盖着：不管换哪家，输入框都写着 Claude，状态栏都在报 Claude 的探测结果。
