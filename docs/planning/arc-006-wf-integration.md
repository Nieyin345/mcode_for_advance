# ARC-006 WF-INT —— 把成熟工作流引擎作为第三方内核集成（Node-RED 为首个目标）

> **这份文档是什么**：用户明确要求「像集成 GenOffice 一样集成成熟工作流」，即把
> Node-RED 这类**完整运行时 + 编辑器 UI** 接进 Mcode，而不是只借它的节点语义。
> 本文是这条路的可执行方案：范围、宿主架构、权限边界、阶段与验收门。
>
> **它不是什么**：不是"已经在用 Node-RED"的声明。当前 `node-red` 未进依赖
> （npm 实查 5.0.8 / Apache-2.0），没有任何代码落地。ARC-006 状态仍双空。
>
> ## ⚠️ 已被覆盖（2026-10-18，用户决策）
>
> 用户随后明确选择「**合并，直接复用 Node-RED，并在它的源码上添加 Mcode 原有功能**」。
> 台账 `Mcode_统一审查台账.md` 的「用户最终架构更正（Node-RED 为唯一工作流内核，
> 深度合并）」是**当前最终架构**，其 MERGE-0～5 阶段与验收门取代本文的「双引擎 + 三桥」。
> 本文以下内容降级为**迁移过渡记录**：NR0/NR1/NR2 与 `runtimeSupervisor` /
> `workflowEngines/registry` / `nodeRedExecutor` 仍是可复用的地基，但「两个引擎各自
> 运行、通过桥互通」不再是产品完成标准。继续落地前先读台账那一节。

## 一、为什么这个方向成立（与 GenOffice 同构）

GenOffice 的集成方式给了三块可复用的地基，且都已在仓库里：

| 地基 | 位置 | 在 Node-RED 集成里的用途 |
|---|---|---|
| 受控 `WebContentsView` 宿主 | `main/document/documentViewHost.ts` | 嵌入 Node-RED 编辑器 UI（`http://127.0.0.1:<port>/`） |
| 可拨通的回环端口 | `main/lib/loopbackPort.ts` | 给 Node-RED 运行时分配端口（避开 fetch 黑名单端口） |
| 受控子进程 | `main/lib/spawnRun.ts` | 以**独立进程**起 Node-RED 运行时，env 完全替换、不继承宿主 |
| 最小 preload 桥 | `main/document/documentViewPreload.ts` | 只给编辑器页面它需要的桥，不给 ipcRenderer |
| 外部 MCP 接入 | `main/mcp/genofficeMcp.ts` | 把运行时能力以 MCP 工具面交给三引擎 |

差别只有一处：GenOffice 我们只用了它的 CLI（无头轨），**Node-RED 要的是它的运行时
和编辑器**两者都有。所以多一条「运行时进程生命周期」，其余同构。

## 二、目标架构

```
Mcode Electron 主窗口
├─ 工作流面板（现有画布 / 运行历史 / 审批）
│   └─ 新增「第三方引擎」标签页
│       └─ WebContentsView（DocumentViewHost 的同类宿主，或复用浏览器面板）
│             └─ Node-RED 编辑器 UI（http://127.0.0.1:<port>/）
└─ 主进程 RuntimeSupervisor（新）
    ├─ 进程：以 spawnRun 起 `node-red`（独立进程、独立 cwd、自己的 data dir）
    ├─ 端口：loopbackPort 分配，就绪探测（HTTP 200 + /settings）
    ├─ 数据：`<dataRoot>/workflow-engines/node-red/`（flows.json / creds / 节点）
    ├─ 生命周期：start / stop / restart / 崩溃检测 / 退出时清理
    └─ 治理：
        ├─ 只看不跑：编辑器里画的流不自动执行（Node-RED 的 deploy 仍由用户点）
        ├─ 执行入口统一：Mcode 侧只允许经 `workflow.*` 审批过的动作触发
        ├─ 网络：Node-RED 只能绑 127.0.0.1；出站走 Mcode 代理/白名单
        └─ 凭据：Node-RED 的 creds 加密密钥由宿主注入，不进仓库/日志
```

### 关键取舍（逐条写清，不偷偷夹带）

1. **不把 Node-RED 塞进 Mcode 的 node_modules 主依赖树**。它是**可选能力**：
   没装/没启动时，工作流面板显示「第三方引擎未安装/未启动」并给安装指引，
   而不是让整个工作流功能失败。与 GenOffice 的 `capabilities()` 同一取向。
2. **不合并两套调度器**。Node-RED 的流在**它自己的进程**里跑；Mcode 的工作流
   仍在 `orchestration/runner.ts`。两者通过**明确的桥**交互（见第三节），
   而不是把 Node-RED 的 node 类型塞进 `NodeRunnerSchema`。
3. **编辑器 UI 不进入 Mcode 的渲染端依赖**。它跑在 Node-RED 自己的 HTTP 服务上，
   Mcode 只是宿主一个视图 —— 与 GenOffice 编辑器页完全同一种做法。
4. **`ee/` 类风险**：Node-RED 核心是 Apache-2.0，但**社区节点**各有许可；
   安装任何外部节点必须逐个核对（沿用 WF0 的审计方法）。

## 三、两套系统的桥（这是本方案最关键的部分）

三种桥，按优先级：

### 桥 1：Mcode → Node-RED（触发流）
Mcode 工作流的一个节点（新 `runner.kind = "node-red"`，或复用 `command`）向
Node-RED 的 HTTP-in 端点发一个请求：
- 端点 URL、方法、载荷由节点参数给；
- 只允许 `127.0.0.1:<runtimePort>`（复用 `checkDocumentViewUrl` 的回环判据）；
- 结果（HTTP 响应）成为节点产出，交给下游。

### 桥 2：Node-RED → Mcode（流里调用 Mcode 能力）

**方案修订（2026-10-18，实现前定稿）**：**不再新开回环 HTTP 端点**。

原方案想在 Mcode 侧加一个「仅回环 + 一次性令牌」的 HTTP 端点，背后接
`invokeAppTool`。复核后否掉，理由三条：

1. **审批需要会话上下文**：`invokeAppTool(name, args, sessionId, ctx)` 的审批走
   `ctx.requestApproval` —— 那是**某个 Agent 回合**的通道。引擎进程没有回合，
   新端点要么伪造一个 `ProviderContext`（等于绕过审批的真实性），要么把危险操作
   降级成"无审批执行"。两条都不可接受。
2. **多一条网络面 = 多一份要审计的鉴权**：一次性令牌要生成、轮换、防重放、防同机
   其它进程窃取。而这些事 MCP 面**已经做完了**。
3. **MCP 面本来就是给"外部工具"用的**：用户装一个 MCP server 是为了让 Agent 调到它；
   反过来也一样 —— 引擎要调 Mcode，最自然的位置是让引擎的流去调**它自己的** MCP
   客户端，而不是让宿主再开一个洞。

**⚠️ 进一步核实（同日）**：`mcode-app` 是 **Claude SDK 的进程内 server**
（`buildAppMcpServer` 用 `createSdkMcpServer` 构造，不监听任何端口/stdio），
**外部进程连不上它**。所以「让 Node-RED 指向 mcode-app」在当前形态下不成立。

可行的落法是**新增一个 stdio MCP server**（与 `genoffice mcp` 同一种形态）：
`mcode-host-mcp` —— 一个 `ELECTRON_RUN_AS_NODE=1` 起的小进程，它把请求通过
**宿主已有的本地 IPC/回环**转给主进程的 `invokeAppTool`，并把审批请求**转回
宿主 UI 弹卡**（人在看 Mcode 窗口，卡弹在那儿）。这才是真正"同一套审批"。

即便如此，它的能力面必须与 Agent 完全一致（同一份 `appMcpTools()` 表），
不多一个方法。于是：

- **同一套策略/审批/账本**，一行都不用新写；
- **危险操作仍要真人审批** —— 审批卡弹在 Mcode 里，引擎不能替用户点；
- 引擎侧没有"额外能力"：它能做的事与 Agent 完全一致，不多不少。

**宿主需要做的**只有一件：把 `mcode-app` 的启动参数（命令/args/env）以用户可复制的
形式显示在引擎面板里，让用户配进 Node-RED 的 MCP 客户端节点。这不需要新契约、
不需要新通道，**也不扩大能力面**。

**验证方式**：无头套件验「新 server 的工具表就是 `appMcpTools()` 的同一份」
「危险档仍要求审批通道，没有通道即 fail-closed」；真端到端（Node-RED 流真调 Mcode）
留 U1。

**当前状态（2026-10-18 更新）**：stdio server 的**纯逻辑核心已落地**
（提交 `13d0faeb`，`apps/desktop/src/main/mcp/hostMcpServer.ts`）：
`tools()` 就是注入的 `appMcpTools()` 同一份（引用相等），参数按工具自带
`inputSchema` 校验，危险/写档无审批端口一律 fail-closed，四类失败码可区分。
`host-mcp-server-smoke` 50/50（7 项变异真红）。

**仍未实现**：真实 stdio 传输（JSON-RPC 帧、stdin/stdout 生命周期、
`ELECTRON_RUN_AS_NODE=1` 进程形态）、stdio 进程 → 主进程的中继（转给
`invokeAppTool`、审批请求转回宿主 UI 弹卡）、`main/index.ts` 装配。
桥 2 因此仍处于设计阶段，NR4 未完成。

### 桥 3：共享事件（可选，后做）
Node-RED 的 webhook/定时器事件推给 Mcode 的自动化触发器（`automationRunner`），
或反向。第一版不做。

## 四、权限与安全边界（不可让步）

1. **运行时只绑 `127.0.0.1`**，端口由 `loopbackPort` 分配；不允许 `0.0.0.0`。
2. **进程 env 完全替换**（`spawnRun` 现有语义）：不继承宿主的 API key、token。
   只给：Node-RED 自己的 data dir、端口、`NODE_RED_CREDENTIAL_SECRET`（宿主生成）。
3. **节点安装是危险操作**：Node-RED 的「安装节点」等价于装可执行代码 ——
   Mcode 侧把它映射成 `danger` 级审批（每次真人确认），并**默认禁用**该按钮，
   除非用户在设置里显式开启「允许第三方引擎安装节点」。
4. **凭据不进 Mcode 的日志/导出**：Node-RED 的 `flows_cred.json` 是加密的，
   密钥由宿主生成并存在 data dir 外；导出工作流时不带 creds。
5. **执行审计**：每次经桥 1/2 的调用都进 `appControl` 的 operation ledger，
   用户能在 Mcode 侧看到「谁在什么时候触发了什么」。

## 五、阶段与验收门（未过门不进下一步）

| 阶段 | 内容 | 验收门 |
|---|---|---|
| **NR0 可行性** | 在隔离目录真起 `node-red`（`npm i node-red@5.0.8` 到临时目录），HTTP 就绪、flows.json 读写、编辑器页可加载 | 真进程日志 + 端口 + 页面截图；确认 Windows 下无原生编译依赖问题 |
| **NR1 运行时监管** | `RuntimeSupervisor`：start/stop/restart/崩溃检测/退出清理；`workflowEngines.*` IPC + 契约 | 无头套件用真进程验生命周期；崩溃后不残留孤儿进程；变异验证 |
| **NR2 编辑器嵌入** | 复用 `DocumentViewHost`（或抽通用 `EmbeddedViewHost`）挂 Node-RED 编辑器；URL 围栏只放行回环 | 真 Electron U1：编辑器可加载、编辑、deploy；关闭视图不杀运行时 |
| **NR3 桥 1** | Mcode 节点触发 Node-RED HTTP-in | 端到端：一张 Mcode 图 → 触发一条 Node-RED 流 → 返回值回灌；失败分类清晰 |
| **NR4 桥 2** | Node-RED 调 Mcode `app_api_call`（回环 + 令牌 + 同一审批） | 危险方法仍弹真人审批；令牌不可被其它本地进程冒用 |
| **NR5 治理与发布** | 节点安装审批、凭据隔离、导出、许可清点、UI 文案 | 许可审计通过；`ee/` 类风险排除；文档与设置页就位 |

**整包完成的定义**：NR0–NR5 全过 + 真 Electron + 真 Node-RED 进程 + 三引擎
至少一个引擎的在线回合；缺一项不勾 ARC-006 的「开发完成」。

## 六、与现有条目的关系

- **不新开 MC**：这是 ARC-006 的实现路径，不重复立单。
- **依赖 ARC-007 的宿主件**：`DocumentViewHost` 若抽成通用 `EmbeddedViewHost`，
  两处共用（文档视图 + 第三方引擎视图），避免第二份 `WebContentsView` 生命周期。
- **依赖 MC-035 的边界**：第三方引擎装节点 = 装可执行代码，必须沿用模块的
  网络/写权限声明与逐次审批，不得绕过。
- **不替代**：Mcode 自己的工作流调度器、用户交互节点（ask/branch/资料库）、
  审批与 revision 信任 —— 这些仍是本体，Node-RED 只是**被宿主管理的外部引擎**。

## 七、第一批动作（可立即做）

1. **NR0 可行性验证**（无副作用）：在 `.tmp/` 里 `npm pack node-red@5.0.8` 或
   临时 `npm i`，起进程、探端口、读写 flows.json，记录真实输出。
2. 读 `DocumentViewHost` 与 `BrowserManager`，决定是抽通用宿主还是复用浏览器面板。
3. 起草 `workflowEngines.*` 契约（start/stop/status/installNodes + 端口与 data dir）。

**边界**：本文只固定方案与验收门；NR0 之前的任何「已集成」说法都不成立。
