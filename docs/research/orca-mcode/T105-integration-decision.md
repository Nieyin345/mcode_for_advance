# T105｜Orca→Mcode 六域源码证据汇总与首个优化切片选型

> 汇总日期：2026-10-22。此报告是基于六份已提交的静态源码研究形成的决策建议，不是产品实现验收。

## 1. 基线与证据边界

- Orca 固定源码：`ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`，报告所记录版本字符串为 `1.4.214`。本次复核时 `git -C orca rev-parse HEAD` 仍为该 SHA，`git -C orca status --short` 为空。
- Mcode 当前复核 HEAD：`19330333760c4211705eeaf63e33695229ec3649`。工作区另有未提交修改及一个 Git status 显示异常的未跟踪路径；本报告未修改、暂存或清理它们。
- 六份报告均明确以固定 Orca 源码和 Mcode 源码调用链为主要证据，属于 E2 静态证据；故障时序/未执行反例属于 E3。六份报告均未运行真实 Electron、在线 SDK、SSH 或 U1 用户旅程。不能将源码存在、历史 Smoke 或 Orca 的功能宣传写成 Mcode 的动态通过结论。

| 领域 | 已提交报告 | 主要结论 | 证据边界 |
|---|---|---|---|
| Worktree / 项目身份 | [T99](T99-worktree-lifecycle.md)；报告提交 `3d8f59b39390e78ab5c5545062b3a39d36939b78) | Mcode 已有创建、dirty guard、merge-back、patch 导出与 stale worktree 清理；缺少持久化 checkout 实例代次，路径被删除后重占存在旧 session 身份混淆风险。 | E2 调用链；竞态未动态复现。 |
| Agent Runtime / PTY | [T100](T100-agent-runtime-pty.md)；报告提交 `e5da8d2ff7af2e3f248b346d50e2e4def8d70a65) | Mcode 三 SDK 的原生 provider/审批/取消语义已有统一 Host seam；集成终端没有在所查路径中证明 Orca 式 daemon attach、持久 checkpoint 和背压。不要把三 SDK 强行改成常驻 child。 | E2/E3；未跑 PTY/SDK 测试。 |
| Git Diff / Review | [T101](T101-diff-review.md)；报告提交 `2bcad370da1867f6745aff49f66635a354c17910) | Mcode 已有 staged/unstaged diff、历史 diff、快照回退与 merge-back；branch-vs-base OID compare 和安全行级批注闭环未被当前源码证明。另发现 merge-back ownership probe 的 fail-open 静态高风险。 | E2/E3；未动态复现。 |
| Remote CLI / Host | [T102](T102-remote-cli.md)；报告提交 `9100e65678c9c0b73dde5c98f3f007f4660dea09) | Mcode 已有受信 SSH 短命令/远程 job 和手机访问本机的 Relay；它们不等价于结构化的远端 workspace runtime。若未来实现，Host、workspace、execution environment 必须分开建模。 | E2/E3；未连接真实 SSH。 |
| UI / UX | [T103](T103-ui-ux.md)；报告提交 `2675463d9c206f4518987cd3443e565e04a4ff73` | Mcode 已有三栏布局、面板保活、当前会话活动汇总、流程状态和审批焦点门禁；可借鉴跨工作区活动信息架构与可测试的焦点切换契约，不应整套移植 Orca Terminal Portal。 | E2/E3；真实 UI/键盘/读屏 U1 未做。 |
| IPC / Extensions | [T104](T104-ipc-extensibility.md)；报告提交 `13ad37404038e20c63946f710350656985f2bbd9` | Mcode 已有 `app_api_list → app_api_describe → app_api_call`、IPC contract、ModuleHost grants、审批与 workflow trust；扩展调用入口有进一步收敛空间。Orca 默认 YOLO/full-access 与 Mcode fail-closed 原则冲突，不能照搬。 | E2/E3；未运行测试或真实扩展。 |

各任务卡结果回写提交分别见 T99 `6493e55b`、T100 `06bfe758`、T101 `6aa11098`、T102 当前结果 `19330333760c4211705eeaf63e33695229ec3649`、T103 `35904aa5`、T104 `bcc08615`。这些提交证明研究文档已交付，不证明被讨论的能力已经实现或通过 U1。

## 2. 候选优先级的六轴比较

评分是方向性 S/M/L，不是工时承诺。六轴依次为：用户价值、集成复杂度、改动范围、跨 SDK/平台影响、许可证/来源风险、隔离验证可证明性。

| 候选 | 用户价值 | 集成复杂度 | 改动范围 | 跨 SDK / 平台影响 | 许可风险 | E1 可证明性 |
|---|---|---|---|---|---|---|
| Docs 原生 AgentSkill 工具结果回到同一 SDK turn | 高 | M | M | M | M（复用既有补丁链，须保持来源/NOTICE 门禁） | 高：fake SDK + 隔离 Docs renderer 可验证 |
| Node-RED Deploy、库 CAS、触发 owner、跨进程 CAS 单一权威 | 很高 | M–L | M | M | M（继续使用固定上游，发布许可另有阻断） | 高：隔离 DB、假 flow、真实 OS 子进程 |
| UI 探针、审批键盘与焦点契约 | 高 | S–M | S–M | M | 低 | 中：组件/DOM E1 可证明，真实 Electron U1 另测 |
| Worktree merge-back owner 失败时 fail-closed | 高（数据/代码安全） | S–M | S | M | 低 | 高：虚构 Git repo + 旧红新绿 |
| Branch-vs-base Diff 与 SHA 安全的行级 Review Notes | 中–高 | L | L | M | 低–M | 中–高：隔离 Git repo 可验证，完整 UI 需 U1 |
| 多 Host / 远端 workspace 路由 | 长期高，当前非首要 | L | L | L | M | 中：需要假 Host 和真实 SSH/远端 U1 |
| PTY 持久 attach / checkpoint / 输出背压 | 取决于实测需求 | L | L | L（Windows/POSIX） | 低 | 中：需跨平台 PTY，不能只测普通 Node 测试 |
| 扩展 Host API 收敛与 VS Code 兼容 | 长期高，但用户已明确放后 | M–L | M–L | 高 | M–高（每个运行时/扩展包单独审查） | 中：需要恶意扩展、撤权和跨 OS 验证 |

## 3. Top 3 建议

### Top 1｜先完成 Docs 原生工具同轮往返（已有 T92 阻塞，不另造 Agent Loop）

**收益：**这是最短的真实价值链：Mcode 三 SDK → Host request-scoped tool handler → 当前受信 GenOffice Docs renderer 的原生 `AgentSkill.executeTool` → 带 requestId/callId 的结果 → 同一个 SDK turn 继续。它直接验证“Agent 能用已有 Office 能力”，而不是再做一套简化编辑器或工具执行器。

**已有基座：**T83 已有 fail-closed 能力门；T86 已有 request-scoped 原生工具协议；T98 已补上 GenOffice Docs 的受限 ACK 协议。旧 T92 结果回写仍显示 Host 接线和正向往返未完成，因此必须先完成这张已批准的集成切片，不能把协议 Smoke 当端到端通过。

**验证难点：**请求/文档/sender/session/callId 绑定、并发 A/B、取消/迟到结果、审批拒绝、原生 renderer 执行、工具结果回到同一 turn；真实在线三 SDK 和真实 Electron U1 仍须单独验。

### Top 2｜Node-RED 唯一工作流/自动化权威的安全收敛

**收益：**避免一次 Deploy 只写入原生 flow 而 Mcode Library 镜像失败、旧 AutomationRunner 留下第二份 watcher/cron/event、两个 OS 进程同时持有同一 flow owner。它们直接关系到用户编辑不丢、触发不重复和执行权可审计。

**建议的互斥切片：**分别处理 Deploy↔Library reconciliation、旧触发器 owner gate、owner 文件跨进程 CAS；每张只拥有各自独占文件，先隔离 E1，不启动真实用户流程，不宣布 ARC-006/G2–G5 完成。三张卡全绿也不等于整包完成。

**验证难点：**CAS 冲突、重复/迟到 Deploy ACK、cancel/crash、重启、旧图兼容、坏档、真实 OS 双进程；Node-RED 原生 flow 与 Mcode SQL 不能被口头宣称跨存储原子。

### Top 3｜修复可观测性与高风险拒绝路径，再串行做真实 GUI 验收

**收益：**先让 UI 测试能够区分真实产品内容、fixture、缺内容与错误容器；证明 Enter 不会意外授权、Esc/IME/隐藏 Pane 不误触发。随后再在真实 Electron 中验证六套 GenOffice 原生编辑器与 Node-RED 画布，不把静态组件或 headless 测试冒充 U1。

**验证难点：**DOM 假阳性、焦点所有权、IME、危险方法永不“始终允许”、Pane 保活，以及真实窗口/资源/保存重开。GenOffice 与 Node-RED 的 Electron U1 必须串行，不能同时抢共享窗口。

## 4. 不应现在照搬或实施的方向

1. **不切换 Orca 为 Mcode 底座，不整仓复制 Orca 代码。** Orca 只作固定 SHA 的源码设计参考；每一项都先定位 Mcode 现有 seam，只有源码证据证明确实缺失才另立适配任务。
2. **不引入默认 YOLO / skip-permission / full-access。** 这与 Mcode 的 Host-side danger approval、用户本人授权和 fail-closed 原则冲突。
3. **不把 Orca 的持久 provider child / PTY daemon 套给 Claude、Pi、Codex。** 保留各 SDK 原生 loop、审批、取消与生命周期；只在实际证明有需求时，为现有 TerminalManager 增加窄生命周期或有界背压能力。
4. **暂不做完整 Hosted PR Review、复杂远端 workspace/runtime 配对或完整 VS Code API。** 这些范围大、跨平台/授权代价高；先补 Mcode 现有 Git/SSH/ModuleHost 的窄缺口。
5. **不因 Orca 有独立目录就判定 Mcode 缺失能力。** T104 明确发现许多能力已通过通用 app API、ModuleHost grants、workflow trust 或 executor ownership 存在，只是接口统一度不同。

## 5. 建议的最小工程切片与下一步依赖

**立即优先的现有切片：**完成 T92 对 T83/T86/T98 的 Host 接线，在隔离 Docs renderer 中证明一次安全的读工具和一次隔离文档修改工具能回到同一个 SDK turn；未知工具、错 sender/session/document、重复/迟到 ACK、取消和无审批都必须 fail-closed。不要修改 T86 provider adapter、T49 appControl、GenOffice 上游或 patches。

**可独立并行的安全切片：**T101 报告指出 `worktreeOps.ts:mergeBackWorktree` 的 ownership probe 存在静态 `catch(() => true)` 风险。新任务必须先确认该代码在当前 HEAD 仍存在，并以虚构 Git repo 证明探测异常不会继续 merge；若已被别的提交修正，则停止并只回写证据。该切片不需要复制 Orca 实现，也不应扩大为完整 worktree 身份/schema 重构。

**工作流切片：**在不重叠的文件边界内并行处理 Deploy/Library 对账、旧触发器归属与跨进程 owner CAS。完成这些 E1 后，才安排真正 Electron 的 Node-RED U1；GenOffice U1 与之严格串行。

本报告不创建或授权任何产品代码变更。后续执行任务应在新任务台账里按文件互斥重新编号，并保留每张卡的独立验收、旧红新绿、变异恢复与 remaining。

## 6. 许可与发布门禁

- 本轮只借鉴源码设计和行为，不复制 Orca 代码、字体、图标或其他资产。Orca 的 MIT 主许可证不自动覆盖所有第三方依赖和内嵌资源。
- GenOffice 的 T87/T89/T90 记录仍有完整许可证文本缺口；Node-RED 的 T88/T91 仍有需要准确接入 manifest/notice 的来源项。未完成准确版本来源核验、notice 生成与发行门禁复验前，不能宣称可发布。
- 本报告未修改任何许可证、manifest、安装器或上游仓库；不放宽任何 release gate。

## 7. 最终结论

继续以 Mcode 为产品主线；Orca 是本地固定版本的参考，不是要整体替换进去的底座。先完成既有 Docs 原生工具同轮往返，并行修复 Node-RED 单一执行/存储权威的安全切片与 UI 测试可信度；再用串行真实 Electron U1 汇合 GenOffice 与 Node-RED。SDK 版本兼容机制需要先审计现状、形成升级/回归门，而不是盲目放开版本范围。扩展与 AI 自建扩展仍保留在后续阶段，沿用现有 ModuleHost 与可许可的 VS Code 兼容生态，不从零造插件运行时。
