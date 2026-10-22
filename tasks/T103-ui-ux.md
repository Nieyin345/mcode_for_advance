# T103｜Orca↔Mcode 三栏 UI/Agent 任务看板与可用性架构对照

| 项目 | 内容 |
|---|---|
| 编号 / 优先级 | **T103 / P1：只读设计取证，可立即并行** |
| 阶段 | Orca→Mcode 比较第一轮；不实施代码 |
| 固定 Orca SHA | `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`（浅克隆，版本字符串 1.4.214） |
| 规划票 | `.scratch/orca-mcode-comparison/issues/05-ui-ux.md` |
| **唯一交付报告** | `docs/research/orca-mcode/T103-ui-ux.md` |
| 唯一可写 | 本报告 + 本任务卡末尾结果回写；其余所有文件只读 |
| 前置依赖 | 无；与 T99–T104 其他 5 卡并行，T105 等全部报告 |

## 目标与范围

只研究 Orca UI 结构、布局状态、Agent 工作区看板、状态指示、焦点/键盘可达性、终端/审查间切换；与 Mcode ARC005/T78 代表场景逐项对照。**不是视觉移植，也不启动窗口**。

## Required Skills

- `frontend-design`：只读梳理界面信息架构、焦点与状态表达；审查前读 `.claude/skills/frontend-design/SKILL.md`。
- `research`：从两边一手源码/官方文档追溯功能而不是图片猜测；调查前读 `.claude/skills/research/SKILL.md`（不开子代理）。

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

- **允许写**：本卡唯一报告 `docs/research/orca-mcode/T103-ui-ux.md`、本任务卡末尾 `## 结果回写区`；除此以外全部只读。报告路径是本卡明确授权的新文件，优先在里面写完整论据，回写区只汇报报告位置/哈希/验收结果。
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
   - `orca/src/renderer/src/app-shell/**`
   - `orca/src/renderer/src/components/** 中工作区/terminal/chat/review 的真实源码（先搜索定位）`
   - `orca/src/renderer/src/store/**`
   - `orca/src/renderer/src/assets/main.css`
   - `orca/docs/STYLEGUIDE.md`
   - `orca/tests/** 中相关可用性验证`

   Mcode（只读）：
   - `apps/desktop/src/renderer/components/layout/**（若存在）`
   - `apps/desktop/src/renderer/components/chat/**`
   - `apps/desktop/src/renderer/stores/**`
   - `apps/desktop/src/renderer/** 中 diff、终端、工作区核心面板`
   - `tasks/T78-arc005-visual-baseline-gap-audit.md`
   - `tasks/T95-arc005-visual-probe-false-positive-gates.md`
   - `tasks/T96-approval-card-keyboard-denial-regression.md`
3. 重点核对：
1. 按真实 UI 组件和 Store 定位焦点所有权、pane 可见性、收起恢复、状态反馈，不用图片猜行为
2. 区分 Mcode T95/T96 正在验的测试缺口与真正可感知的产品能力缺口，避免重复派 UI 代码卡
3. 提炼可适配的布局/看板信息架构，但不得复制品牌资产/商用图片/第三方设计资源
4. 形成至少 5 行可验证的**能力对照矩阵**，同时报告 2–3 条最关键的异常/权限/恢复边界；每行附 Orca 与 Mcode 符号/源码路径，若查无证据标 E3 和搜索范围。
5. 按“不重复已有工作、最少接口改动、能通过隔离测试、符合 Mcode 安全和可编程原则”给出 **Top 2 借鉴点 + 1 条不该照搬的设计**，每条写预计复杂度与可能的完整回归测试门（不运行测试）。
6. 编写报告并提交；把报告位置、两仓 SHA、结论计数、证据等级、未证风险与提交 SHA 追加本卡回写。

## 验收判据

1. 至少三条真实入口→状态/副作用的源代码调用链；Orca 与 Mcode 证据分别可定位，并准确记录固定 SHA。
2. 至少 5 项对照，分类“已有/部分/缺失/冲突/证据不足”且不能从 Orca 名气直接推断 Mcode 落后。
3. 覆盖所列重点边界、2–3 个失败/恢复反例设计，并给 Top 2 可借鉴点 + 一个有源码依据的不宜移植点。
4. 交付 **唯一报告** `docs/research/orca-mcode/T103-ui-ux.md`；没有改动 Orca、Mcode 产品代码、共享配置、用户数据、其他任务卡或别人的 dirty 文件。
5. 如实标识 E2/E3 与未做的 E1/U1；只做静态审查不冒称实现通过或产品成熟度已测。

## 结果回写区

<!-- 仅追加：报告位置和 SHA、提交 SHA、证据定位摘要、逐条验收 PASS/FAIL、remaining。 -->
