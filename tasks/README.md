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

### 推荐第一波

可先派 T0、T1、T5、T6、T9。T2/T3/T4 也可并行启动，但开工后必须先声明准确独占文件集合；发现重叠即停，不允许同文件多代理写入。T10 先核验现有证据和专属文件边界；T11 等 T9。T7/T8 绝不同时占用 Electron。

### 产品路线基线波（新增，可同时派发）

T12、T13、T14、T15 均为**只读源码调查**，各自只写入独立报告文件，彼此可并行；它们不得修改产品代码、测试、正式审查台账或其他任务卡。四份矩阵齐备后，由总控根据证据拆下一批实现卡，不先猜文件边界。路线恢复稿和来源置信度记录位于 `.scratch/mcode-product-roadmap/spec.md`、`sources.md`、`map.md`。

## 历史和真值来源

- 旧卡正文、旧任务 README/模板/路线图及 SHA-256：`archive/legacy-2026-10-22/`。
- 正式风险、缺陷和验收状态：`../audit-ledgers/README.md` 及 `../audit-ledgers/Mcode_统一审查台账.md`。
- Skill 工程规划（探索、spec、决策图）：`.scratch/<feature-slug>/`；它不是正式执行卡，也不替代本目录的执行验收。
