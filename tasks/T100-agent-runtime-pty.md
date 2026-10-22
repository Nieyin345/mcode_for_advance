# T100｜Orca↔Mcode 多 Agent/PTY/会话生命周期与恢复源码对照

| 项目 | 内容 |
|---|---|
| 编号 / 优先级 | **T100 / P1：只读设计取证，可立即并行** |
| 阶段 | Orca→Mcode 比较第一轮；不实施代码 |
| 固定 Orca SHA | `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`（浅克隆，版本字符串 1.4.214） |
| 规划票 | `.scratch/orca-mcode-comparison/issues/02-agent-runtime-pty.md` |
| **唯一交付报告** | `docs/research/orca-mcode/T100-agent-runtime-pty.md` |
| 唯一可写 | 本报告 + 本任务卡末尾结果回写；其余所有文件只读 |
| 前置依赖 | 无；与 T99–T104 其他 5 卡并行，T105 等全部报告 |

## 目标与范围

Agent 启动、会话与子进程持有权、PTY 生命周期、并发、停止/重连、状态播报、异常退出与持久化重启边界。不要把 CLI 包装层误当三 SDK 的等价 AgentProvider。

## Required Skills

- `codebase-design`：按 module/interface/seam 对比职责和可适配边界；调查前读 `.claude/skills/codebase-design/SKILL.md`。
- `research`：原始源码优先，逐项给双仓定位和可复核证据；调查前读 `.claude/skills/research/SKILL.md`（不开子代理）。

## 开工前必读

1. 完整读 `audit-ledgers/README.md`、`AGENTS.md`、`CLAUDE.md`、`docs/agents/issue-tracker.md`、`.scratch/orca-mcode-comparison/spec.md` 与 `map.md`。
2. 完整读 `orca/AGENTS.md`、`orca/LICENSE`，只读确认 `git -C orca rev-parse HEAD` = `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`、`git -C orca status --short` 为空；另记 Mcode 当前 HEAD 和 dirty 文件。若 Orca 基线改变，停止并回写待重新定标；禁止自行 fetch/reset。
3. 读取本卡 Required Skills 的 SKILL.md。此项目原派活模板不允许开子代理，故 `research` Skill **只采用一手源码/文档证据方法**，不用其后台代理分发指令。

## 固定证据格式（报告必须遵守）

- 每项核心事实：`Orca: 路径 + 函数/符号 + 调用链或测试位置`，`Mcode: 路径 + 函数/符号 + 调用链或现状`。首尾必须能在固定 SHA 的仓库复核，必要时用行号。
- 结论只分 **等价已有 / 部分已有 / 真缺失 / 证据不足 / 与定位冲突**，每项注明 E2（源码静态）或 E3（推测），不得由目录名称或宣传文案直接判完成。
- 优先写具体可复现的输入与边界，例如“两个会话抢同一 worktree”“取消后旧 ACK 到达”等；**未实际执行测试时只能写静态风险**，不可说已经复现红例。
- 复用选择必须写 **借鉴设计 / 小模块适配 / 暂不引入** 及理由、粗粒度 S/M/L 工作量、对 Mcode 统一 Provider、审批、`app_api_*`、工作流的影响。
- 代码版权/第三方资产检查：只能建议复用，不能复制并提交 Orca 原厂代码；MIT 审查不能自动覆盖全部内嵌资源和依赖。

## 边界（不要碰）

- **允许写**：本卡唯一报告 `docs/research/orca-mcode/T100-agent-runtime-pty.md`、本任务卡末尾 `## 结果回写区`；除此以外全部只读。报告路径是本卡明确授权的新文件，优先在里面写完整论据，回写区只汇报报告位置/哈希/验收结果。
- **Orca 是完全只读参考**：禁止在 `orca/**` 写文件、`git fetch/pull/checkout/reset`、安装依赖、build、run、开启服务、修改 `orca/.git`、自动格式化或更新上游。
- **Mcode 产品代码、许可证 manifest、Node-RED/GenOffice、其他任务卡和其他五份研究报告一律禁写**。不启动 Electron、不触碰用户数据库、生产项目/SSH 远端、模型账户，不运行高风险 shell/git 修改。
- 既有 dirty 文件属他人；不可 reset/clean/stash、不可 `git add -A`，不可修改另一个执行者的报告或规划票。
- 本次只读调查无需反向变异：不存在“修复代码”的红绿测试。若要跑无副作用 read-only 工具，记录命令、退出码；禁止编造 PASS 计数。

## 提交与结果回写

- 报告放在指定新文件，最多一个文件。只精准暂存/提交该报告与本任务卡新增的回写内容，`git diff --cached --check`，不推送、不改其他卡。
- 若提交后再追加回写，另做精准 docs 提交并列出报告 SHA + 任务回写 SHA；不要修改之前别人写的回写。
- 回复用户只说：任务编号与标题；提交 SHA；有无未达验收（列明）。


## 执行内容

1. 定位 Orca 源码从入口到副作用/状态落盘的 **至少三条**有代表性调用链；逐项核对 Mcode 对应入口，不止比较函数名称。
2. 首选沿下面的**线索目录**读源码；线索并不保证实际存在，须先搜索/核实，找不到就如实记录，不猜接口。

   Orca（只读）：
   - `orca/src/main/agent-launch/**`
   - `orca/src/main/provider-process/**`
   - `orca/src/main/pty/**`
   - `orca/src/main/providers/** 与具体 agent adapter 相关处`
   - `orca/src/main/daemon/** 中恢复/进程持有者部分`

   Mcode（只读）：
   - `apps/desktop/src/main/claude/RuntimeManager.ts`
   - `apps/desktop/src/main/providers/**`
   - `apps/desktop/src/main/terminal/**`
   - `apps/desktop/src/main/orchestration/** 中 agent 执行入口的只读部分`
   - `packages/contracts/src/runtime.ts（若存在）`
3. 重点核对：
1. 比较三家 SDK 原生事件/审批与 Orca CLI/ACP/PTY 的权限和事件模型，不提出第二套 agent loop
2. 验证用户取消、子进程退出、掉线、重新 attach、崩溃重启、幽灵终端及输出流背压的静态调用链
3. 指出 Mcode 已有 Provider/隐藏子会话/自动化与 Orca 工作区内任务的非等价处及最小改善接口
4. 形成至少 5 行可验证的**能力对照矩阵**，同时报告 2–3 条最关键的异常/权限/恢复边界；每行附 Orca 与 Mcode 符号/源码路径，若查无证据标 E3 和搜索范围。
5. 按“不重复已有工作、最少接口改动、能通过隔离测试、符合 Mcode 安全和可编程原则”给出 **Top 2 借鉴点 + 1 条不该照搬的设计**，每条写预计复杂度与可能的完整回归测试门（不运行测试）。
6. 编写报告并提交；把报告位置、两仓 SHA、结论计数、证据等级、未证风险与提交 SHA 追加本卡回写。

## 验收判据

1. 至少三条真实入口→状态/副作用的源代码调用链；Orca 与 Mcode 证据分别可定位，并准确记录固定 SHA。
2. 至少 5 项对照，分类“已有/部分/缺失/冲突/证据不足”且不能从 Orca 名气直接推断 Mcode 落后。
3. 覆盖所列重点边界、2–3 个失败/恢复反例设计，并给 Top 2 可借鉴点 + 一个有源码依据的不宜移植点。
4. 交付 **唯一报告** `docs/research/orca-mcode/T100-agent-runtime-pty.md`；没有改动 Orca、Mcode 产品代码、共享配置、用户数据、其他任务卡或别人的 dirty 文件。
5. 如实标识 E2/E3 与未做的 E1/U1；只做静态审查不冒称实现通过或产品成熟度已测。

## 结果回写区

<!-- 仅追加：报告位置和 SHA、提交 SHA、证据定位摘要、逐条验收 PASS/FAIL、remaining。 -->

### T100 结果回写（追加）

- **任务 / 标题：** T100｜Orca↔Mcode 多 Agent/PTY/会话生命周期与恢复源码对照
- **唯一报告：** docs/research/orca-mcode/T100-agent-runtime-pty.md
- **报告 SHA-256：** ea0eea47fd9cc19a0e580ea29070290363a42d9cd80ef1886595b6ce6d2e5a8d
- **报告提交 SHA：** e5da8d2ff7af2e3f248b346d50e2e4def8d70a65（该提交仅新增上述报告；本回写随后单独提交）
- **源码基线：** Orca ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560（1.4.214，核对时工作区干净）；Mcode 源码检查快照 9100e65678c9c0b73dde5c98f3f007f4660dea09。并行执行期间 T101 的两个 docs-only 提交 2bcad370da1867f6745aff49f66635a354c17910、6aa11098f2267e9c4b9924f7c20ba15bb75b9ba8 将 HEAD 推进；其 diff 仅涉及 T101 报告和 T101 任务卡，不涉及本报告检查的产品源码。T100 报告提交的父提交为 6aa11098。
- **结论计数（矩阵 8 行）：** 等价已有 0；部分已有 6；真缺失 1；证据不足 1；与定位冲突 0。
- **证据等级：** E2 静态源码证据为主；E3 标记未验证的竞态/压力/跨 worktree 风险。未取得 E1 或 U1，不声称真实产品端到端通过。

#### 验证与提交

- PASS：任务匹配检查只找到 tasks/T100-agent-runtime-pty.md 一个文件。
- PASS：git -C orca rev-parse HEAD = ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560；git -C orca status --short 为空。
- PASS：Mcode 源码快照为 9100e65678c9c0b73dde5c98f3f007f4660dea09；检查过的 RuntimeManager、三家 provider、TerminalManager、workflow runner 和 contracts 文件在该快照没有 dirty 修改。
- PASS：git diff --cached --check -- docs/research/orca-mcode/T100-agent-runtime-pty.md 退出码 0；报告提交 e5da8d2ff7af2e3f248b346d50e2e4def8d70a65 的 name-status 只有新增报告。
- NOT RUN（按只读研究边界）：pnpm test:all、pnpm typecheck、真实 Electron/PTY、压力测试和跨平台集成测试。未把静态分析冒充动态验证。
- PASS：T100 只新增唯一报告并回写本任务卡；未改 Orca、Mcode 产品代码、共享配置、用户数据或其他任务文件，未推送。

#### 验收判据

1. **PASS** — 至少三条入口到副作用/状态的真实调用链，分别追踪 structured session/lease、SDK 原生审批与退出、PTY spawn/attach/checkpoint/teardown；记录两仓 SHA。
2. **PASS** — 8 项能力矩阵逐行给出分类、双仓源码路径与 E2/E3 证据边界；未从 Orca 名气推断 Mcode 落后。
3. **PASS** — 给出 3 个静态异常/恢复测试设计、Top 2 借鉴点、1 条不应照搬设计，并注明复杂度、影响面和后续测试门。
4. **PASS** — 只新增 docs/research/orca-mcode/T100-agent-runtime-pty.md，并修改本任务卡结果回写；产品源码与其他任务内容不在 T100 提交中。
5. **PASS** — 明确区分 E2/E3，标明未做 E1/U1 与未运行测试；未声称实现已通过或产品成熟度已测。

#### 未完成事项与剩余风险

- 无任务范围内的阻塞项；报告交付完成。
- Mcode 跨 session 的全 worktree 写入互斥未在 T100 范围内完整审计，保留为 E3。
- Mcode node-pty 对平台级 descendant termination 的完整语义未做动态验证；TerminalManager 的迟到 onExit / 重复 TERMINAL_EXIT 幂等性、输出 flood 下 pendingData 的实际表现均未测试。
- 若后续要求 PTY 在应用重启后 attach 或冷恢复，需另拆独立设计/实现任务；本任务未实施此能力。
