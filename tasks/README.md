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
| T45 | **权限映射生成器会静默放宽：`document.*` 整个域落进 `write`** | **P0 安全** | T33 | DD | ⬜ 待开工 |
| T46 | 审批卡的真 Electron U1（T6 的 E1 覆盖不到：真窗口键盘 / 多窗口焦点 / settingsOpen 暂停 / 后台会话） | P1 安全回归 | T6 | A | ✅ done（U1 11 步） |
| T47 | **模型拿不到 `guide slides design` —— 设计流水线的「教」这一半还是断的** | **P0 产品能力** | T43 | BB | ✅ done（27/27） |
| T48 | AI 看不见 Node-RED 节点 | P0 | T8+T21 | CC | ❌ 关闭（前提不成立：`node_types_list` 一直存在，在 `mcp/mcodeServer.ts`） |
| T49 | **扩展线核实 → 撞出主界面首帧白屏** | P0 产品缺陷 | T41 | GG | ✅ done（7/7） |
| T51 | **给模型「工作流怎么搭」的规范**（对齐 T47 的设计指南） | P0 | T47 | EE | ✅ done（33/33） |
| T52 | **`setting.set` 可覆盖凭据**（读侧拦了，写侧没拦） | **P0 安全** | T33 | HH | ✅ done（27/27） |
| T53 | **多方会议（代理互相讨论）** | P2 | agentMail 3.17 | FF | ✅ done（30/30，产品代码零改动） |
| T54 | **两套工具面分开：`app_api_list` 看不见 `mcode-workflow` 的 14 个工具** | **P1 可发现性** | 无 | DD | ✅ done（17/17） |
| T60 | **仓库迁移后的全量基线恢复**：3423 个符号链接 + 4 套失败 | **P0 基础设施** | 无 | ZZ | ✅ done（557 套，4 个真失败全修） |

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
