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

| ID | 标题 | 优先级 | 依赖 | 并行组 | 状态 |
|---|---|---|---|---|---|
| T0 | GenOffice 原生工具同轮往返接线 | P0 | 无 | A | ✅ done |
| T1 | Worktree ownership fail-closed | P0 | 无 | A | ✅ done |
| T2 | Node-RED Deploy/Library 对账恢复 | P0 | 无；须声明独占文件 | B | ✅ done |
| T3 | Node-RED 触发器单一归属 | P0 | 与 T2/T4 协调文件边界 | B | ✅ done（54/54） |
| T4 | 工作流 owner 跨进程 CAS | P0 | 与 T2/T3 协调文件边界 | B | ✅ done |
| T5 | UI 视觉探针假阳性收敛 | P1 | 无 | A | ✅ done |
| T6 | 审批键盘/焦点/拒绝回归 | P1 | 无 | A | ✅ done |
| T7 | GenOffice 六编辑器真实 Electron U1 | P1 | T0 完成；独占 Electron | C（串行） | ✅ done（六编辑器 PASS） |
| T8 | Node-RED 真实 Electron U1 | P1 | T2/T3/T4 完成；独占 Electron，与 T7 串行 | C（串行） | ✅ done（四项验证 PASS） |
| T9 | GenOffice 许可证来源证据 | P0 release blocker | 无 | D | ✅ done（14 验证 / 4 阻塞） |
| T10 | Node-RED 许可证材料集成 | P0 release blocker | 核对既有来源证据 | D（与 T9/T11 文件分离） | ✅ done |
| T11 | GenOffice 许可证材料集成 | P0 release blocker | T9 | D（T9 后） | ✅ done（发行仍阻塞） |
| T12 | UI 工作台现状与用户旅程基线矩阵（只读） | P1 | 无 | E（可并行） | ✅ done |
| T13 | GenOffice 六原生编辑器功能与接线基线矩阵（只读） | P1 | 无 | E（可并行） | ✅ done |
| T14 | Node-RED 唯一工作流内核现状与迁移基线（只读） | P1 | 无 | E（可并行） | ✅ done |
| T15 | 通用 Agent、Provider 与 Host 能力基线矩阵（只读） | P1 | 无 | E（可并行） | ✅ done（报告已交付） |
| T16 | 真实 Electron U1 验收框架（可复用驱动骨架） | P0 基础设施 | 无 | F | ✅ done（5 套在用） |
| T17 | 文件类型路由统一：四份判据收成一份 | P0 地基 | 无 | F | ✅ done |
| T18 | 扩展安装时的权限卡片（同意一次 / 始终同意） | P0 产品要求 | 无 | G | ✅ done |
| T19 | **扩展 API 面：92 条 danger RPC 对已装扩展敞开，收窄它** | **P0 安全** | T18 | H | ✅ done |
| T20 | AI 写扩展的闭环（生成 → 校验 → 装机 → 可回滚） | P1 | T18 + T19 | I | ✅ done |
| T21 | 悬挂的适配器：NodeRedFlowStorage 与 workflowMigrationPreflight 接上生产路径 | P0 架构 | **T2 + T4 完成** | J | ✅ done |
| T22 | smokes-for 覆盖映射漏掉 .tsx，导致「该跑哪几套」判断失真 | P0 工具链 | 无 | F | ✅ done |
| T23 | **生产构建与发行 staging 缺四个编辑器的 preload** | **P0 发行阻断** | 无 | K | ✅ done |
| T24 | 文档 AI 工具面重做：可发现 + Markdown 操作 + QA 门禁 | **P0 产品核心** | T0 | L | ✅ done |
| T25 | 按 pinned HEAD 重建 GenOffice 六家 vendor 产物 | **P0 发行前置** | T23 | M | ✅ done |
| T26 | 「允许一次」文案与实际语义不符 | P1 | T18 | N | ✅ done |
| T27 | **`loadWorkflowIntoNative` 拒绝一切可保存的 Node-RED 图** | **P0** | T21+T8 | O | ✅ done |
| T28 | **Import 进画布的图丢失 `x-mcode` 身份** | **P0** | T8 | O | ✅ done（73/73） |
| T29 | `documentView:close` 对四个编辑器永远拒绝 | P1 | T7 | P | ✅ done（U1 PASS） |
| T30 | 文档工具面缺真实 Electron U1 | P1 | T24+T7 | Q | ⏸ 挂起（需用户环境） |
| T31 | **三处既有失败挡住 `run-smokes --all`** | **P0 工具链** | 无 | R | ✅ done |
| T32 | **`genofficeNativeVendor.ts` 的 alias 虚拟模块破坏 15 套 smoke** | **P0 工具链** | 无 | S | ✅ done（11/11） |
| T33 | **`document.read` 误进 BLOCKED；`toolCall`/`markdownEdit` 档位偏弱** | **P0 安全** | 无 | T | ✅ done（30/30） |
| T34 | **权限映射生成器缺 framework 域；danger 默认可委托** | **P0 安全** | T33 | U | ✅ done |
| T35 | `core.app.call` 能力类型在 catalogue/声明表/注册三处不一致 | P1 | 无 | V | ✅ done |
| T36 | 三套 smoke 夹具过时（T65/T50/正则漏算 schema 包装） | P1 | 无 | V | ✅ done |
| T37 | `mobile-pairing-smoke` 3 秒超时太紧，全量并发下随机红 | P2 | 无 | W | ✅ done（285/285） |
| T38 | 三套打包期失败：桩缺导出、`.node` loader、zustand 5 default | P1 | 无 | W | ✅ done |
| T39 | **GenOffice UI 换壳：保留编辑内核，替换 ribbon/菜单/AI 面板** | **P0 产品要求** | T7+T24 | X | ✅ done（17/17） |
| T40 | **`withRendererToolRegistry` 零调用点 —— `document.tool_call` 渲染端路线不可达** | **P0** | T24 | Y | ✅ done（13/13） |
| T41 | `contributionsOf` 只有一层可选链，`modules` 缺失时**主界面**白屏 | P1 | T36 | Z | ✅ done（17/17） |
| T42 | **U1 骨架静默模式：默认不弹窗，仅截图时短暂显示** | **P1 开发体验** | T16+T7 | AA | ⏸ 挂起（需用户环境） |
| T43 | **文档 AI 的「丑」根因：设计流水线没接上，三个 app 的 QA 门禁是空的** | **P0 产品能力** | T24+T40 | BB | ✅ done（57/57） |
| T44 | genoffice 三套并发安全 —— **防回退回归**（T31 已修复，本卡只做回归网） | **P2** | T31 | CC | ✅ done（15/15） |
| T45 | **权限映射生成器会静默放宽：`document.*` 整个域落进 `write`** | **P0 安全** | T33 | DD | ⬜ 待开工（**下一个安全项**） |
| T46 | 审批卡的真 Electron U1（T6 的 E1 覆盖不到：真窗口键盘 / 多窗口焦点 / settingsOpen 暂停 / 后台会话） | P1 安全回归 | T6 | A | ✅ done（U1 11 步） |
| T47 | **模型拿不到 `guide slides design` —— 设计流水线的「教」这一半还是断的** | **P0 产品能力** | T43 | BB | ✅ done（27/27） |
| T48 | AI 看不见 Node-RED 节点 | P0 | T8+T21 | CC | ❌ 关闭（前提不成立：`node_types_list` 一直存在，在 `mcp/mcodeServer.ts`） |
| T49 | **扩展线核实 → 撞出主界面首帧白屏** | P0 产品缺陷 | T41 | GG | ✅ done（7/7） |
| T51 | **给模型「工作流怎么搭」的规范**（对齐 T47 的设计指南） | P0 | T47 | EE | ✅ done（33/33） |
| T52 | **`setting.set` 可覆盖凭据**（读侧拦了，写侧没拦） | **P0 安全** | T33 | HH | ✅ done（27/27） |
| T53 | **多方会议（代理互相讨论）** | P2 | agentMail 3.17 | FF | ✅ done（30/30，产品代码零改动） |
| T54 | **两套工具面分开：`app_api_list` 看不见 `mcode-workflow` 的 14 个工具** | **P1 可发现性** | 无 | DD | ✅ done（17/17） |
| T60 | **仓库迁移后的全量基线恢复**：3423 个符号链接 + 4 套失败 | **P0 基础设施** | 无 | ZZ | ✅ done（557 套，4 个真失败全修） |
| T62 | **文档 AI 链路端到端验收**：产出的 PPT 真的好看吗 | **P0 验收** | T43+T47 | YY | ✅ done（链路全通 + 三根空柱子） |
| T63 | 把 PPT 产出质量固化成回归断言 | P1 | T62 | YY | ✅ done（`e8b245c7`，15/15） |
| T61 | **反查「测试绿着但实际没验」的套件** | P1 测试基础设施 | 无 | YY | ✅ done（审计报告已入库） |
| T64 | 三套 includes(源码) 空过断言改成真实行为验证 | P1 测试有效性 | T61 | ZZ | ✅ done（`0c0cb80c`） |
| T65 | **反模式检查器**：把规范里 7 条 treat-as-defects 变成可执行判据 | **P0 产品能力** | T62+T43 | ZZ | ✅ done（`f6acf173`，22/22） |
| T66 | 修 5 处「看起来在验、实际没执行」（2 处真缺口 + 3 处清理） | P1 测试质量 | T61 | ZZ | ✅ done（`24945e13`） |
| T67 | 修三处 `|| true` 恒真断言（t43 / settings / t24，非产品缺陷） | P1 测试质量 | T61 | ZZ | ✅ done（`774e864e`，五变异全红） |
| T68 | 剩余 6 条文本断言换 AST 判据 | P1 测试质量 | T64 | ZZ | ✅ done（`c50140de`，74/74） |
| T69 | **T65 阈值校准**：80%/55% 只有 1 份 deck 5 个页面的样本 | P1 校准 | T65+T63+T62 | ZZ | ✅ done（`d382ce87`，零误判零漏判） |
| T70 | **反模式检查器独立复核**：误报比漏报更危险 | **P0 验收** | T65+T63 | YY | ✅ done（`99e73df2`，发现判据抓错对象） |
| T71 | **审计报告事实复核**：哪些结论是「写报告那一刻的判断」 | P1 测试基础设施 | T61+T64+T66 | ZZ | ✅ done（`46a37a52`，46→196 套） |
| T72 | 留白消息改「参考线」语气 + 阈值提命名常量（**不动数值**） | **P0 产品微调** | T65+T69 | ZZ | ✅ done（`2df5c3ca`，31/31） |
| T73 | **反模式检查器零生产调用**：能力造好了但模型看不到 | **P0 产品缺陷** | T65+T43+T72 | ZZ | ✅ done（`da9484b4`，22/22；三条漏项转 T79） |
| T74 | AST 机械层收到 `scripts/lib/ast.ts`（F 的保守方案） | P1 测试基础设施 | T68+T64 | ZZ | ✅ done（`0b067a3d`，74/74 + 10/10） |
| T75 | **`layout.whitespace` 抓错对象**：空柱子不报、填满的反而报 | **P0 产品缺陷** | T65+T70 | ZZ | ✅ done（`7dbbfc80`，40/40） |
| T76 | 审计报告可读性：三拨人写的 343 行，没有「当前状态」入口 | P1 文档 | T61+T71 | ZZ | ✅ done（`3ac67aac`，20/1） |
| T77 | **「真跑 ≠ 真验」**：19 套 transpileModule 套件的判据质量 | P1 测试有效性 | T61+T74 | ZZ | 🔄 进行中（F） |
| T78 | **`smokes-for.sh` 输出 90 套 = 没人跑**：加「距离」分级 | P1 开发工具 | 无 | ZZ | 🔄 进行中（C） |
| T79 | **T73 漏派三条**：fail-closed / `page: null` / 文件名渲染 | **P0 产品缺陷** | T73+T70 | ZZ | 🔄 进行中（B） |
| T80 | **扩展线**：拿真实 VSIX 走 L1-P 桥（不只用自造夹具） | **P0 产品主线** | ARC-006 | ZZ | ⬜ 待开工（A） |
| T81 | **Node-RED 线卡在哪**：施工地图 vs 现状逐项核对 | **P0 产品主线** | T13 | ZZ | ⬜ 待开工（D） |
| T82 | **六编辑器 QA 门禁真的会报问题吗**（pdf/md/html 只有 render-probe） | **P0 产品主线** | T43+T24 | ZZ | ⬜ 待开工（F） |
| T83 | **`slidesAddSlide` 有通道零调用**：可视化编辑断在哪一层 | **P0 产品缺陷** | ARC-007 | ZZ | ⬜ 待开工（E） |
| T84 | **一条会掩盖回归的 journey 断言**：它查的字符串已不存在 | P1 测试有效性 | T81+T27 | ZZ | ⬜ 待开工（D） |
| T85 | **扩展线要不要产品化** | **P0 决策** | T80 | ZZ | ✅ **decided：不做**（`2026-10-24`） |
| T86 | 给 t65 套件输出加一行「验什么、不验什么」 | P2 可读性 | T65+T73 | ZZ | ✅ done（`29804c09`，46/46） |
| T87 | **`build_deck` 三个 fail-closed 分支没有断言** | **P1 测试有效性** | T43+T73 | ZZ | ⬜ 待开工 |
| T88 | **`tsx-coverage-smoke` 断言锚在已删的字符串上**（T78 引入） | **P1** | T78 | ZZ | ⬜ 待开工（B） |
| T89 | **Node 22.21.1 `fs.cpSync` 中文路径崩溃**（跨版本验证） | P1 环境限制 | 无 | ZZ | ✅ 根因已定，**不改代码** |
| T90 | 🔴 **P0：中文用户名下「换数据目录」应用无声崩溃** | **P0 产品缺陷** | T89 | ZZ | ✅ done（`5f954755`，10/10） |
| T91 | 🔴 **P0：导入中文路径的 Markdown，配图静默丢失** | **P0 产品缺陷** | T90 | ZZ | ⬜ 待开工 |
| T92 | **打包链在这台机器上跑不完**（7 处 `cpSync`） | P1 构建基础设施 | T89+T90 | ZZ | ⬜ 待开工 |
| T93 | `runtimeInstaller` 两处 `cpSync`（要先确认 `stagingDir` 来源） | P2 | T90 | ZZ | ⬜ 待开工 |
| T94 | **六编辑器 GUI 真实可用性**（能开/能编辑/能保存） | **P0 产品主线** | T43+T83 | ZZ | 🔄 进行中（E） |
| T95 | **Node-RED 产品可用性 + 禁止两套红线** | **P0 产品主线** | T81 | ZZ | 🔄 进行中（D） |
| T96 | **任务是一级对象吗**（任务中心 + 返修闭环） | **P0 产品主线** | 无 | ZZ | 🔄 进行中（C） |
| T97 | **核心闭环：从 UI 提任务到真实产物** | **P0 产品主线** | T94+T96 | ZZ | 🔄 进行中（A） |
| T98 | **今天修的东西用户能感觉到吗**（反模式提示时序 + 机器判据 vs 人的判断） | **P0 产品主线** | T75+T77 | ZZ | 🔄 进行中（F） |
| T99 | 🔴 **任务不是一级对象**：建 `tasks` 表 + 契约 + IPC 三层 | **P0 产品主线** | T96 | ZZ | ✅ done（`a00672c2` + `e3a2cf59`；执行方四条转函数，迁移表下沉 `setStatus`） |
| T100 | 🔴 **判据会把好 deck 判成坏**（rainbow 无色相 + cover 豁免失效 + 打地鼠） | **P0 产品缺陷** | T75+T98 | ZZ | ✅ done（`a00672c2` 自动记账；判据侧见 T106） |
| T101 | 🔴 **打开 .docx 看到「未配置」**：给一条能走的路 | **P0 产品缺陷** | T94 | ZZ | ✅ done（`bca18b71`，markdown-mode 32/32） |
| T102 | 🔴 **「又烂又丑」三个可量化根因**：中文无字体 / 表格超宽 / 模型不知道传什么 | **P0 产品缺陷** | T97 | ZZ | ✅ done（第 1 件已修；第 2/3 件判为需上游，见回写） |
| T103 | **扩展线闭环**：装一个真实扩展 → 列表 → 调用 → 卸载 | **P0 产品主线** | T80+T85 | ZZ | ✅ **decided：不做**（`c83453aa`，31 个有码扩展里 0 个落在 A+ 范围） |
| T104 | **UI 工作台盘点**：九个能力的可见/可操作 | **P0 产品主线** | 无 | ZZ | ✅ done（九项里八项可见可操作；缺口是审批无历史） |
| T105 | 🔴 **P0 安全：`task.accept` 对 Agent 开放**（注释说不能，代码说能） | **P0 安全** | T99+T104 | ZZ | ✅ done（`a11b9a17`，582/582） |
| T106 | **`level` 有分级但没有语义**：error/warning 并列计数 | **P0 判据体系** | F 的设计评估 | ZZ | ✅ done（`64a34162`，t73 51/51） |
| T107 | 🔴 **`filter: () => true` 不是万能的**：cpSync 第三种崩溃形态（非 ASCII 源 + 目标已存在） | **P0 基础设施** | T92 | ZZ | ✅ done（`37c28251`，新套件 20/20；2 处待验证） |
| T108 | 🔴 **`t76` 把缺陷状态写成断言**：`releaseEligible === false` 现在恒红 | **P0 测试正确性** | T10 | ZZ | ✅ done（`cad5cfbf` + `cdd5af6a`） |
| T109 | **审批没有历史**：`pendingApprovals` 是内存 Map，进程退出即丢 | **P0 产品主线** | T99+T104 | ZZ | ⬜ 待开工 |
| T110 | **`DeckElement.paragraphs` 类型漏了上游规范的字段**（唯一一条 `tsc` 错误） | **P1 类型缺陷** | T100b | ZZ | ⬜ 待开工（F） |
| T111 | **任务详情视图**：把 `origin`/`artifacts`/`acceptance`/失败原因接上落点 | **P0 产品主线** | T102+T109 | ZZ | ⬜ 待开工（E） |
| T112 | **`agent_read_url` 报 `fetch failed`**：一条无法用于判断的错误（也是全量偶发红之一） | **P1 产品缺陷** | 无 | ZZ | ⬜ 待开工 |
| T113 | **`hook-runner-smoke` 一条时序假设**：「撤权一定发生在第 2 条 spawn 之前」（全量偶发红之二） | **P1 测试正确性** | 无 | ZZ | ⬜ 待开工 |
| T114 | **`design-tokens-smoke` 那条判据只认一种写法**：`bg-accent/15 text-accent` 紧邻组合，其他四种写法全漏 | **P1 测试判别力** | T111 | ZZ | ⬜ 待开工 |
| T115 | 🔴 **中文 docx 没有 `w:eastAsia`**：上游有能力（`BlankDocxOptions`），CLI 的 `blankDocument()` 没传 | **P0 产品缺陷** | T102 | ZZ | 🔄 进行中（F） |
| T116 | **六处选中态改用中性色**（T114 判据改造后暴露） | **P0 产品缺陷** | T114 | ZZ | ✅ done（`de6cd867`，345/345；深色 ring 待裁决） |

### T43 为什么是 P0（用户最高痛点）

> **⚠️ 2026-10-23 核查：本节的下半部分（「断掉的是三处」）已过期，代码已改。**
> 逐条现状见文末 `## 叙述核查（2026-10-23）` 的 #15–#19。摘要：
> `DOCUMENT_QA_GATES` 的 pdf/markdown/html 现在**不是空数组**（都是 `render-probe`）、
> `CLI_TOOL_MAP.slides` 现在**有** `build_deck: "create"`、
> `document_md_read` 现在按扩展名分派（`readAnyDocument`），不再只走 `docs read`。
> **保留原文是为了记住「当时的判断依据」，不是现状。**
> 另外：**代码改了不等于卡完成** —— T43 卡仍是 `ready-for-agent`，
> 而「产物好不好看」至今没有 U1 验证。

用户原话：「让 ai 改 word，改 ppt 这种有格式要求的很烂，而且很丑，简直不能看」。

我查清后**修正了原来的判断**——不是「工具不够」，工具在的：

- `document_render`（`tools.ts:1312`）真把 PNG 作为 image 块塞回模型，预览这条通；
- 编辑后强制跑 `docs check` / `sheet check` / `slides audit`，机制在；
- 139 个工具的目录驱动发现，在。

**断掉的是三处**：

1. `DOCUMENT_QA_GATES` 里 **pdf / markdown / html 是空数组** —— 改完什么都不检查；
2. `CLI_TOOL_MAP.slides` **只有 read 和 apply，没有 create** —— 模型没有任何途径新建 PPT；
3. **PPT 设计流水线完全没接线** —— `plan_deck` / `generate_deck` 在目录里有名字，`cliRouteFor` 没有、`genofficeCli.ts` 没有实现。**目录承诺了能力，调用时没有**，这是最坏的一类；
4. **`createFromFile` 的类型被故意收窄到 `docx | xlsx`** —— PPT 根本造不出来。而这是 **T74 有意为之**：`create --type pptx --spec <dir>` 要读一个目录里的多个文件，T74 没为它建围栏。**所以不是「没接」，是「被安全策略挡住」——T43 要用围栏解决，不许把 `"pptx"` 直接加进联合类型。**
5. **`document_md_read` 只走 `docs read`（Word 专属命令）** —— `.md` / `.html` / `.txt` / `.xlsx` / `.pptx` / `.pdf` **全都读不了**。这是用户「读文件也不全面」的直接原因，而 CLI 明明有 `pdf read` / `sheet read` / `slides read`（注意：`convert` **不支持** `md→md` / `html→md`，所以文本类只能直接读文件）。

### T44 为什么开卡（**更正：原判断已过期**）

A 的 T29 全量报告是 **536 通过 / 7 失败**，其中 `genoffice-source-smoke` 与 `genoffice-vendor-freshness-smoke` **单跑全绿**（26/26、29/29）。

**总控最初判断**是「`genoffice-source-smoke/main.cjs` 原地篡改真实 vendor 工作树」——**那个判断基于 T31 修复前的代码**：

```
a10c705c  10-23 15:03  fix(T31): …          ← 已改成"克隆到副本上篡改"
466a4dae  10-23 19:04  docs(tasks): open T44  ← 卡在这之后 4 小时写的
```

**T31 已经把篡改改成克隆到 OS 临时目录**，并且 `main.cjs:244-247` 已有断言 `"real GenOffice vendor checkout was not modified"`。C 会话实测：并发 3×3 = **9/9 全绿**，Ctrl-C 中断后 vendor **干净**，克隆耗时 **5.6 秒**（4764 文件）。

**所以 T44 改为「防回退回归」**：T31 之所以要修，恰恰因为曾经有人写成原地篡改；**现在没有任何东西保证它将来仍然对**。

主力断言是**静态守卫**（毫秒级，不跑测试）：这几个套件里任何写调用都不许出现真实 vendor 路径，且必须存在 `git clone` 到临时目录。中断卫生与并发全绿作为运行时检查跟在后面。

**Priority 降为 P2 —— 它保护的是一个已经正确的东西。**

**总控的教训**：写卡前没核这条线的提交历史，开了一张描述过时代码的卡。

上游 `genoffice/skills/genoffice/SKILL.md` 的 `## Designing a deck` 是唯一能做出好看 deck 的方法（style.md → outline.json → 逐页 NN.json → check → create → render --grid → audit → 最多两轮修），Mcode 一个环节都没接。


### 推荐第一波（**2026-10-23 核查后更新：原推荐里 4 张已完成**）

原推荐是「T0、T1、T5、T6、T9」。核查后 **T1 / T5 / T6 已是 done**（T10 也已交付），
所以现在的第一波是 **T0、T9**；T2/T3 可并行启动，但开工后必须先声明准确独占文件集合，
发现重叠即停，不允许同文件多代理写入。**T4 与 T11 已完成**，不要再派。
`T7/T8` 绝不同时占用 Electron。

> 完整状态见上方表格的「状态」列 —— **那一列由各卡自己的 `- Status:` 行生成**，
> 不要再凭记忆判断谁做完了。改卡状态时同步这一列（或照它的规则重新生成）。

### 产品路线基线波（**2026-10-23 核查：四张里三张已交付**）

> **T12 / T13 / T14 已交付**（`5609c955` / `03e30e73` / `c2de98c5`），报告都在
> `docs/planning/product-roadmap/`。**只剩 T15**：报告文件已存在，但卡仍是 `ready-for-agent`，
> 且回写区没有提交 SHA —— 需要有人确认它到底是完成了还是中途停了。
> 另外 **T13 报告的三个发行阻塞已被 T23/T25 修掉**，读它时注意。

T12、T13、T14、T15 均为**只读源码调查**，各自只写入独立报告文件，彼此可并行；它们不得修改产品代码、测试、正式审查台账或其他任务卡。四份矩阵齐备后，由总控根据证据拆下一批实现卡，不先猜文件边界。路线恢复稿和来源置信度记录位于 `.scratch/mcode-product-roadmap/spec.md`、`sources.md`、`map.md`。

### 结构性缺口波（T16–T20，2026-10-23 新增）

> **2026-10-23 核查：T17 / T18 / T19 / T20 已交付，T16 存疑。**
> - T17（`95625434`）、T18（`e6515e45`）、T19（`1dd4211f`）、T20 均已 done；
> - **T16**：`apps/desktop/scripts/electron-u1/` 骨架文件已存在
>   （`runner.ts` / `steps.ts` / `verdict.ts`），**但卡仍是 `ready-for-agent`，
>   且 grep 不到任何套件引用它** —— 骨架写了没人用，正是本仓库吃过亏的那一类。
>   下次派 T7/T8 前必须先确认这一点（见「叙述核查」#11）。

这五张卡补的是**「谁都绕不过去、但一直没人开卡」**的地基：

- **T16** 是最大结构性缺口。现有 `arc005-visual-baseline` 只能拍静态截图，没有可复用的「启动真 Electron → 操作 → 断言」骨架。T7、T8、ARC-005 V4 全卡在这里。**先做 T16，T7/T8 才有意义。**
- **T17** 是 GenOffice 全线地基：契约层已有 `documentKind.ts` / `genofficeFileRoute.ts`，但上层仍有多处各自判定扩展名。不收干净，每接一个编辑器就多一份判据。
- **T18 → T19 → T20** 是扩展线的完整依赖链。产品要求是「装的时候弹权限卡片，像手机装软件」。
  **T18 与 T19 均已交付**（`e6515e45` / `1dd4211f`）；T20 可开工。
- 并行关系：T16、T17、T18 三者互不冲突，可同时开。T19 等 T18，T20 等 T18+T19。

### 当前受阻（不要派）

- **T7 / T8** 需要真实 Electron U1 骨架 → 等 **T16** 交付。
- **T3** 与 T2/T4 共享工作流热文件 → 等 T2 收（**T4 已完成**，只剩 T2）。
- **T11** 已交付但不等于可发行：4 个包缺权利方材料，`releaseEligible=false` 是设计结果，
  **不要当未开工卡再派一遍**；解除条件写在 T11 回写末节。
- **已解除**：T10（已交付 `782b08fc`）、T21（已交付 `6e690e48`，T2/T4 的写路径冲突已不成立）、
  T1/T5/T6（均已 done）。

### 结构性发现（T14 基线，2026-10-23）

> **⚠️ 2026-10-23 核查：六条里三条仍成立、三条已修。** 逐条见文末
> `## 叙述核查（2026-10-23）` 的 #1–#6。
> **仍成立**：flow 存储两份（#1）、`engine-trust.json` 无生产 writer（#4）、无持久运行史（#6）。
> **已修**：执行归属账本已有跨进程租约（T4，`6a1dc9d5`，#2）、
> `buildTriggers` 已按引擎归属装监听（T3 的代码已在树上，但**卡未回写**，#3）、
> 两个悬挂适配器已接生产（T21，`6e690e48`，#5）。
> 下面保留 T14 当时的原文。

T14 报告查出六处「单一事实源」竞争，其中两处已开卡：

- **flow 存储**：SQL `WorkflowDoc` 与引擎 `flows.json` 是两份持久化，Deploy 后的镜像 fire-and-forget（→ **T2**）。
- **执行归属账本**：`executor-ownership.json` 无跨进程锁，而**同目录**的 `NodeRedFlowStorage` 已有 `withOsFileLease`（→ **T4**）。
- **触发安装**：旧 `automationRunner.buildTriggers` 不看 `doc.engine`，`engine=node-red` 的图照样装 cron/fs.watch（→ **T3**）。
- **审批**：SQL `workflow.review.v1.*` 与引擎 `engine-trust.json` 互不引用，后者生产代码**无 writer**（→ 待开卡）。
- **悬挂适配器**：`NodeRedFlowStorage`（609 行）与 `workflowMigrationPreflight`（1631 行）**零生产调用方**，却各有测试护航（→ **T21，已交付 `6e690e48`**；T21 回写里纠正了一处：整份 `nodeRedStorage.ts` 有调用方，零调用方的是 `NodeRedFlowStorage` 类）。
- **运行历史**：旧 runner 有 `runStore` 持久化；Node-RED 原生只有内存 runboard，**无持久运行史**（→ 待开卡）。

## 叙述核查（2026-10-23）

> 逐段核对本文件里的事实性断言（「零命中」「没有 X」「N 个」「从来不做 Y」）。
> 方法：只读 `grep` + 读源码 + 查卡 Status。**没有跑会写盘的套件，没有起 Electron。**
> 判据：`✅ 仍成立` / `❌ 已过期（现状是…）` / `❓ 无法核实（说明为什么）`。

| # | 段落 | 原断言 | 现状 | 判 |
|---|---|---|---|---|
| 1 | 结构性发现-01 | 「SQL `WorkflowDoc` 与引擎 `flows.json` 是两份持久化，Deploy 后的镜像 fire-and-forget」 | **仍成立**。`registry.ts` 仍同时持有 `WorkflowDoc` 与 `nativeLibrarySync`（`:753/:767`），镜像仍是 Deploy 之后的异步回调 | ✅ |
| 2 | 结构性发现-02 | 「`executor-ownership.json` 无跨进程锁，而 `NodeRedFlowStorage` 已有 `withOsFileLease`」 | **❌ 已过期**。T4 已交付（`6a1dc9d5`）：`fileExecutorOwnershipStore.ts` 现在 `import { withOsFileLeaseSync }`（`:17`），写路径与启动对账都在租约内（`:87`、`:208`） | ❌ |
| 3 | 结构性发现-03 | 「旧 `automationRunner.buildTriggers` 不看 `doc.engine`，`engine=node-red` 的图照样装 cron/fs.watch」 | **❌ 已过期**。代码里有 `【T3】装监听之前先看引擎归属`（`automationRunner.ts:550-552`，`legacyTriggerOwnerOf(doc)`）——**但 T3 卡仍是 `ready-for-agent`，未回写** | ❌ |
| 4 | 结构性发现-04 | 「SQL `workflow.review.v1.*` 与引擎 `engine-trust.json` 互不引用，后者生产代码**无 writer**」 | **✅ 仍成立**。`engine-trust.json` 只在 `registry.ts:414-421` 被**读**（`{"trusted":true}` 才算数），全仓仍无生产 writer | ✅ |
| 5 | 结构性发现-05 | 「`NodeRedFlowStorage`（609 行）与 `workflowMigrationPreflight`（1631 行）零生产调用方」 | **❌ 已过期**。T21 已交付（`6e690e48`）：`nativeLibraryLoad.ts:77` import 并 `:194` new，`workflowMigrationGate.ts` 调 `runWorkflowMigrationPreflight`。**行数 609/1631 仍准确** | ❌ |
| 6 | 结构性发现-06 | 「Node-RED 原生只有内存 runboard，**无持久运行史**」 | **✅ 仍成立**。`workflowEngines/` 下无 `runStore` 持久化（只有注释提到将来接） | ✅ |
| 7 | 当前受阻-T3 | 「T3 与 T2/T4 共享工作流热文件 → 等 T2/T4 收」 | **半过期**。T4 已完成（`6a1dc9d5`），只剩 T2；且 T3 的代码修复已在树上（见 #3） | ❌ |
| 8 | 当前受阻-T10/T11 | 「需要 T9 的取证与策略裁决」 | **❌ 已过期**。T10（`782b08fc`）与 T11（`f9b8bfec`）都已交付；T11 仍 `releaseEligible=false` 是**设计结果**（4 包缺权利方材料），不是「等 T9」 | ❌ |
| 9 | 当前受阻-T21 | 「T21 要接的写路径与 T2/T4 重叠 → 等它们提交」 | **❌ 已过期**。T21 已交付（`6e690e48`） | ❌ |
| 10 | 产品路线基线波 | 「T12、T13、T14、T15 均为只读源码调查…可同时派发」 | **半过期**。T12/T13/T14 已交付（报告在 `docs/planning/product-roadmap/`），**T15 报告文件存在但卡仍 `ready-for-agent`** | ❌ |
| 11 | 结构性缺口波-T16 | 「T16 是最大结构性缺口…T7/T8 全卡在这里」 | **半过期**。`apps/desktop/scripts/electron-u1/` 骨架已存在（`runner.ts`/`steps.ts`/`verdict.ts`），**但卡仍 `ready-for-agent`，且没有套件引用它** | ❓ |
| 12 | 结构性缺口波-T17 | 「契约层已有…但上层仍有多处各自判定扩展名」 | **❌ 已过期**。T17 已交付（`95625434`），六个新导出都在 `documentKind.ts` | ❌ |
| 13 | 结构性缺口波-T18/T19 | 「当前**没有任何安装确认 UI**（`grep installConfirm` 零命中）」 | **❌ 已过期**（本会话早些时候已改，此处留档）。`ModuleInstallConsentCard.tsx` 存在，契约有 `installConsent` | ❌ |
| 14 | T43 段-工具在 | 「`document_render`（`tools.ts:1312`）真把 PNG 作为 image 块」「139 个工具的目录驱动发现在」 | **✅ 仍成立**（行号已漂移，函数仍在） | ✅ |
| 15 | T43 段-断点 1 | 「`DOCUMENT_QA_GATES` 里 **pdf / markdown / html 是空数组**」 | **❌ 已过期**。现在是 `pdf:["render-probe"]`、`markdown:["render-probe"]`、`html:["render-probe"]`（`documentToolSurface.ts:88-95`） | ❌ |
| 16 | T43 段-断点 2 | 「`CLI_TOOL_MAP.slides` **只有 read 和 apply，没有 create**」 | **❌ 已过期**。现在有 `build_deck: "create"`（`documentToolSurface.ts:414`），注释写明「【T43】整份 deck 的设计流水线」 | ❌ |
| 17 | T43 段-断点 3 | 「PPT 设计流水线完全没接线 — `plan_deck`/`generate_deck` 在目录里有名字，`cliRouteFor` 没有」 | **❓ 部分过期**。`cliRouteFor` 对 `build_deck` 有 `create` 路由；但 `plan_deck`/`generate_deck` 在 `genofficeCli.ts` 里仍 grep 不到实现 | ❓ |
| 18 | T43 段-断点 5 | 「`document_md_read` 只走 `docs read`，`.md/.html/.txt/.xlsx/.pptx/.pdf` 全都读不了」 | **❌ 已过期**。`documentToolRuntime.ts:812-816` 有 `【T43】缺口五` 注释，现走 `readAnyDocument` 按扩展名分派 | ❌ |
| 19 | T43 段-结论 | 「上游 SKILL.md 是唯一能做出好看 deck 的方法，Mcode 一个环节都没接」 | **❌ 已过期**。同 #16/#18，管线已接；但**真正好不好看没有被验证过**（无 U1） | ❌ |
| 20 | T44 段 | 「T31 已把篡改改成克隆到 OS 临时目录，`main.cjs:244-247` 有断言」 | **✅ 仍成立** | ✅ |
| 21 | 表格 T40 行 | 「`withRendererToolRegistry` 零调用点 —— `document.tool_call` 渲染端路线不可达」 | **❌ 已过期**，但**这条在表格不在叙述**。`ipc/index.ts:19` import、`:175` 调用 `withRendererToolRegistry(docsAiPorts)` | ❌ |

### 汇总

- **仍成立 5 条**（#1 #4 #6 #14 #20）——都是「**没有**某能力」这类否定断言，它们比肯定断言更耐久。
- **已过期 14 条**（#2 #3 #5 #7 #8 #9 #10 #12 #13 #15 #16 #18 #19 #21）。
- **无法/部分无法核实 2 条**（#11 #17）。

### 最严重的三条

1. **#15 #16 #18 #19 —— T43 整段已过期，但 T43 卡仍是 `ready-for-agent`。**
   这段是 README 里最长、最像「事实」的叙述，读者会据此认为文档 AI 仍然做不好 deck。
   实际代码里 `DOCUMENT_QA_GATES` 已填、`build_deck` 已接线、`readAnyDocument` 已分派——
   **T43 的活已经做在树上了**。照这段派活会重做一遍。**但「好不好看」确实仍未被 U1 验证**，
   所以不能简单说「T43 完成了」，见下。

2. **#3 —— T3 的代码修复已在树上（`【T3】` 注释 + `legacyTriggerOwnerOf`），但 T3 卡是 `ready-for-agent`。**
   这和 T43 是同一个模式：**代码先行，卡未回写**。这类卡最危险——派出去会让执行会话
   与已有实现打架。

3. **#21 —— T40 的前提（`withRendererToolRegistry` 零调用点）已不成立**，
   而 T30 的 `blocked-on-T40` 依赖它。如果 T40 的前提是错的，T30 的阻塞理由也要重核。

### 这次核查**没有**做的事

- 没有重跑任何套件（只读指令）。
- 没有验证「代码已落地」的那些卡**是否真的验过**——`【T43】` 注释只证明代码改了，
  不证明它的验收判据过了。**代码在 ≠ 卡完成**，这条界限对 #3 和 #15-#19 同样适用。
- `❓` 的两条没深挖，因为都需要跑套件或起 Electron 才能定论。

## 历史和真值来源

- 旧卡正文、旧任务 README/模板/路线图及 SHA-256：`archive/legacy-2026-10-22/`。
- 正式风险、缺陷和验收状态：`../audit-ledgers/README.md` 及 `../audit-ledgers/Mcode_统一审查台账.md`。
- Skill 工程规划（探索、spec、决策图）：`.scratch/<feature-slug>/`；它不是正式执行卡，也不替代本目录的执行验收。
