# ARC-006 节点统一审计（Mcode `mcode-*` ↔ Node-RED 5.0.8 内置）

> 用户要求：「mcode 的一些节点应该会和 node red 的节点有重复，重复的你可以整合到一起。」
>
> 本文件是逐项对照与落地记录。**判据**：内置节点能表达同一语义（可配置、可维护、不丢关键行为）就
> 直接用内置；只差一层包装（参数改名、产物形状对齐）就「包装内置」；内置表达不了宿主身份/审批/
> 持久挂起这类语义才保留自定义，并写明理由。
>
> 取证：`node-red@5.0.8` 的 `@node-red/nodes/core/**`（本机 `.tmp/nr-e2e` 安装树实读源码）；
> Mcode 侧：`workflowEngines/mcodeNodePack.ts`、`mcodeNodeTypes.ts`、`flowMigration.ts`。
> 本轮真引擎回归：`mcode-node-pack-smoke`（真 node-red，7 类型全链）与 `flow-migration-smoke`。

## 一、逐项对照

| Mcode 节点 | 最接近的内置节点 | 语义差异 | 结论 |
|---|---|---|---|
| `mcode-agent` | `function`（仅作为"处理一步"的容器） | 内置 function 跑 JS，**不会**创建子会话、调三 SDK、走审批/runStore；agent 的指令、能力、产出变量都是 Mcode 语义 | **保留自定义**（执行体经 Host RPC；MERGE-3 的唯一边界） |
| `mcode-conversation` | 无（`function` 无法触达"用户正在看的那个对话"） | 必须复用主对话回合通道（MERGE-0 未知语义 #1）；Node-RED 消息流没有"主对话"概念 | **保留自定义**（身份/挂起待产品裁决） |
| `mcode-branch` | `switch` | `switch` 只能按值匹配自动分流；Mcode 的 branch 要**挂起等真人**（`decider: user`）或由模型选边，且"未选中的支路整体作废"是调度器语义 | **保留自定义**（人工选择挂起，MERGE-0 #2） |
| `mcode-trigger` | `inject`（手动/定时）、`watch`（文件变化） | 见下节：手动/定时/文件**已并入内置**；只有「Mcode 应用事件」一类内置没有 | **收窄为仅事件订阅**（本轮已改） |
| `mcode-code` | `function`（JS）、`exec`（其它语言） | JS 已走 `function`；python/shell/powershell 本质是"起一个进程" → 可映射 `exec` + 解释器前缀（本轮已改） | **删除自定义**：`node` → `function`，其余 → `exec` + 前缀 |
| `mcode-module-capability` | 无 | 调用 Mcode 宿主模块能力（moduleId/contributionId/path + 宿主授权） | **保留自定义**（宿主能力面，内置无对应） |
| `mcode-node-red-call` | `http request` | 内置 `http request` 可发 HTTP，但**没有回环端口围栏**（只许 127.0.0.1 + 本引擎端口）、没有执行器状态机与失败分类 | **保留自定义**（围栏 + 失败分类；也可视为"包装内置"的目标，见未做清单） |

### 已确认不与自定义重复的三项

| Mcode runner.kind | 内置节点 | 确认方式 |
|---|---|---|
| `condition` | `switch` | 迁移器 `NODE_RED_TYPE_OF_RUNNER.condition = "switch"`；自定义节点包**不注册** condition。已补最小可执行规则（`msg.mcode.condition` → true/else 两口）与两端口修正（真引擎实测） |
| `command` | `exec` | 迁移器映射 `command → exec`；节点包不注册 command |
| `code`（JS） | `function` | 迁移器对 `language === "node"` 映射 `function`；仅非 JS 语言此前落 `mcode-code` |

## 二、本轮实际整合

### 1. `mcode-trigger` 收窄：手动 / 定时 / 文件 → 内置 `inject` / `watch`

- **迁移器**（`flowMigration.ts`）按触发器参数改映射：
  | Mcode `triggerKind` | 迁移产物 |
  |---|---|
  | `manual` | 内置 `inject`（`once: true`，手动/立即运行一次） |
  | `schedule` | 内置 `inject` + `crontab`（Mcode 的 5 段 cron 原样写入；Node-RED inject 支持 crontab） |
  | `file` | 内置 `watch`（`files` 取 `paths`，`recursive` 取参数） |
  | `event`（及未知） | `mcode-trigger`（Mcode 应用事件订阅，内置无对应） |
- **节点包**：`mcode-trigger` 保留，但语义收窄为「宿主事件订阅」；`<type>.html` 说明同步。
- **报告**：schedule/file 迁移进 `lossy`，点名「合并窗口 debounceMs / 项目 id / 事件筛选」由内置节点无法表达的字段落在哪（保留在 `x-mcode.params`，执行侧将来由 Host 承担）。

### 2. `mcode-code` 删除：非 JS → `exec` + 语言前缀

- **迁移器**：`code` 统一映射 `exec`：
  - `language: "node"` → `function`（JS 原生，保持原样）；
  - `python` / `shell` / `powershell` → `exec`，`command` 前缀分别为 `python -c` / `sh -c` / `powershell -Command`，脚本正文按 Node-RED `exec` 的 `addpay`/`append` 约定放在 `msg.payload` 或 `append`。
- **节点包**：移除 `mcode-code` 注册与 HTML（`MCODE_NODE_PACK_TYPES` 从 7 → 6）。
- **报告**：`needsHumanDecision` 的 MERGE-0 #3（语言面不等价）保留 —— 现在它描述的是 `exec` 的沙箱面与 Mcode code 节点不同，而**不是**"自定义节点替身"。

### 3. 未合并（保留自定义）及理由

- `mcode-agent` / `mcode-conversation`：须经 Host RPC 走三 SDK、主对话通道、审批与 runStore —— 内置 `function` 无法表达；
- `mcode-branch`：人工挂起 + "未选中支路作废"是调度器/持久日志语义，`switch` 只有自动分流；
- `mcode-module-capability`：宿主模块能力面（授权、项目围栏）；
- `mcode-node-red-call`：回环端口围栏 + 失败分类（内置 `http request` 两者都没有）。

## 三、迁移器映射表（改后）

| runner.kind | Node-RED 类型 | 备注 |
|---|---|---|
| `prompt` | `mcode-agent` | 自定义 |
| `conversation` | `mcode-conversation` | 自定义（身份待裁决） |
| `branch` | `mcode-branch` | 自定义（人工挂起） |
| `condition` | `switch` | 内置（本轮补最小规则 + 两端口） |
| `trigger` | `inject` / `watch` / `mcode-trigger` | 按 triggerKind 分流（本轮改） |
| `command` | `exec` | 内置 |
| `code` | `function`（node）/ `exec`（其它语言） | 本轮删 `mcode-code` |
| `module-capability` | `mcode-module-capability` | 自定义 |
| `node-red` | `mcode-node-red-call` | 自定义 |

## 四、测试与证据

- `flow-migration-smoke`：新增 trigger 分流（manual/schedule/file/event）、code 语言分流（node→function、python/shell/powershell→exec+前缀）断言；未知字段、round-trip、备份断言不变。
- `mcode-node-pack-smoke`：注册类型数由 7 → 6；真引擎全链改为「trigger(事件) + conversation + agent + branch + switch + code(JS→function) + exec + module-capability」仍需整组启动并各执行一次。
- 禁改项未动；`registry.ts` / `runtimeSupervisor.ts` 零改动。

## 五、未做清单

- `mcode-node-red-call` 与内置 `http request` 的进一步合并（需要先给 `http request` 加回环围栏/失败分类的包装层，属后续切片）；
- `mcode-trigger` 事件订阅目前只保留接口（假 port 模拟），真实应用事件源未接；
- 内置 `inject` 的 `crontab` 与 Mcode 5 段 cron 的时区/秒级差异未做逐字段核对（本轮只做形状映射并在 `lossy` 点名）；
- `exec` 的语言前缀只覆盖 python/shell/powershell 三档；解释器路径/虚拟环境属 Host RPC 的配置面。
