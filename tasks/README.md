# Mcode 执行任务台账（新体系）

> 新编号从 T0 开始。旧任务卡与旧索引完整保存在 `tasks/archive/legacy-2026-10-22/`；旧编号仅用于追溯，不再复用。正式缺陷/架构台账 `audit-ledgers/Mcode_统一审查台账.md` 保持原样，不重置 MC/ARC/UXG 编号。
>
> **已确认的产品目标：** [`docs/planning/mcode-product-roadmap.md`](../docs/planning/mcode-product-roadmap.md)。规划讨论、Grilling Q1–Q51 的恢复证据见 `.scratch/mcode-product-roadmap/`；产品路线确定不代表任务或 ARC 已验收。

## 使用规则

1. 本目录根层的 `T<number>-*.md` 是当前唯一可派发的正式执行卡；归档目录只保留历史证据。
2. 每张卡必须定义目标、依赖、独占写入边界、验收判据、测试、Required Skills 和结果回写。执行者必须先读所列 Skill 的 `SKILL.md`。
3. 派活按**独占文件边界**拆分，而不是按问题名称拆分。同一文件同一时间只能有一个执行对话负责；共享 Electron UI 的 U1 任务必须串行。
4. 执行对话开工前核对 Git HEAD、dirty state、依赖与文件边界；不得 reset/clean，不得覆盖其他对话修改。
5. 先证明旧红，再修复，再证明新绿；关键安全修复需变异验证。E1/headless 不得冒充真实 Electron U1。
6. 完成必须回写测试证据、commit SHA、剩余风险；未达判据明确标 BLOCKED/FAIL，不可用“报告已写”冒充产品通过。
7. 新建任务必须使用 `_PROMPT_TEMPLATE.md` 的通用派活提示词，并声明相关 Required Skills。

## 当前新任务与并行关系

| ID | 标题 | 优先级 | 依赖 | 并行组 |
|---|---|---|---|---|
| T0 | GenOffice 原生工具同轮往返接线 | P0 | 无 | A |
| T1 | Worktree ownership fail-closed | P0 | 无 | A |
| T2 | Node-RED Deploy/Library 对账恢复 | P0 | 无；须声明独占文件 | B |
| T3 | Node-RED 触发器单一归属 | P0 | 与 T2/T4 协调文件边界 | B |
| T4 | 工作流 owner 跨进程 CAS | P0 | 与 T2/T3 协调文件边界 | B |
| T5 | UI 视觉探针假阳性收敛 | P1 | 无 | A |
| T6 | 审批键盘/焦点/拒绝回归 | P1 | 无 | A |
| T7 | GenOffice 六编辑器真实 Electron U1 | P1 | T0 完成；独占 Electron | C（串行） |
| T8 | Node-RED 真实 Electron U1 | P1 | T2/T3/T4 完成；独占 Electron，与 T7 串行 | C（串行） |
| T9 | GenOffice 许可证来源证据 | P0 release blocker | 无 | D |
| T10 | Node-RED 许可证材料集成 | P0 release blocker | 核对既有来源证据 | D（与 T9/T11 文件分离） |
| T11 | GenOffice 许可证材料集成 | P0 release blocker | T9 | D（T9 后） |
| T12 | UI 工作台现状与用户旅程基线矩阵（只读） | P1 | 无 | E（可并行） |
| T13 | GenOffice 六原生编辑器功能与接线基线矩阵（只读） | P1 | 无 | E（可并行） |
| T14 | Node-RED 唯一工作流内核现状与迁移基线（只读） | P1 | 无 | E（可并行） |
| T15 | 通用 Agent、Provider 与 Host 能力基线矩阵（只读） | P1 | 无 | E（可并行） |
| T16 | 真实 Electron U1 验收框架（可复用驱动骨架） | P0 基础设施 | 无 | F |
| T17 | 文件类型路由统一：四份判据收成一份 | P0 地基 | 无 | F |
| T18 | 扩展安装时的权限卡片（同意一次 / 始终同意） | P0 产品要求 | 无 | G |
| T19 | 扩展 API 面：让扩展调到 Mcode 的全部能力 | P1 | T18 | H |
| T20 | AI 写扩展的闭环（生成 → 校验 → 装机 → 可回滚） | P1 | T18 + T19 | I |
| T21 | 悬挂的适配器：NodeRedFlowStorage 与 workflowMigrationPreflight 接上生产路径 | P0 架构 | **T2 + T4 完成** | J |

### 推荐第一波

可先派 T0、T1、T5、T6、T9。T2/T3/T4 也可并行启动，但开工后必须先声明准确独占文件集合；发现重叠即停，不允许同文件多代理写入。T10 先核验现有证据和专属文件边界；T11 等 T9。T7/T8 绝不同时占用 Electron。

### 产品路线基线波（新增，可同时派发）

T12、T13、T14、T15 均为**只读源码调查**，各自只写入独立报告文件，彼此可并行；它们不得修改产品代码、测试、正式审查台账或其他任务卡。四份矩阵齐备后，由总控根据证据拆下一批实现卡，不先猜文件边界。路线恢复稿和来源置信度记录位于 `.scratch/mcode-product-roadmap/spec.md`、`sources.md`、`map.md`。

### 结构性缺口波（T16–T20，2026-10-23 新增）

这五张卡补的是**「谁都绕不过去、但一直没人开卡」**的地基：

- **T16** 是最大结构性缺口。现有 `arc005-visual-baseline` 只能拍静态截图，没有可复用的「启动真 Electron → 操作 → 断言」骨架。T7、T8、ARC-005 V4 全卡在这里。**先做 T16，T7/T8 才有意义。**
- **T17** 是 GenOffice 全线地基：契约层已有 `documentKind.ts` / `genofficeFileRoute.ts`，但上层仍有多处各自判定扩展名。不收干净，每接一个编辑器就多一份判据。
- **T18 → T19 → T20** 是扩展线的完整依赖链。产品要求是「装的时候弹权限卡片，像手机装软件」，而当前**没有任何安装确认 UI**（`grep installConfirm` 零命中）。T18 补这一环，T19 才能安全地开 API 面，T20 才能让 AI 写扩展。
- 并行关系：T16、T17、T18 三者互不冲突，可同时开。T19 等 T18，T20 等 T18+T19。

### 当前受阻（不要派）

- **T7 / T8** 需要真实 Electron U1 骨架 → 等 **T16** 交付。
- **T10 / T11** 需要 T9 的取证与策略裁决。
- **T3** 与 T2/T4 共享工作流热文件 → 等 T2/T4 收。
- **T21** 要接的写路径与 T2/T4 重叠 → 等它们提交。

### 结构性发现（T14 基线，2026-10-23）

T14 报告查出六处「单一事实源」竞争，其中两处已开卡：

- **flow 存储**：SQL `WorkflowDoc` 与引擎 `flows.json` 是两份持久化，Deploy 后的镜像 fire-and-forget（→ **T2**）。
- **执行归属账本**：`executor-ownership.json` 无跨进程锁，而**同目录**的 `NodeRedFlowStorage` 已有 `withOsFileLease`（→ **T4**）。
- **触发安装**：旧 `automationRunner.buildTriggers` 不看 `doc.engine`，`engine=node-red` 的图照样装 cron/fs.watch（→ **T3**）。
- **审批**：SQL `workflow.review.v1.*` 与引擎 `engine-trust.json` 互不引用，后者生产代码**无 writer**（→ 待开卡）。
- **悬挂适配器**：`NodeRedFlowStorage`（609 行）与 `workflowMigrationPreflight`（1631 行）**零生产调用方**，却各有测试护航（→ **T21**）。
- **运行历史**：旧 runner 有 `runStore` 持久化；Node-RED 原生只有内存 runboard，**无持久运行史**（→ 待开卡）。

## 历史和真值来源

- 旧卡正文、旧任务 README/模板/路线图及 SHA-256：`archive/legacy-2026-10-22/`。
- 正式风险、缺陷和验收状态：`../audit-ledgers/README.md` 及 `../audit-ledgers/Mcode_统一审查台账.md`。
- Skill 工程规划（探索、spec、决策图）：`.scratch/<feature-slug>/`；它不是正式执行卡，也不替代本目录的执行验收。
