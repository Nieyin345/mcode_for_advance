# T102｜Orca↔Mcode CLI/SSH/远程工作区与移动端源码对照

| 项目 | 内容 |
|---|---|
| 编号 / 优先级 | **T102 / P1：只读设计取证，可立即并行** |
| 阶段 | Orca→Mcode 比较第一轮；不实施代码 |
| 固定 Orca SHA | `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`（浅克隆，版本字符串 1.4.214） |
| 规划票 | `.scratch/orca-mcode-comparison/issues/04-remote-cli.md` |
| **唯一交付报告** | `docs/research/orca-mcode/T102-remote-cli.md` |
| 唯一可写 | 本报告 + 本任务卡末尾结果回写；其余所有文件只读 |
| 前置依赖 | 无；与 T99–T104 其他 5 卡并行，T105 等全部报告 |

## 目标与范围

远程 Host 发现、SSH 身份绑定、代理/daemon、CLI 命令路由与权限、跨版本兼容、断线重连及手机端的工作区映射。明确 Mcode 手机远控不等于 Orca 远程开发 Host。

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

- **允许写**：本卡唯一报告 `docs/research/orca-mcode/T102-remote-cli.md`、本任务卡末尾 `## 结果回写区`；除此以外全部只读。报告路径是本卡明确授权的新文件，优先在里面写完整论据，回写区只汇报报告位置/哈希/验收结果。
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
   - `orca/src/main/host/**`
   - `orca/src/main/daemon/**`
   - `orca/src/main/ssh/**（若实际存在才读）`
   - `orca/src/cli/** 的入口和命令分派`
   - `orca/src/renderer/src/ssh/**`
   - `orca/mobile/** 中 remote workspace 相关最小路径`

   Mcode（只读）：
   - `apps/desktop/src/main/mobile/**`
   - `apps/desktop/src/main/relay/**`
   - `apps/desktop/src/main/ipc/agentSsh.ts`
   - `apps/desktop/src/main/ipc/mobile.ts`
   - `apps/desktop/src/main/ipc/relay.ts`
   - `packages/contracts/src/** 中设备/Host 与 session 的消息契约`
3. 重点核对：
1. 比较 Host ID、worktree ID、project ID 三种概念的主权以及远程路径如何验证
2. 梳理命令从 UI/CLI/手机到 Host 的权限与取消边界、ssh credential 归属和断线恢复
3. 标出 Mcode 已经有的 relay/phone 能力、不足之处和不该复用 Orca 的系统/账户假设
4. 形成至少 5 行可验证的**能力对照矩阵**，同时报告 2–3 条最关键的异常/权限/恢复边界；每行附 Orca 与 Mcode 符号/源码路径，若查无证据标 E3 和搜索范围。
5. 按“不重复已有工作、最少接口改动、能通过隔离测试、符合 Mcode 安全和可编程原则”给出 **Top 2 借鉴点 + 1 条不该照搬的设计**，每条写预计复杂度与可能的完整回归测试门（不运行测试）。
6. 编写报告并提交；把报告位置、两仓 SHA、结论计数、证据等级、未证风险与提交 SHA 追加本卡回写。

## 验收判据

1. 至少三条真实入口→状态/副作用的源代码调用链；Orca 与 Mcode 证据分别可定位，并准确记录固定 SHA。
2. 至少 5 项对照，分类“已有/部分/缺失/冲突/证据不足”且不能从 Orca 名气直接推断 Mcode 落后。
3. 覆盖所列重点边界、2–3 个失败/恢复反例设计，并给 Top 2 可借鉴点 + 一个有源码依据的不宜移植点。
4. 交付 **唯一报告** `docs/research/orca-mcode/T102-remote-cli.md`；没有改动 Orca、Mcode 产品代码、共享配置、用户数据、其他任务卡或别人的 dirty 文件。
5. 如实标识 E2/E3 与未做的 E1/U1；只做静态审查不冒称实现通过或产品成熟度已测。

## 结果回写区

<!-- 仅追加：报告位置和 SHA、提交 SHA、证据定位摘要、逐条验收 PASS/FAIL、remaining。 -->


### 2026-10-22 执行回写

- **报告：** `docs/research/orca-mcode/T102-remote-cli.md`
- **报告 SHA-256：** `5db615e3e64ae12466b81ec29dc05471e723c1fee10711e07af6a107c8ba27c5`
- **报告提交 SHA：** `9100e65678c9c0b73dde5c98f3f007f4660dea09`（仅包含上述报告；任务卡回写将单独提交）。
- **源码基线：** Orca `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`，检查前后 HEAD 一致且 `git -C orca status --short` 为空；Mcode 在本次写入前的 HEAD 为 `35904aa56d8190b4b3ee101c8e050156aab21e32`。期间 T99/T103 的其他对话提交仅涉及各自报告/任务回写，未覆盖。
- **实际修改范围：** 新增报告；本任务卡仅追加本段回写。未修改 Orca、Mcode 产品代码、共享配置、其他任务卡、其他报告或用户数据。
- **验证命令/结果：**
  - `git -C orca rev-parse HEAD` → `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`，PASS。
  - `git -C orca status --short` → 空，PASS。
  - `certutil -hashfile docs\research\orca-mcode\T102-remote-cli.md SHA256` → 与上列报告 SHA-256 一致，PASS。
  - `git diff --cached --check`（报告提交前，仅暂存报告）→ exit 0，PASS。
  - 源码研究为只读任务，未运行 build/test/smoke/变异测试或真实 CLI/手机/SSH E2E；这是按任务边界有意不运行，不报告测试 PASS。
- **结论计数：** 9 项能力矩阵；4 条入口→状态/副作用调用链（SSH Host、CLI launch、手机 workspace、terminal daemon）；3 个主要异常/权限/恢复边界；E2 为源码证据，E3 为未执行的故障推演；E1/U1 未验证。
- **验收判据：**
  1. **PASS** — 给出至少三条真实调用链，分别引用 Orca 与 Mcode 的入口、路由、状态/副作用代码，并记录固定 Orca SHA。
  2. **PASS** — 9 项矩阵逐项分类并附双仓源码证据；没有用“Orca 有所以 Mcode 落后”的方式推断。
  3. **PASS** — 覆盖 Host/worktree/project 身份、路径验证、权限/取消、SSH 凭据/Host Key、跨版本、断线恢复、手机路由；提供 3 个静态失败场景、Top 2 借鉴点及 1 条不宜照搬的设计。
  4. **PASS** — 唯一报告已提交；暂存/提交只包含报告。已有 dirty 文件均保留，未使用 `git add -A`，未推送。
  5. **PASS** — 明确区分 E2/E3 与未做的 E1/U1，没有声称端到端已通过。
- **未完成/剩余风险：** 无范围内阻塞。未验证实际 SSH 主机密钥提示、managed `orcad` 部署/恢复、旧 runtime 兼容与手机跨 Host E2E；这些需要后续在隔离环境的专项测试中验证。本任务不实施代码，因此没有新增代码测试或变异验证。
