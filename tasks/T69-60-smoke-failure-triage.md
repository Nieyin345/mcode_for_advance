# T69｜T68 全量 60 套 Smoke 失败：冻结、归因与分派清单（只读诊断）

| 项目 | 值 |
|---|---|
| 编号 | T69 |
| 类型 | 测试基线 / 全局诊断，关联 ARC-005/006/007 与各 MC |
| 优先级 | 最高：先分辨真实产品红灯与环境/脚本/并行污染 |
| 复用等级 | L1 现有 `run-smokes.mjs`、T68 原始日志与各领域原测试；**不新建第二个测试运行器** |
| 状态 | 可派，**只读业务/测试源码** |
| 写边界 | **仅**本任务结果回写区、必要临时分析输出 `.tmp/t69-*`；不得改产品代码或已有测试脚本 |

## 问题与唯一可信证据
T68 记载 2026-10-21 Windows 全量 `510 suites = 450 PASS / 60 FAIL`，原始证据 `.tmp/t68-all-smokes.log`，其时存在并行修改且并非 60 项逐一验过的单一冻结源码。四个指定回归（automation、event-vertical、orchestration、app-control）已有回绿记录。60 FAIL **不能直接等于 60 个产品 Bug**；任何“环境导致”判断要拿到单套的错误证据，禁止按猜测扫掉红项。

## 开工前必读
1. `audit-ledgers/README.md`，`tasks/T68-smoke-baseline-recheck.md` 的完整回写、`tasks/T52-smoke-rescue.md` 与 `tasks/T61-smoke-missing-electron-stub.md`。
2. `apps/desktop/scripts/run-smokes.mjs`、`apps/desktop/scripts/run-all-smokes.sh`（以仓库实际路径为准）和 `.tmp/t68-all-smokes.log`。
3. 最新 `git status --short`、`git log -1`；特别确认 T49 正在修改 `main/modules/*`、`main/appControl/*` 与若干测试脚本，**不得覆盖或提交他人改动**。
4. 统一台账中对应领域已存在的 MC/ARC，优先归并，禁止创建重复缺陷编号。

## 执行内容
1. 核对原日志确有 60 个 FAIL，逐个登记 suite 名、首个有意义错误（构建/环境/运行/断言/超时）、日志位置、涉及源文件、同次 git HEAD 与工作树是否稳定；每一项一行，不省略“原因未定”。
2. 按可证实类别分组：A 环境/Windows shell/OS 资源；B 测试装配旧断言；C 明确产品行为回归；D 并行未提交/共享代码半成品；E 未定。每类给数量和可核查依据；不按关键词无证猜根因。
3. 从每类选**有安全隔离**的代表套件独立复现；只有确认不与在飞 Electron 或 `packages/contracts` 编辑冲突时才单跑。明确标记“未复跑/复跑确认/单跑通过/仍失败”。不要运行 `--all` 与并行 Electron 探针争资源。
4. 对真实失败输出“建议后续 TASK 标题、负责文件、最小复现、可验收红绿条件、与已建任务的归并关系”。只归因和写建议，**本卡不修任何产品/测试代码**；总控负责编号、派卡。
5. 检查指定旧 4 套是否已从 T68/T67 获得足够现有证据；避免给已复绿事项二次立单。记录本卡不具备的独立 U1 证据。

## 验收判据
1. **60/60** 逐套有编号、日志定位、证据类别或明确“未定”，分类数量合计准确为 60。
2. 每个被断言为“环境/过时测试/产品错误”的条目都有至少一条可复核的首错日志与源码联系；否则归为 E 未定。
3. 诊断结果能直接形成相互无文件边界冲突的后续任务建议；无法拆分的共享热区标明串行。
4. 没有编辑任何既有产品源码、已有测试和他人未提交文件；无 `git reset/stash/add .`。
5. 无新断言则变异验证 **不适用**（需在回写注明）；若新增诊断脚本只在 `.tmp/t69-*` 使用，必须做简单负控证明解析不漏 FAIL。
6. 若不能安全复跑，明确 `REVIEW_INSUFFICIENT` 而不是写 `REVIEW_PASSED`；仅凭日志静态归因最高记 E2/E3。

## 边界（不要碰）
不修改 `apps/desktop/src/**`、`apps/desktop/scripts/**`、`packages/**`、`genoffice/**`、`node-red/**`、既有其它任务卡或全局台账；只写自己的卡。正式 MC/ARC 双勾由总控负责。

## 结果回写区
<!-- 执行对话追加 60 项逐套分类及证据；报告过长可在本卡用折叠附录，不另立状态台账。 -->

### 2026-10-21 T69 执行诊断（只读，REVIEW_INSUFFICIENT）

- **原始证据**：仓库根 `.tmp/t68-all-smokes.log`，SHA256 `f564c61a37e54eabdd3958f88d2f42d734d4c05be4b93673a980db7eeaab3c44`。开头记载 `Running 510 suites (light ×2, browser ×1)`，结尾 `450 pass, 60 fail (510 suites)`；60 个逐行 `FAIL ... (exit=...)` 与末尾 60 项清单逐名一致。日志目录 `apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/` 含对应单套日志。解析器仅在 `.tmp/t69-parse.cjs` 与 `.tmp/t69-detail.cjs`，负控追加虚构 `FAIL t69-control-smoke` 后结果 **60→61**、控制项被识别。
- **源码版本/并行事实**：T68 最初记载 HEAD `64179174f6a3f5d56dc573425490597cb4a9a68b`，但没有为这次全量 510 套记录不可变的同一 Git tree 或工作树 SHA，不能把开工 HEAD 冒充整轮冻结版本。T69 取证时 HEAD `08a796964f806ee4af1650a9f9470d25eb4584d2`；`git status --short` 存在 T49 `modules/*`/`appControl/*`、其测试及 FileEditor/orchestration/contracts 等并行脏文件，后续文件列表仍变化。60 项属于**历史混合工作树**，非现版本的全量红/绿结论。
- **五类统计**：A 环境/Windows shell/OS 资源 **50**（`sort -V` 22、`ln -s node_modules` 27、WSL 启动/引号失败 1）；B 装配/过期索引或源码形状断言 **6**；C 已证稳定产品回归 **0**；D 并行未提交与共享代码不一致 **3**；E 仍未定 **1**。**50+6+0+3+1=60**。B 的归类有可定位桩/源码差异；D/E 不表示产品无缺陷，仍需冻结后定性。
- **独立安全复跑（E1）**：在 `apps/desktop` cwd 用 `D:\anaconda1\Library\usr\bin\bash.exe` 调用 `scripts/arc005-focus-ownership-smoke/run.sh`，exit 1：`-V系统找不到指定的文件。`；调用 `scripts/library-import-smoke/run.sh`，exit 1：`ln: failed ... /node_modules: Device or resource busy`（该脚本明确用临时数据根）；调用 `scripts/aoci-index-smoke/run.sh`，exit 1：仍有 `aoci.code.txt` L2173 孤儿、L2176 悬空引用。这三项验证了两类环境首错和索引错误，**均未转绿**；另外 57 项未独立复跑。D/E 与 T49、FileEditor、Electron 探针在飞热区相关，未安全复跑，**未运行 --all**。
- **旧四套去重**：T68 已有 `automation-smoke` 820/820 加 restart 10/10，`event-vertical-smoke` 26/26，`orchestration-ipc-smoke` 433/433；T67 的 `app-control-smoke` 572/572（含 `workflowEngine.load`），这四套在原全量均 PASS，不另开重复任务。T68 后续 typecheck 恢复不代表全部 60 失败消失。
- **证据等级和 U1**：原日志是历史 E1，当前逐套源码联系为 E2/不稳定因果为 E3；独立 E1 仅上述三例。没有冻结源码后的真实 Electron 全功能主窗口、多 SDK 在线、双 OS、远端 sshd U1；不具备全局 `REVIEW_PASSED`。没有新增测试断言或代码补丁，**变异验证不适用**；只做解析负控。

#### 60/60 逐套分类与证据

表格中日志位置均指原始全量日志的失败头行与对应单套日志中的首个有意义报错。A 的每行还列出实际 run.sh 的 `sort -V` / `ln -s` 行，B/D/E 的每行均有可核验代码或夹具联系；除已注明的三项独立复跑外，其余均为“未复跑”。

| # | 套件 | 类 | 全量日志 | 源码关联、首次错误、复跑状态 |
|---:|---|:---:|---|---|
| 01 | aoci-index-smoke | B | `.tmp/t68-all-smokes.log:L10`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/aoci-index-smoke.log:L2` | aoci.code.txt:L2173,L2176（索引孤儿和悬空引用）；本卡 E1 再现 FAIL |
| 02 | arc005-file-picker-error-smoke | A | `.tmp/t68-all-smokes.log:L23`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/arc005-file-picker-error-smoke.log:L1` | scripts/arc005-file-picker-error-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 03 | arc005-focus-ownership-smoke | A | `.tmp/t68-all-smokes.log:L28`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/arc005-focus-ownership-smoke.log:L1` | scripts/arc005-focus-ownership-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡 E1 再现 FAIL |
| 04 | arc005-gesture-runtime-smoke | A | `.tmp/t68-all-smokes.log:L31`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/arc005-gesture-runtime-smoke.log:L1` | scripts/arc005-gesture-runtime-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 05 | arc005-library-picker-search-smoke | A | `.tmp/t68-all-smokes.log:L35`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/arc005-library-picker-search-smoke.log:L1` | scripts/arc005-library-picker-search-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 06 | arc005-picker-layer-smoke | A | `.tmp/t68-all-smokes.log:L48`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/arc005-picker-layer-smoke.log:L1` | scripts/arc005-picker-layer-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 07 | arc005-recorder-input-smoke | A | `.tmp/t68-all-smokes.log:L51`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/arc005-recorder-input-smoke.log:L1` | scripts/arc005-recorder-input-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 08 | archiver-installer-smoke | A | `.tmp/t68-all-smokes.log:L66`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/archiver-installer-smoke.log:L1` | scripts/archiver-installer-smoke/run.sh:L52（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 09 | capability-smoke | D | `.tmp/t68-all-smokes.log:L94`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/capability-smoke.log:L5` | src/main/modules/{ModuleHost,fileCapabilities,builtinCapabilityCatalogue}.ts；host 少 core.app.call；T49 在飞；本卡未复跑 |
| 10 | claude-ipc-smoke | A | `.tmp/t68-all-smokes.log:L110`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/claude-ipc-smoke.log:L1` | scripts/claude-ipc-smoke/run.sh:L38（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 11 | codex-effort-smoke | A | `.tmp/t68-all-smokes.log:L120`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/codex-effort-smoke.log:L1` | scripts/codex-effort-smoke/run.sh:L31（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 12 | design-tokens-smoke | A | `.tmp/t68-all-smokes.log:L144`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/design-tokens-smoke.log:L1` | scripts/design-tokens-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 13 | document-router-smoke | A | `.tmp/t68-all-smokes.log:L156`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/document-router-smoke.log:L1` | scripts/document-router-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 14 | document-view-renderer-smoke | D | `.tmp/t68-all-smokes.log:L164`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/document-view-renderer-smoke.log:L131` | src/renderer/components/ide/FileEditor.tsx:useGitDiffPair；useGitStore 未定义；T68 后续类型回绿；本卡未复跑 |
| 15 | emit-path-smoke | B | `.tmp/t68-all-smokes.log:L194`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/emit-path-smoke.log:L26` | scripts/emit-path-smoke/main.ts + src/main/workflowEngines/nodePackProductionPorts.ts:18,57；动态 type=e 扫描假阳性；本卡未复跑 |
| 16 | engine-bootstrap-integrity-smoke | A | `.tmp/t68-all-smokes.log:L219`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/engine-bootstrap-integrity-smoke.log:L1` | scripts/engine-bootstrap-integrity-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 17 | engine-secret-integrity-smoke | A | `.tmp/t68-all-smokes.log:L240`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/engine-secret-integrity-smoke.log:L1` | scripts/engine-secret-integrity-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 18 | engine-secret-path-safety-smoke | A | `.tmp/t68-all-smokes.log:L243`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/engine-secret-path-safety-smoke.log:L1` | scripts/engine-secret-path-safety-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 19 | flow-migration-smoke | A | `.tmp/t68-all-smokes.log:L268`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/flow-migration-smoke.log:L1` | scripts/flow-migration-smoke/run.sh:L11（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 20 | flow-snapshot-isolation-smoke | A | `.tmp/t68-all-smokes.log:L272`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/flow-snapshot-isolation-smoke.log:L1` | scripts/flow-snapshot-isolation-smoke/run.sh:L7（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 21 | genoffice-mcp-smoke | A | `.tmp/t68-all-smokes.log:L283`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/genoffice-mcp-smoke.log:L1` | scripts/genoffice-mcp-smoke/run.sh:L40（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 22 | library-adopt-smoke | A | `.tmp/t68-all-smokes.log:L316`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/library-adopt-smoke.log:L1` | scripts/library-adopt-smoke/run.sh:L37（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 23 | library-delete-smoke | A | `.tmp/t68-all-smokes.log:L321`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/library-delete-smoke.log:L1` | scripts/library-delete-smoke/run.sh:L40（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 24 | library-entry-path-smoke | A | `.tmp/t68-all-smokes.log:L324`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/library-entry-path-smoke.log:L1` | scripts/library-entry-path-smoke/run.sh:L23（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 25 | library-import-smoke | A | `.tmp/t68-all-smokes.log:L327`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/library-import-smoke.log:L1` | scripts/library-import-smoke/run.sh:L15（/tmp/node_modules 链接 Device or resource busy）；本卡 E1 再现 FAIL |
| 26 | library-mcp-smoke | A | `.tmp/t68-all-smokes.log:L330`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/library-mcp-smoke.log:L1` | scripts/library-mcp-smoke/run.sh:L33（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 27 | library-move-smoke | A | `.tmp/t68-all-smokes.log:L333`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/library-move-smoke.log:L1` | scripts/library-move-smoke/run.sh:L30（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 28 | library-pdf-writeback-host-smoke | A | `.tmp/t68-all-smokes.log:L337`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/library-pdf-writeback-host-smoke.log:L1` | scripts/library-pdf-writeback-host-smoke/run.sh:L7（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 29 | library-trash-smoke | A | `.tmp/t68-all-smokes.log:L345`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/library-trash-smoke.log:L1` | scripts/library-trash-smoke/run.sh:L24（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 30 | maint-c-followup-smoke | A | `.tmp/t68-all-smokes.log:L352`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/maint-c-followup-smoke.log:L1` | scripts/maint-c-followup-smoke/run.sh:L10（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 31 | maint-m33-smoke | A | `.tmp/t68-all-smokes.log:L382`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/maint-m33-smoke.log:L1` | scripts/maint-m33-smoke/run.sh:L21（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 32 | maint-m35-smoke | B | `.tmp/t68-all-smokes.log:L389`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/maint-m35-smoke.log:L14` | scripts/maint-m35-smoke/run.sh + stubs/reactEffects/index.ts；React default 桩未导出；本卡未复跑 |
| 33 | mc035-egress-isolation-smoke | A | `.tmp/t68-all-smokes.log:L427`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/mc035-egress-isolation-smoke.log:L1` | scripts/mc035-egress-isolation-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 34 | mcode-admin-smoke | B | `.tmp/t68-all-smokes.log:L432`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/mcode-admin-smoke.log:L1` | scripts/mcode-admin-smoke/{run.sh,stubs/*} + scripts/mcp-endpoint-smoke/stubs/libraryServer.ts；多个新增导出缺桩；本卡未复跑 |
| 35 | mcp-endpoint-smoke | B | `.tmp/t68-all-smokes.log:L460`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/mcp-endpoint-smoke.log:L1` | scripts/mcp-endpoint-smoke/run.sh；sherpa-onnx 各平台 .node 无 esbuild loader/external；本卡未复跑 |
| 36 | mcp-ipc-smoke | A | `.tmp/t68-all-smokes.log:L486`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/mcp-ipc-smoke.log:L1` | scripts/mcp-ipc-smoke/run.sh:L86（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 37 | md-image-guard-smoke | A | `.tmp/t68-all-smokes.log:L492`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/md-image-guard-smoke.log:L1` | scripts/md-image-guard-smoke/run.sh:L19（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 38 | memory-codex-smoke | A | `.tmp/t68-all-smokes.log:L497`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/memory-codex-smoke.log:L1` | scripts/memory-codex-smoke/run.sh:L26（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 39 | module-extension-lifecycle-smoke | A | `.tmp/t68-all-smokes.log:L523`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/module-extension-lifecycle-smoke.log:L1` | scripts/module-extension-lifecycle-smoke/run.sh:L8（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 40 | module-permissions-smoke | D | `.tmp/t68-all-smokes.log:L528`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/module-permissions-smoke.log:L11` | packages/contracts/src/appPermission.ts + scripts/module-permissions-smoke/main.ts:16-19；缺 workflowEngine.load，T49 在飞；本卡未复跑 |
| 41 | module-protocol-integrity-smoke | A | `.tmp/t68-all-smokes.log:L556`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/module-protocol-integrity-smoke.log:L1` | scripts/module-protocol-integrity-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 42 | pdf-annotation-smoke | A | `.tmp/t68-all-smokes.log:L593`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/pdf-annotation-smoke.log:L1` | scripts/pdf-annotation-smoke/run.sh:L22（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 43 | pdf-highlights-integrity-smoke | A | `.tmp/t68-all-smokes.log:L597`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/pdf-highlights-integrity-smoke.log:L1` | scripts/pdf-highlights-integrity-smoke/run.sh:L8（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 44 | pdf-import-atomic-smoke | A | `.tmp/t68-all-smokes.log:L600`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/pdf-import-atomic-smoke.log:L1` | scripts/pdf-import-atomic-smoke/run.sh:L7（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 45 | projects-ipc-smoke | A | `.tmp/t68-all-smokes.log:L621`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/projects-ipc-smoke.log:L1` | scripts/projects-ipc-smoke/run.sh:L29（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 46 | provider-health-smoke | A | `.tmp/t68-all-smokes.log:L626`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/provider-health-smoke.log:L1` | scripts/provider-health-smoke/run.sh:L22（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 47 | relay-smoke | A | `.tmp/t68-all-smokes.log:L635`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/relay-smoke.log:L1` | scripts/relay-smoke/run.sh:L51（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 48 | resume-fault-smoke | A | `.tmp/t68-all-smokes.log:L646`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/resume-fault-smoke.log:L1` | scripts/resume-fault-smoke/run.sh:L24（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 49 | remote-ssh-smoke | A | `.tmp/t68-all-smokes.log:L649`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/remote-ssh-smoke.log:L3` | scripts/remote-ssh-smoke/{main.ts,run.sh}；WSL command/quote/cwd 失败，172/190、job missing 为级联；本卡未复跑 |
| 50 | settings-panel-smoke | B | `.tmp/t68-all-smokes.log:L711`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/settings-panel-smoke.log:L160` | scripts/settings-panel-smoke/main.ts:961-968 + src/renderer/components/settings/HooksPanel.tsx:309-329；正则不认 HookSpecSchema.parse(next)；本卡未复跑 |
| 51 | skill-delivery-smoke | A | `.tmp/t68-all-smokes.log:L738`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/skill-delivery-smoke.log:L1` | scripts/skill-delivery-smoke/run.sh:L33（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 52 | settings-panels-electron-smoke | E | `.tmp/t68-all-smokes.log:L765`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/settings-panels-electron-smoke.log:L33` | src/renderer/components/modules/ModuleContributions.tsx:16-20,34-37 + scripts/settings-panels-electron-smoke/；catalog.modules undefined，夹具/本体未定；本卡未复跑 |
| 53 | theme-ipc-smoke | A | `.tmp/t68-all-smokes.log:L790`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/theme-ipc-smoke.log:L1` | scripts/theme-ipc-smoke/run.sh:L15（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 54 | updater-tools-smoke | A | `.tmp/t68-all-smokes.log:L805`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/updater-tools-smoke.log:L1` | scripts/updater-tools-smoke/run.sh:L80（/tmp/node_modules 链接 Device or resource busy）；本卡未复跑 |
| 55 | vscode-l1-smoke | A | `.tmp/t68-all-smokes.log:L812`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/vscode-l1-smoke.log:L1` | scripts/vscode-l1-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 56 | workflow-engine-bridge-smoke | A | `.tmp/t68-all-smokes.log:L818`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/workflow-engine-bridge-smoke.log:L1` | scripts/workflow-engine-bridge-smoke/run.sh:L7（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 57 | workflow-engine-runtime-smoke | A | `.tmp/t68-all-smokes.log:L822`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/workflow-engine-runtime-smoke.log:L1` | scripts/workflow-engine-runtime-smoke/run.sh:L11（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 58 | workflow-engine-selection-smoke | A | `.tmp/t68-all-smokes.log:L826`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/workflow-engine-selection-smoke.log:L1` | scripts/workflow-engine-selection-smoke/run.sh:L7（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 59 | workflow-extension-seams-smoke | A | `.tmp/t68-all-smokes.log:L829`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/workflow-extension-seams-smoke.log:L1` | scripts/workflow-extension-seams-smoke/run.sh:L10（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |
| 60 | workflow-native-load-smoke | A | `.tmp/t68-all-smokes.log:L832`；`apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/workflow-native-load-smoke.log:L1` | scripts/workflow-native-load-smoke/run.sh:L6（sort -V 在 Windows 被误解释为文件）；本卡未复跑 |


#### 建议后续任务标题、最小红绿与归并（仅建议，由总控编号和派工）

1. **Windows `sort -V` Smoke 入口适配（22 套）**。文件为上表 22 个 `scripts/*/run.sh` 与既有 `scripts/lib/esbuild-path.sh` 复用入口，不造第二 runner。最小红例 `arc005-focus-ownership-smoke`：单跑 `-V系统找不到指定的文件`；验收为所有 22 套真正执行原断言退出 0，而非只消除 shell 首错，暂时恢复错误排序命令则重红。归并既有 **T52/T68** 基线治理；与其它同一 `run.sh` 施工串行。
2. **MSYS `node_modules` 软链接装配修复（27 套）**。文件为上表 27 个独立 `run.sh`，必要时复用现成 smoke helper；不可删 `pdfjs-dist` 等运行时模块的真实验证。最小红例 `library-import-smoke`：`ln ... /node_modules: Device or resource busy`；隔离临时数据根上从打包到全部断言 PASS，恢复旧软链方式必红。归并 **T52/T68**；与建议 1 可按互不相交的脚本文件分片，但共用 helper 修改必须串行。
3. **AOCI 索引孤儿引用同步**。文件 `aoci.code.txt`、必要的 AOCI 维护配置，不动业务源码。最小红例 L2173、L2176 不存在的 `WorkflowCanvas.tsx` 引用；使用原有 `aoci_maintain` 路径修正后 `aoci-index-smoke` 0 违例，负控注入悬空引用再红。归并 **MC-009/T09**；`.aoci/baseline.json` 当前存在并行改动，先由其 owner 串行接手。
4. **缺失 Stub / 原生 Bundle 隔离**。可拆为三个不交叉子域：`maint-m35-smoke/stubs/reactEffects/` 给真实组件需要的 React default 导出；`mcode-admin-smoke/stubs/` 与 `mcp-endpoint-smoke/stubs/libraryServer.ts` 补真实契约的新导出；`mcp-endpoint-smoke/run.sh` 在无关断言路径正确 external `sherpa-onnx-node`。分别以 `No matching export` 和 `No loader ... .node` 为红例，修后**原全部断言** PASS，移走对应必要 stub/external 再红。归并 M35 既有工作包、**ARC-002/MCP 测试基础设施**；**admin 与 endpoint 共享 libraryServer stub，串行**；M35 同期 `pickers-prelude.ts` 有人编辑，不合并不覆盖。
5. **事件扫描器 / HooksPanel 测试形状修订**。两块文件分开：`scripts/emit-path-smoke/main.ts` 需将 `nodePackProductionPorts.ts` 的 `emitExternal(event)` 包装/展开形状归因到实际事件类型，保留未知动态事件失败哨兵；原 34/36 变为 36/36 且将 sink 变 broadcast 的隔离负控必红。另 `scripts/settings-panel-smoke/main.ts:961-968` 的字面正则只认 `hook: next`，当前实现 `HookSpecSchema.parse(next)` 后仍有 `if (!res.ok)` 与 toast；应以行为/结构安全地认出同等失败出口，153/154 转全部通过，负控删除错误分支必红。两文件可并行；分别归并 **ARC-006/T60** 与设置/钩子既有回归，不削弱断言。
6. **T49 完成后同版本复核能力目录与权限映射**。历史 `capability-smoke` 的 host 少 `core.app.call`，`module-permissions-smoke` 的 `APP_METHOD_PERMISSIONS` 缺 `workflowEngine.load`；T67 也已明确第二项属于 **T49** 正在做的模块权限边界。负责 `packages/contracts/src/appPermission.ts`、`apps/desktop/src/main/modules/{ModuleHost,fileCapabilities,builtinCapabilityCatalogue,service}.ts` 与两原测试。**与 T49 绝对串行**：等其交独立 SHA，重跑两个原红例及未授权/撤权 fail-closed 负控，全部红→绿后方可说稳定回归修复；按 T48/T49/T67 与既有相关 MC/ARC 合并，不建立重复编号。
7. **FileEditor 历史未定义引用复核**。文件 `apps/desktop/src/renderer/components/ide/FileEditor.tsx` 与 `document-view-renderer-smoke`；历史 `useGitDiffPair→useGitStore is not defined`，但 T68 后续 typecheck 回绿，且该文件现在又在并行编辑。**与 FileEditor owner 串行**，稳定 SHA 下复跑 renderEditor 旧输入，要求无 ReferenceError 且原回归断言全绿；归并 **ARC-005/ARC-007** 既有用户界面任务，不新建确定 Bug。
8. **设置页 Electron catalog 合法形状定性**。文件 `src/renderer/components/modules/ModuleContributions.tsx`、`settings-panels-electron-smoke` 的 app/API 夹具，以及 T49 的模块 catalog。历史 `contributionsOf→catalog?.modules.flatMap` 取到 `undefined`，页面健康前置失败：目前**不能判断**是夹具传坏类型还是产品在真实错误回包上缺少保护。先冻结 T49、避开并行 Electron 探针，对真实 `api.modules.catalog()` 数据契约和失败态分开做 U1；修后启动主窗口、打开设置页并完成 MC-045 原深链断言，负控传入无效数据必须显式失败而非空过。归并 **MC-045/ARC-005**；与 T49、Electron 验收串行。

#### 验收判据逐项结论

- **① 达成**：60/60 每套编号、原日志位置、源码关联与分类，统计 A50/B6/C0/D3/E1 合计恰为 60。
- **② 达成（历史日志 + E2 源码联系范围内）**：A 的 22+27 套均逐项关联实际 shell 行，WSL 项由错误 stderr + 本地执行链支持；B 六项均有旧断言/桩与当前源码的具体不一致；D/E 不强断产品根因，保留静态证据的局限性。
- **③ 达成（建议级）**：8 组建议给出负责文件、可重现红例、绿条件、既有任务归并和多处必需串行热区；后续任务编号归总控，不在此擅自创建。
- **④ 达成**：没有编辑既有产品源码、测试脚本、其他任务卡或全局台账；没有 git reset/stash/add .，只追加本任务回写和创建 `.tmp/t69-*` 分析脚本。
- **⑤ 达成**：不新增断言，变异验证不适用；诊断日志解析 60→61 负控完成且没有漏 FAIL。
- **⑥ 达成审查纪律、**但项目整体独立复核**未完成**：D/E 没有安全的冻结源码复跑，A/B 也只有三项本轮独立复跑；无 U1。结论只能是 `REVIEW_INSUFFICIENT`，**不可**写 `REVIEW_PASSED`。
