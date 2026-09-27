# Mcode 并行全域检修与小步优化方案（MAINT-2026-09）

> **这是派工方案，不是已完成审计，更不是对下列风险已存在 bug 的断言。** 项目位置是当前 MCP 工作区中的 `mcode/`；本文件固定为 `mcode/docs/parallel-maintenance/PLAN.md`。状态表就在本文件中，任何对话接手、阻塞或完成时必须更新它。计划日期：2026-09-27；只在远端真实项目工作，不建立本地替身仓库。

## 0. 盘点基线、优先级与现有边界

- 规划时 HEAD：`fe62fe35831ab3bec97b6bcc06673c761ea5a91e`，**工作树并不干净**；领取时重新记录当时 HEAD 与 `git status --short`，不得把此快照误认成当前状态。
- 已核对 `AGENTS.md`、`CLAUDE.md`、`docs/testing.md`、`MCode-Status-and-Plan.md`、`PARALLEL_TASKS.md`；代码包含 `main/`、`renderer/`、`preload/`、`packages/contracts/`、桌面打包脚本与大量 `*-smoke` 套件。旧计划中的“某模块零 smoke”或固定套件数不是当前验收事实，以当下目录和实际运行日志为准。
- 已有 **UI-MODULES-P2**：01～04 的报告为 `READY_FOR_INTEGRATION`，05/06 为 `IN_PROGRESS`，07 尚无报告。本计划**不接管** `PARALLEL_TASKS.md` 或 `docs/parallel-ui-modules/` 的所有权；M28～M32 必须等 07 书面完成/释放并由用户或协调者开放门禁。
- 规划时 `main/library/{fileImport,importDispatch,operations,pdfImport}.ts`、`renderer/components/library/`、`renderer/lib/i18n/{zh,en}/library.ts`、`settings/ConversionSection.tsx` 等有他人未提交修改。M33～M35 在原所有者明确释放前**不开放**。`main/lib/systemPrompt.ts`、`renderer/lib/i18n/{zh,en}/{ide,settings}.ts` 也有未提交修改，留给后段共享接线任务且仍须核对原所有者。
- 本轮以 **P0 数据损坏/权限越界 → P1 真实用户回归/失败不可见 → P2 可量化性能与可访问性** 的顺序排查。没有可复现问题不强行改代码；所谓“优化”须有基线与收益/无退化证据，不以全库格式化或更换技术栈冒充优化。
- 推荐同批开 **4～8 个互不写同文件**的对话；先派 A 组，B/C 门禁打开后再派；D 组串行收尾。不同任务可读/运行同一测试，**不能并行修改同一源文件或测试文件**。

## 1. 强制的领取与状态协议（所有对话必须执行）

1. **首个写入动作必须是认领本文件的一行。** 除只读打开本计划、项目规则和 `git status` 以作选择外，领取前不读源码深入排查、不改代码/测试/报告、不启动测试。选择状态 **`未接手`**、对应门禁已开放且没有更早所有者占用的一个编号；一个对话一次只接一个编号。
2. 用 `read_files` 读本文件取得 `sha256:` 版本，再用 MCP `apply_patch` 的 `expected_versions` 只将该编号的状态行从 `未接手` 改成 `已接手`，填写唯一对话标识、含时区的领取时间和当时 HEAD。**读回确认认领成功才开始检修。** 禁止通过 `run_command`、整文件覆盖或无版本写入来抢占状态。
3. 两个对话碰撞时，后写者遇 `STALE_FILE` 必须重新 `read_files`，仅重新替换自己所选的那一行；若该行已非 `未接手`，立即改选另一条合格的未接手任务或停止，**不抢、不覆盖**。修改别的编号造成的版本冲突也须重读重试，不能丢失他人的状态。
4. `已接手`、`阻塞`、`待复验`、`已完成` 都**不是可领状态**；断线、超时、静默或失败不能自动“释放”一个任务。只有用户/协调者确认原对话停止、核对遗留改动并在本文件记录原因后，才能将它改回 `未接手`。任务人发现前置门禁关闭或先前所有者/脏文件冲突，改为 `阻塞`（仍由其占用），报告原因，停止写那块源码；不能私自扩大文件范围。
5. 写入边界：任务仅可修改下方列出的**专有路径**、自己新建的 `apps/desktop/scripts/maint-mNN-smoke/`（NN 与任务号相同）、自己的 `docs/parallel-maintenance/reports/MNN.md` 和**本文件中自己的状态行**。未明确分配的文件、公共入口、其他任务的报告/测试均只读；需要跨界修复时在自己报告写 `跨任务请求`，交该文件所有者或协调者。新 suite 若创建需有 `run.sh`，可由现有动态 runner 发现；**不能为了绿灯改写旧测试/断言**。路径 `{a,b}` 表示列出的具体文件，不是整个父目录的写授权。
6. 排查顺序：项目规则 → 确认原有行为/小范围基线 → 新增能触及目标的失败断言（**缺依赖、脚本没加载或纯 TypeError 不算有效红灯**）→ 最小修复/有量化依据的优化 → 新旧定向套件变绿 → 本任务范围 TypeScript/`git diff --check`。没有 bug 也要列出检查对象、反例与通过证据，写 `未发现需改问题`，不能虚构修复。
7. 测试安全：不触发真实模型、收费 API、真实用户数据库/数据根、在线安装/下载、签名发布或任意 shell 批量删除；DB 使用副本/隔离 fixture，文件仅在唯一临时目录，浏览器用独立 profile/随机端口，只关闭自己启动的进程。远端 `run_command` **不是沙箱**；Windows 默认 PowerShell，不能混用 Bash 语法。现成依赖优先，新增依赖必须先申请。资源争用的浏览器/Electron/端口套件须与协调者错峰。仅 M38 做一次冻结候选的全量 smoke 和双包 typecheck；其他任务只跑相关套件，避免 30 个对话同时全量测试。
8. 完成前写自己的报告（模板见 §4），再次 `read_files` 本文件并以 `expected_versions` 更新**本行**为 `已完成`，在本行写 **实际修复了什么/未发现问题、测试命令与退出码、报告链接**；读回确认。若需协作复验则置 `待复验`，不要冒充完成。未经用户另外明确批准，**不 commit、不 push、不全库格式化、不 reset/checkout/stash、不开真实应用数据**。

**门禁释义**：`A` = 现在可尝试领取，但当下文件被其他对话占用或有非本人脏改即暂停；`B` = UI-MODULES-P2 的 05/06/07 完成、文件释放且协调者放行；`C` = 资料库现有修改的原所有者释放、脏文件归属确认；`D` = B/C 放行，领域任务完成或用户逐项批准保留阻塞后，**M36 → M37 → M38 串行**。门禁关闭时即便状态 `未接手` 也不得认领。

## 2. 唯一权威状态表（不要把旧报告当作实时状态）

**领取原子变更示例**：仅改 `| M01 | A | 未接手 | — | — | — |` 为 `| M01 | A | 已接手 | Arena/<唯一对话>/2026-09-27T...+08:00/HEAD | 排查中 | — |`；完成时仍只改这一行，`修复摘要` 至少一句，`证据` 指向自己报告及日志。表格单元不要用未转义的 `|`。

| ID | 门禁 | 状态 | 领取对话 / 时间 / HEAD | 修复摘要（或无改动结论） | 验证证据 / 报告 |
|---|---|---|---|---|---|
| M01 | A | 已完成 | Arena/MAINT-M01-a3f19c/2026-09-27T12:34:10+08:00/fe62fe35831ab3bec97b6bcc06673c761ea5a91e | 未发现需改问题：store/ 四文件产品代码净改动为零（导出后外键、异步保存/关闭屏障、部分写入-rename-fsync、迁移与重启一致性逐项走读并取证）；新增独占套件 maint-m01-smoke 25 条断言，经撤掉 exportBytes 的外键恢复验红 13 条后还原（db.ts SHA 与改前一致）；OBS-M01-03 打开失败无用户可见告警已作跨任务请求交 M36 | run-smokes.mjs db-migrate-smoke db-persistence-smoke maint-m01-smoke → exit=0，3 pass/0 fail（日志 apps/desktop/.tmp/smoke-runs/1790484621684-47808-xHQ6Wb）；npx tsc --noEmit -p apps/desktop/tsconfig.json → exit=0；红灯日志 apps/desktop/.tmp/smoke-runs/1790484530666-33264-OUmfHC；报告 docs/parallel-maintenance/reports/M01.md |
| M02 | A | 已完成 | Arena/MAINT-AUTO-10b7b8/2026-09-27T12:35:14+08:00/fe62fe35831ab3bec97b6bcc06673c761ea5a91e | 修复分叉副本继承源运行/审批状态的问题，新副本设为 idle | 定向 smoke 4/4 通过，TS 通过；docs/parallel-maintenance/reports/M02.md；日志 apps/desktop/.tmp/smoke-runs/1790483896456-42940-KK8zq6 |
| M03 | A | 已完成 | Arena/MAINT-AUTO-NEXT-M03-ab4664/2026-09-27T12:52:25+08:00/bc2d164d21a7c7dbdac9538af46ce7d2a04c395d | 修复同毫秒任务边沿/result 被错误判为已 settle | M03 定向 smoke 4/4 通过，TS 通过；docs/parallel-maintenance/reports/M03.md；日志 apps/desktop/.tmp/smoke-runs/1790484974429-35980-avg4KH |
| M04 | A | 已完成 | Arena/MAINT-AUTO-NEXT-M04-ab4664/2026-09-27T13:02:18+08:00/83de89b5b415bbe5f12929691fa96679e489fd45 | 修复 Pi plan 模式未优先于陈旧权限值/always-allow 的审批旁路 | maint-m04、engine-regressions、skill-engines、bridge-registry 4 suites 通过，TS 通过；docs/parallel-maintenance/reports/M04.md；日志 apps/desktop/.tmp/smoke-runs/1790485846871-22900-r6w1OJ |
| M05 | A | 已完成 | Arena/MAINT-M05-10dddb/2026-09-27T13:15:04+08:00/b457382cb656ea94f20d732cf843d080d6293894 | 修复 BUG-M05-01（P1）：子代理线程的 turn/completed 被当作主 turn 结束（provider 随即 dispose app-server，主代理被中途杀掉），用量/错误/计划/diff 同样串到主线程；按 threadId 分流，diff 按线程合并。BUG-M05-02（P2）：totalProcessed 重复计入缓存 token、多请求轮只计最后一次；改为 input+output 且按 total 差值取本轮合计。改 CodexMessageAdapter.ts（+69/−2）、codexTokenUsage.ts（+18/−4） | 红灯：maint-m05-smoke exit 1（15/28失败，smoke-runs/1790486364030-40048-JflvGB）；绿灯：maint-m05-smoke 28/28、engine-regressions-smoke PASS、provider-context-smoke PASS（smoke-runs/1790486389177-31848-6NU3cG）；memory-codex-smoke 打包失败为既有替身缺导出（与本任务无关，已列跨任务请求）；desktop tsc EXIT=0；git diff --check 0；报告 docs/parallel-maintenance/reports/M05.md |
| M06 | A | 已完成 | Arena/MAINT-AUTO-NEXT-M06-ab4664/2026-09-27T13:16:23+08:00/ad24ce83cc842584aad4f672ffb305e4cbb8ccda | 修复 BUG-M06-01（BridgeRegistry 并发 acquire 遗漏 server）与 BUG-M06-02（中断/预算停止后的迟到审批）；按 session 拒绝 pending 并保留授权状态；按 config id 串行并防 shutdown 竞态 | bridge-registry/budget-guard/upstream-headers 3 pass；mcp-endpoint 1 pass；tsc、diff-check exit 0；报告 reports/M06.md |
| M07 | A | 已完成 | Arena/MAINT-M07-a3f19c/2026-09-27T13:00:40+08:00/132a5f4af12f1a3f06b14dc439efe389553643f2 | BUG-M07-01（P1，已修）：ipc/files.ts 私有的大小写敏感 pathWithin 与共享 lib/pathGuard 并存，导致 Windows/macOS 上同一条路径「readFile 读得到、writeFile/rename 却判越界」的静默失败（编辑器存不下去、重命名无反应）；最小修复＝删除私有 pathWithin 与死代码 samePath，四个调用点改走共享实现，越界拒绝强度不变。未修并记录：OBS-M07-01 路径闸不解析 symlink/junction（已作跨任务请求，待 P2 释放后统一处理）、OBS-M07-02 拒绝原因对渲染端不可见 | 红灯 maint-m07-smoke 13/19（6 FAIL，日志 apps/desktop/.tmp/smoke-runs/1790485478505-21256-ohWhNZ）→ 修复后 maint-m07-smoke + path-guard-smoke + context-files-smoke + editor-save-smoke → exit=0，4 pass/0 fail、19/19（日志 apps/desktop/.tmp/smoke-runs/1790485601705-30320-KbMFbO）；npx tsc --noEmit -p apps/desktop/tsconfig.json → exit=0；报告 docs/parallel-maintenance/reports/M07.md |
| M08 | A | 已完成 | Arena/MAINT-REVERIFY-9ec50b/2026-09-27T13:45:07+08:00/e4bf9d19ec51999765fb6984c25ec34992fa55e6 | 复验（原 Arena/MAINT-M08-4cdff9 已完成）：codeRunner.ts 去 `/s` 修复与报告一致，未发现需改问题；源码与套件仍未提交，OBS-M08-01（路径含 `&`）维持跨任务 | maint-m08-smoke 当前 HEAD 重跑 25/25，合并回归 9 套 exit 0（apps/desktop/.tmp/smoke-runs/1790488751352-10716-GacHCU）；报告 docs/parallel-maintenance/reports/M08.md「复验」节 |
| M09 | A | 已完成 | Arena/MAINT-REVERIFY-9ec50b/2026-09-27T13:45:07+08:00/e4bf9d19ec51999765fb6984c25ec34992fa55e6 | 复验（原 Arena/MAINT-M09-7eab3c 已完成）：两端 filePathToUri 编码与 uriToFilePath 调用点的 decodeURIComponentSafe 对称，未发现需改问题；新增未确证观察：Monaco `c%3A` 盘符形式与主进程 URI 字符串不同，留 M38 | maint-m09-smoke 35/35，合并回归 exit 0（apps/desktop/.tmp/smoke-runs/1790488751352-10716-GacHCU）；报告 reports/M09.md「复验」节 |
| M10 | A | 已完成 | Arena/MAINT-M10-a3f19c/2026-09-27T13:18:10+08:00/ad24ce83cc842584aad4f672ffb305e4cbb8ccda | BUG-M10-01(P0)：worktreeRemove 对未注册路径跳过全部安全闸直接 rm -rf，IPC 只校验 repoPath 致任意目录可被递归删除；BUG-M10-02(P1)：worktreeMergeBack 在未校验路径上静默 git add -A && commit。均加归属闸（注册/会话引用/受管根内，复用 pathGuard.pathWithin）。新套件 maint-m10-smoke 红 18/20→绿 24/24，frontend+ui-interaction+projects-ipc 全绿，tsc 0 | docs/parallel-maintenance/reports/M10.md |
| M11 | A | 已完成 | Arena/MAINT-REVERIFY-9ec50b/2026-09-27T13:45:07+08:00/e4bf9d19ec51999765fb6984c25ec34992fa55e6 | 复验（原 Arena/MAINT-M11-7eab3c 已完成）：loopbackPort 修复有效；**新修 BUG-M11-03（P1 数据覆盖）**：uniqueDownloadPath 只查磁盘，Chromium 传输期间目标文件不存在，两个并发同名下载分到同一落点、后者静默覆盖前者；改为同时把 in-flight 下载路径（state=progressing）视为已占用，无预留时行为不变。仅改 BrowserManager.ts | 红灯 maint-m11-smoke build.mjs exit 1（11/14，apps/desktop/.tmp/maint-m11-95Gpce）→ 绿灯 run-smokes maint-m11-smoke loopback-port-smoke browser-smoke exit 0（14/14、24/24、168/168，apps/desktop/.tmp/smoke-runs/1790488677240-48872-dpLSCA）；桌面包全量 tsc exit 0；check.mjs exit 0（apps/desktop/.tmp/maint-m11-check-0T2I26）；合并回归 apps/desktop/.tmp/smoke-runs/1790488751352-10716-GacHCU；报告 reports/M11.md「复验」节 |
| M12 | A | 已完成 | Arena/MAINT-REVERIFY-9ec50b/2026-09-27T13:45:07+08:00/e4bf9d19ec51999765fb6984c25ec34992fa55e6 | 复验（原 Arena/MAINT-M12-7eab3c 已完成）：browserUrl/browserOcclusion 修复有效，未发现需改问题 | maint-m12-smoke 17/17，合并回归 exit 0（apps/desktop/.tmp/smoke-runs/1790488751352-10716-GacHCU）；报告 reports/M12.md「复验」节 |
| M13 | A | 已完成 | Arena/MAINT-M13-407e02/2026-09-27T12:35:15+08:00/fe62fe35831ab3bec97b6bcc06673c761ea5a91e | 修复2个删除数据缺陷：BUG-M13-01 清单version为"."/".."时安装目标落到插件目录或插件根，删除载荷或全部插件与市场（全点版本回退0.0.0，finalize加包含断言）；BUG-M13-02 插件名marketplaces（不分大小写）与市场目录冲突，安装/卸载会删光市场克隆（安装/启用/卸载/查找统一拒绝）。改 pluginManager.ts、pluginManifest.ts | 红灯：maint-m13-smoke exit 1（13/17失败，smoke-runs/1790483992778-36512-UDZHR5）；绿灯：run-smokes maint-m13-smoke plugins-smoke plugins-ipc-smoke 3 pass（17/17、118/118、129/129，smoke-runs/1790484046077-13836-XrxHWb）；desktop tsc EXIT=0；git diff --check 0；报告 docs/parallel-maintenance/reports/M13.md |
| M14 | A | 已完成 | Arena/MAINT-M14-6b2d41/2026-09-27T12:39:07+08:00/fe62fe35831ab3bec97b6bcc06673c761ea5a91e | 修复 mcpConfig.getMcpManagement 对 settings 表管理状态那一行的裸 JSON.parse：一行坏数据即抛穿 getMcpTruth，打死 MCP_LIST 与每轮开场的 claude 视图物化且永不自愈；改为降级成空状态，由真相层迁移重新抬起并覆盖坏行。参数限额、公网工具过滤、沙箱回退、跨会话隔离逐项核对，未发现其他需改问题；另记 3 条未改观察（会话断线无清理钩子需跨任务接线） | maint-m14-smoke 44/44（修前 40/44，4 条红为被测函数自身 SyntaxError）；maint-m14 + mcp-endpoint + mcp-engines + mcp-ipc 四套连跑 exit 0；desktop tsc --noEmit exit 0；git diff --check exit 0；报告 docs/parallel-maintenance/reports/M14.md |
| M15 | A | 已完成 | Arena/MAINT-M15-d86493/2026-09-27T13:02:24+08:00/83de89b5b415bbe5f12929691fa96679e489fd45 | 修复 BUG-M15-01（P2）：静态资源包含检查用字符串前缀，未鉴权 GET /../<root名>-x/… 可读 web 根的同名前缀兄弟目录，改为 relative() 判断；BUG-M15-02（P2）：未鉴权的 /api/pair/verify 沿用 32MB body 上限，改为 16KB。改 serveMobileStatic.ts（+6/−2）、MobileHttpServer.ts（+9/−3）；风险：relay SSH 未校验主机密钥（跨任务请求） | 红灯：maint-m15-smoke exit 1（6/14失败，smoke-runs/1790485569115-18128-DXRHT4）；绿灯：maint-m15-smoke 14/14、mobile-pairing-smoke 142/142（smoke-runs/1790485622471-48888-qD36hk）；desktop tsc EXIT=0；git diff --check 0；报告 docs/parallel-maintenance/reports/M15.md |
| M16 | A | 已完成 | Arena/MAINT-M16-6b2d41/2026-09-27T13:15:19+08:00/441a9507b573501b0cc99512b1fdf9d5ea899ffd | 修复记忆助手来源材料的「先截断后遮蔽」顺序缺陷：预算切口落在 PEM 私钥块中间会切掉遮蔽模式所需的结束定界符，半截私钥原样进入模型上下文；上游 textOf(4000)/运行证据(2000) 两道更早的截断同病。抽出纯模块 memory/sourceText.ts，把遮蔽提到每一道截断之前（幂等）。授权可见性矩阵、去重、TTL/非成功回合、崩溃幂等逐项核对无其他需改问题 | maint-m16-smoke 25/25（修前 9 红，其中 7 条为产品缺陷、2 条为本人断言写错已修断言）；maint-m16 + memory + memory-review + node-session 四套 PASS；desktop tsc --noEmit exit 0。⚠️ memory-codex-smoke 在基线 HEAD fe62fe3 上即因共享桩缺 hasLiveRendererWindow 导出而构建失败，非本轮引入，已提跨任务请求，codex 侧覆盖未验证。报告 docs/parallel-maintenance/reports/M16.md |
| M17 | A | 已完成 | Arena/MAINT-M17-9b4f05/2026-09-27T13:24:13+08:00/39015a476c805f02a877c5115348809165a4d5cc | 修复 BUG-M17-01（P1）：整理面板只防当前文件脏，但编辑器为其他文件保留未保存草稿，可在整理里勾选并删除该文件（草稿失去保存目标）；改为把所有未保存草稿路径传入整理面板，禁止勾选/删除并提示。改 MemoryExplorerPanel.tsx（+6）、MemoryMaintenanceReview.tsx（+15/−6）、reviewSelection.ts（+10）、i18n zh/en memory.ts 各 +1 | 红灯：maint-m17-smoke exit 1（7/9失败，A 被删除，smoke-runs/1790487049708-42616-lECOea）；绿灯：maint-m17-smoke 9/9、memory-review-smoke、frontend-smoke、ui-interaction-smoke 全 PASS（smoke-runs/1790487103191-17544-ZOKhUQ）；desktop tsc EXIT=0；git diff --check 0；报告 docs/parallel-maintenance/reports/M17.md |
| M18 | A | 已完成 | Arena/MAINT-M18-f8663e/2026-09-27T12:51:56+08:00/4cabf24478f7de03963f03685dd9dc109f581adf | 修复 BUG-M18-01（P0）：从本地路径安装内核时 package.json 的 version 被直接用作目录并先递归删除，"../pi" 覆盖删除其他内核、".." 删光运行时根、"../../.." 删到应用数据目录之外；finalizeInstall 在删除前校验单段安全版本名与父目录包含关系。改 runtimeInstaller.ts（+13/−1） | 红灯：maint-m18-smoke exit 1（7/20失败，smoke-runs/1790484832349-29024-TrdVej）；绿灯：maint-m18-smoke 20/20、archiver-installer-smoke 110/110+11/11、installers-ipc-smoke 72/72、runtime-state-smoke 51/51（smoke-runs/1790484874334-9256-O9p0Va）；desktop tsc EXIT=0；git diff --check 0；报告 docs/parallel-maintenance/reports/M18.md |
| M19 | A | 已完成 | Arena/MAINT-REVERIFY-9ec50b/2026-09-27T13:45:07+08:00/e4bf9d19ec51999765fb6984c25ec34992fa55e6 | 复验（原 Arena/MAINT-M19-7eab3c 已完成）：NotificationManager 三处修复有效；另核对 holdTurnEnd 扣住的 turn.done 不进 mobileEventBus，监控采集器不会提前收口/重复摘要。未发现需改问题 | maint-m19-smoke 15/15，合并回归 exit 0（apps/desktop/.tmp/smoke-runs/1790488751352-10716-GacHCU）；报告 reports/M19.md「复验」节 |
| M20 | A | 已完成 | Arena/MAINT-M20-9259fe/2026-09-27T12:36:10+08:00/fe62fe35831ab3bec97b6bcc06673c761ea5a91e | 修复下载中换模型目录致文件/选择错位、HEAD 探测取消延迟、并存 pane 浮层被覆盖/迟订阅、切会话迟到 stop 串稿、用户改动转写尾巴被追加、重复权限拒绝假录音；4 处生产文件最小修复与 M20 独占套件 | node apps/desktop/scripts/run-smokes.mjs voice-smoke frontend-smoke maint-m20-smoke → exit=0（3/3，独占 10/10），日志 apps/desktop/.tmp/smoke-runs/1790489943326-32192-talmlZ；desktop tsc --noEmit exit=0；git diff --check exit=0；报告 docs/parallel-maintenance/reports/M20.md |
| M21 | A | 已完成 | Arena/MAINT-M21-a3f19c/2026-09-27T13:41:32+08:00/e4bf9d19ec51999765fb6984c25ec34992fa55e6 | BUG-M21-01(P0，本地提权)：安装脚本写进用户可写的 %TEMP% 再以 -File 提权加载，用户态进程（含 Agent 跑的代码）可在 UAC 确认前替换它拿到管理员；改为内联 -EncodedCommand 不落盘 + marker/日志随机名。BUG-M21-02(P1)：~1GB 安装器仅按 Content-Length 复用即提权执行，加 Authenticode 验签（Status=Valid 且签名主体为 Ascensio/ONLYOFFICE）且顺序早于 Start-Process。新套件 maint-m21-smoke 红 8/13→绿 15/15，onlyoffice+frontend 全绿，tsc 0 | docs/parallel-maintenance/reports/M21.md |
| M22 | A | 已完成 | Arena/MAINT-M22-b2c691/2026-09-27T13:46:06+08:00/9bb8c58fedbcaed46f3cc6fcd6a1ddabd1903118 | 修复 BUG-M22-01（P1）：侧聊面板忽略提问时按 activeSessionId 误忽略父会话提问→改为按面板 sessionId 作用域；BUG-M22-02/03（P2）：提交按钮双击重复 respondQuestion（sentinel 会起两轮）、Enter 提交失败后永久锁死→submit 统一加锁并在 promise settle 后解锁；BUG-M22-04（P2）：新提问原地替换时卡片沿用旧 answers 导致 TypeError 崩溃/串答案→按 requestId 加 key；BUG-M22-05（P2）：@/斜杠/资料库选择器拦截输入法组字的 Enter/Tab/空格→加 isComposing/229 防护。改 ChatPane、QuestionPrompt、FileMentionPicker、SlashCommandPicker、LibraryPicker（+46/−12）；跨任务请求→M23 见报告 | 红灯：maint-m22-smoke exit 1（5/16，10 项★全失败，smoke-runs/1790488344593-42744-5LJZjn）；绿灯：maint-m22-smoke 16/16、frontend-smoke、conversation-queue-smoke、ui-interaction-smoke 全 PASS（smoke-runs/1790488404932-36812-Q9CpTE）；desktop tsc EXIT=0；git diff --check 0；报告 docs/parallel-maintenance/reports/M22.md |
| M23 | A | 已完成 | Arena/MAINT-REVERIFY-9ec50b/2026-09-27T13:45:07+08:00/e4bf9d19ec51999765fb6984c25ec34992fa55e6 | 重接（原 Arena/MAINT-M23-6b2d41 仅认领无产出）：**修复 BUG-M23-01（P1）**：turn.done{interrupted} 陈旧守卫只看 interruptedBySession 哨兵，主进程预算触顶（enforceBudget）/手机端点停/工作流取消发来的中断收口被整条丢弃 → runningBySession 永远 true（输入框锁死、计时不停、不落库、队列不出发）。改为仅当本端“欠一条中断收口”且新一轮已清哨兵时才丢弃（模块级 pendingInterruptDone，任何 turn.done 销账）。仅改 sessionStore.ts；乱序 delta/重复结果/订阅释放只读核对未发现需改问题 | 红灯 maint-m23-smoke 13/18（5 条★外部中断断言，apps/desktop/.tmp/smoke-runs/1790488483820-35932-aupKud）→ 绿灯 maint-m23-smoke 18/18 + session-store-smoke 159/159 + node-transcript-smoke（apps/desktop/.tmp/smoke-runs/1790488532749-23836-lh9NBK）；frontend-smoke 36/36；桌面包全量 tsc exit 0；git diff --check 0；合并回归 apps/desktop/.tmp/smoke-runs/1790488751352-10716-GacHCU；报告 docs/parallel-maintenance/reports/M23.md |
| M24 | A | 已完成 | Arena/MAINT-AUTO-NEXT-M24-ab4664/2026-09-27T13:49:25+08:00/6ade80827507066a9afbe7c251abc8076eb8461f | 修复只读预览 Tab 激活/定位；会话 Tab 键盘导航；侧栏会话行/卡片及隐藏操作的焦点可达性；补可访问名称与未知会话双语回退 | tsc PASS；ui-interaction/frontend/session-store smoke 3/3 PASS；diff-check PASS；报告 docs/parallel-maintenance/reports/M24.md |
| M25 | A | 已完成 | Arena/MAINT-AUTO-M25-c7d2e9/2026-09-27T14:00:13+08:00/b5b8b940105ebf2c05ca23e6ec8416c30c1a35ff | 修复4处:BUG-M25-01 RuntimesPanel 安装/卸载/本地安装的 IPC 拒绝错误不可见且落成 unhandled rejection(补 catch→actionError,pickFolder 入守卫);BUG-M25-02 DataRootPanel 迁移同类问题(补 catch→setError);BUG-M25-03 GeneralPanel 折叠阈值输入每键即 clamp 抢改(本地草稿+失焦提交);BUG-M25-04 内核行展开开关缺 aria-expanded。RuntimePolicyPanel 草稿协议、AboutPanel 默认值兼容走读无需改;3 条观察含 AppearancePanel 主题 set 静默失败已作跨任务请求(M37/M23) | 红灯 maint-m25-smoke 14/26(12 FAIL 全中目标,smoke-runs/1790489403487-26184-M7GY80)→绿灯 26/26(smoke-runs/1790489573773-48704-HdmHbX);settings-panel-smoke+frontend-smoke 2 pass(smoke-runs/1790489617035-42996-HNOdoZ);desktop tsc EXIT=0;git diff --check 0;报告 docs/parallel-maintenance/reports/M25.md |
| M26 | A | 已完成 | Arena/MAINT-AUTO-M26-53966a501a/2026-09-27T14:04:33+08:00/b5b8b940105ebf2c05ca23e6ec8416c30c1a35ff | 修复 BUG-M26-01：快捷键面板未订阅覆盖配置且两面板 memo 不随覆盖图变化，新增绑定列表滞后；改 ShortcutsPanel、GesturesPanel；另记录 MCP 凭据回显静态风险及跨任务请求，未冒充已修 | 红灯 maint-m26 2/5 exit=1 → 绿灯 5/5；run-smokes maint-m26/settings-panel/ui-interaction 3 pass exit=0（apps/desktop/.tmp/smoke-runs/1790489219131-39956-qiTKiD）；desktop tsc exit=0，定向 diff-check exit=0；报告 docs/parallel-maintenance/reports/M26.md |
| M27 | A | 已完成 | Arena/MAINT-M27-a3f19c/2026-09-27T14:02:30+08:00/b5b8b940105ebf2c05ca23e6ec8416c30c1a35ff | 打包前置脚本假绿三处（package 脚本以 && 串联，退出码即闸门）：BUG-M27-01 工作区包实体化「先删后拷」，拷贝失败只 warn 退 0 且 node_modules 留空洞→改为先拷暂存再换、失败硬退 1 且保留原链接；BUG-M27-02 conpty 源文件缺失时一边 WARNING 一边报 already up to date 退 0→改为退 1；BUG-M27-03 版本目录取 readdir[0]→改为只认含 win10-<arch> 的并排序取最新。CI/run-smokes 入口检查未发现假绿。新套件 maint-m27-smoke 红 7/11→绿 11/11，run-smokes.test 10/10，tsc 0 | docs/parallel-maintenance/reports/M27.md |
| M28 | B | 未接手 | — | — | — |
| M29 | B | 未接手 | — | — | — |
| M30 | B | 未接手 | — | — | — |
| M31 | B | 未接手 | — | — | — |
| M32 | B | 未接手 | — | — | — |
| M33 | C | 已完成 | Arena/MAINT-AUTO-M25-c7d2e9(接管)/2026-09-27T14:33:13+08:00/e1d06d0faa52526b001d733871ae7633a5f364c1 | 修 4 组:①importGeneric attached+目录造死条目(改按 linked 落);②attached 复制失败留半截条目(失败即删行);③notesImport/addItems/importGeneric 对分类 id 裸调 assign 撞外键、条目半截入库(统一走 assignImportedToCollections);④笔记失败重试被半截行按标题查重卡死+重复导入丢分类不回条目。新套件 maint-m33-smoke 红 14/35(1790491589970-45884-KnlE0b)→绿 35/35(1790491749987-2628-1j4eTX);新旧 10 套全绿(1790491770592-45948-3THSm8);tsc 0;diff --check 0。继承的先前未提交改动(fileImport/importDispatch/pdfImport/operations/ConversionSection+两套测试扩展)原样保留并在报告中单列。 | docs/parallel-maintenance/reports/M33.md |
| M34 | C | 已完成 | Arena/MAINT-M34-d01b57cd51/2026-09-27T14:43:02+08:00/e1d06d0faa52526b001d733871ae7633a5f364c1 | 修复旧版 Markdown 整包预览漏计图床/重复列项与回收站条目经关联、直接单篇和分类清单漏过滤；operations.ts 原有未提交改动原样继承、未修改。删除预览与真实删除可能不一致，涉及 M33 专有 ipc/library.ts，待 M33 端到端复验 | maint-m34-smoke 18/18；9 套定向 smoke exit 0（apps/desktop/.tmp/smoke-runs/1790492034596-34060-IdQ2hK）；desktop tsc exit 0；git diff --check exit 0；跨任务请求及详情 docs/parallel-maintenance/reports/M34.md;复验(Arena/MAINT-REVERIFY-9ec50b):deletePreview/deleteItems 一致性已在 ipc/library.ts 修复,maint-c-followup-smoke 19/19,见 reports/M34.md 文末 |
| M35 | C | 已完成 | Arena/MAINT-M35-2879c0/2026-09-27T14:37:49+08:00/e1d06d0faa52526b001d733871ae7633a5f364c1 | 修复列表与关联详情旧回包覆盖新态、目录子 PDF 批注保存路径、键盘可达与坏标注索引保存前备份；五处交接改动保留。跨 M33 的大文件先读后限流及通用 linked PDF 外部打开/保存授权未修，报告列出责任与限制 | docs/parallel-maintenance/reports/M35.md；maint-m35-smoke 红灯后绿灯 11/11，联合 pdf-annotation/library-paths/frontend 4 pass/0 fail（apps/desktop/.tmp/smoke-runs/1790492356124-34304-q24Clt）；desktop tsc exit 0；未提交未推送 |
| M36 | D | 未接手 | — | — | — |
| M37 | D | 未接手 | — | — | — |
| M38 | D | 未接手 | — | — | — |

## 3. 任务可写范围与检修要点

下文 `M/` = `apps/desktop/src/main/`，`R/` = `apps/desktop/src/renderer/`，`C/` = `packages/contracts/src/`；`run:` 仅表示建议**只读运行**的既有套件，除非文件在该任务的“写”清单中，否则不得修改它。每项以一个或数个能复现的小缺陷为单位处理，发现跨域问题记请求，不自升格为全局重构。

### A 组：可尝试并行认领（领取时仍以实时工作树与既有所有者为准）

#### M01 · 持久化与数据完整性
- **写**：`M/store/**`（四个现有文件）；独占新测试/报告遵循 §1。
- **查**：sql.js 导出后的外键、异步保存与关闭屏障、部分写入/rename/fsync 失败、迁移与重启后数据一致性；性能只测隔离副本。**run**：`db-migrate-smoke`、`db-persistence-smoke`。

#### M02 · 会话生命周期与归档/恢复
- **写**：`M/claude/{RuntimeManager,subagentStore}.ts`、`M/session/**`、`M/lib/{sessionStart,sessionFork,sessionSync,sessionAgentProfile}.ts`。
- **查**：新建/续跑/分叉、子会话归属、取消后收尾、重启恢复与自动归档竞态，不修改 M01 的 DB 实现。**run**：`session-fork-smoke`、`session-subchat-smoke`、`node-session-smoke`。

#### M03 · Claude SDK 提供方
- **写**：`M/providers/claude-sdk/**`、`M/claude/nodeTranscript.ts`（不含 ApprovalBridge/RuntimeManager）。
- **查**：stream delta/result 顺序、后台代理收尾、工具审批回调、上下文预算与失败归因；禁止发真实模型请求。**run**：`engine-regressions-smoke`、`node-transcript-smoke`、`provider-context-smoke`。

#### M04 · Pi 提供方与扩展
- **写**：`M/providers/pi-sdk/**`、`M/lib/piModelsStore.ts`。
- **查**：Extension 的工具注册/审批、路径与写保护、计划模式、模型切换、取消及多回合状态。**run**：`engine-regressions-smoke`、`skill-engines-smoke`、`bridge-registry-smoke`。

#### M05 · Codex 提供方
- **写**：`M/providers/codex-sdk/**`、`M/lib/codexModelsStore.ts`。
- **查**：App Server 消息适配、token 计数、补丁快照归属、turn 结束/重试与审批拒绝，不启动真实 agent。**run**：`engine-regressions-smoke`、`provider-context-smoke`、`memory-codex-smoke`。

#### M06 · 提供方桥、审批与上游头
- **写**：`M/providers/bridge/**`、`M/providers/{registry,providerHealth,toolGate,upstreamHeaders,contextPrompt,envPrompt,envPromptFormat}.ts`、`M/claude/ApprovalBridge.ts`、`M/lib/interactiveRoute.ts`。规划时脏的 `M/lib/systemPrompt.ts` **不在本任务写范围**。
- **查**：跨提供方审批隔离、冒名工具/参数、超时后的迟到批准、网关头泄漏与并发时路由。**run**：`bridge-registry-smoke`、`budget-guard-smoke`、`upstream-headers-smoke`；后者已被列为偶发观察项，需独立复现才算产品缺陷。

#### M07 · 本地路径、文件树与快照安全
- **写**：`M/lib/{pathGuard,pathNorm,fileSnapshot,fileSnapshotRegistry,walkCache}.ts`、`M/ipc/files.ts`、`R/components/ide/{FileTree,FilesPanel}.tsx`；`R/lib/i18n/{zh,en}/ide.ts` 为保留共享文件。
- **查**：工作区根、相对/绝对路径、symlink/junction、大小写与根前缀、覆盖/撤销时旧文件安全、文件树加载失败可见。**run**：`path-guard-smoke`、`context-files-smoke`、`editor-save-smoke`。注意 ModuleHost 使用路径保护：P2 未释放前如发现潜在接口影响先阻塞协调。

#### M08 · 终端与代码/命令执行
- **写**：`M/terminal/**`、`M/ipc/{terminal,shell}.ts`、`M/orchestration/{codeExecutor,codeRunner,commandExecutor,commandRunner}.ts`。
- **查**：shell 选择/引号与工作目录、环境变量泄漏、stdout 上限、非零退出、超时/取消及进程树清理。**run**：`terminal-smoke`、`code-electron-smoke`、`command-runner-smoke`；隔离 Electron userData，不运行任意用户命令。

#### M09 · LSP 与编辑器保存
- **写**：`M/lsp/**`、`M/ipc/lsp.ts`、`R/lib/{lspProviders,monacoSetup,editorModelCache,serializedFileWrites}.ts`、`R/components/ide/{FileEditor,MarkdownEditorPane}.tsx`、`R/components/settings/LspLanguagesPanel.tsx`。
- **查**：模型/文档生命周期、diff URI、didOpen/didClose、异步保存与离开页面、并发写/重命名后的旧响应。**run**：`lsp-smoke`、`editor-save-smoke`、`frontend-smoke`；不要修改 M07 的 FileTree/FilesPanel 或脏的 ide 词典。

#### M10 · Git、冲突与 worktree
- **写**：`M/ipc/git.ts`、`M/lib/worktreeOps.ts`、`R/components/ide/{GitPanel,GitDiffDialog,GitHistoryView,GitRepoCard,WorktreeManagerPanel,MergeConflictResolveDialog}.tsx`、`R/components/settings/{SettingsGitPanel,WorktreeRootSetting}.tsx`。
- **查**：脏工作区拒删、分支/共享 worktree 引用、补丁导出失败、冲突恢复及 Git 面板错误/键盘可达。**run**：`projects-ipc-smoke`、`ui-interaction-smoke`、`frontend-smoke`；仅用新建临时 repo，不能改用户仓库分支。

#### M11 · 内嵌浏览器主进程与下载
- **写**：`M/browser/**`、`M/ipc/browser.ts`、`M/lib/loopbackPort.ts`。
- **查**：tab/session 生命周期、点击前遮挡校验、下载去重/取消、导航跳转和 JS 注入的界限、cookie 作用域。**run**：`browser-smoke`、`loopback-port-smoke`；浏览器测试独立 profile/随机端口。

#### M12 · 浏览器界面与链接展示
- **写**：`R/components/browser/**`、`R/lib/{browserUrl,browserOcclusion}.ts`、`R/lib/i18n/{zh,en}/browser.ts`；`R/App.tsx` 保留给 M37。
- **查**：URL 净化、前后退/下载显示、加载/离线/权限错误、设备尺寸、焦点与遮挡。**run**：`browser-smoke`、`ui-interaction-smoke`、`frontend-smoke`；不得替 M11 修改主进程实现。

#### M13 · 插件安装与清单
- **写**：`M/plugins/**`、`M/ipc/plugins.ts`、`C/plugin.ts`；设置页插件面板归 M26。
- **查**：zip/tar/本地与市场来源的路径穿越、staging/原子替换、失败回滚、卸载与重复安装；不实际联网安装。**run**：`plugins-smoke`、`plugins-ipc-smoke`。

#### M14 · MCP 工具与会话端点
- **写**：`M/mcp/**`、`M/ipc/mcp.ts`、`M/lib/{mcpConfig,mcpEngines}.ts`、`C/ipc/mcp.ts`；库/Mem/Provider 主体仅可读。
- **查**：工具参数限额、HTTP/MCP 会话鉴权及断线清理、外部地址、权限回退与跨会话数据隔离。**run**：`mcp-endpoint-smoke`、`mcp-engines-smoke`、`mcp-ipc-smoke`；间歇失败须保留每次日志，不能重跑至绿就忽略。

#### M15 · 手机后端、鉴权配对与 relay
- **写**：`M/mobile/**`、`M/relay/**`、`M/ipc/{mobile,relay}.ts`、`C/{mobile,relay}.ts`；`R/lib/webApi.ts` 仍归 P2-05，绝不提前写。
- **查**：配对令牌撤销、SSE 断线释放、跨设备越权、静态资源路径、relay 断网恢复。**run**：`mobile-pairing-smoke`、`mobile-sync-smoke`、`relay-smoke`；网络仅回环地址与随机端口。

#### M16 · 长期记忆与交接后端
- **写**：`M/memory/**`、`M/ipc/{memory,memoryAssistant}.ts`、`C/{memory,memoryAssistant}.ts`。
- **查**：项目/全局授权、候选去重、TTL 与非成功回合保留、注入预算/秘密遮蔽及崩溃后幂等；先读 `docs/memory-assistant-handoff.md`。**run**：`memory-smoke`、`memory-review-smoke`、`memory-codex-smoke`；只用隔离库与假提供方。

#### M17 · 记忆浏览与人工复核 UI
- **写**：`R/components/memory/**`、`R/components/chat/MemoryAssistantButton.tsx`、`R/lib/i18n/{zh,en}/memory.ts`。
- **查**：复核确认/撤销、项目切换后的旧状态、空/错误/加载状态、无障碍焦点与中英对照。**run**：`memory-review-smoke`、`frontend-smoke`、`ui-interaction-smoke`；跨越 M16 后端的修复提请求。

#### M18 · 工具链、受管运行时与更新
- **写**：`M/env/**`、`M/runtimes/**`、`M/updater.ts`、`M/ipc/{runtimes,toolchain,updater}.ts`、`C/ipc/runtimes.ts`。
- **查**：版本探测、下载内容完整性/路径、staging/回滚、状态来源与错误恢复；**禁止真实安装/外部下载**。**run**：`agent-env-smoke`、`runtime-state-smoke`、`updater-tools-smoke`（确认 fixture/替身后再运行）。

#### M19 · 运行监控与通知
- **写**：`M/monitoring/**`、`M/notifications/**`、`M/ipc/{monitoring,notifications}.ts`、`R/components/monitoring/**`、`R/components/settings/NotificationsPanel.tsx`、`C/ipc/notifications.ts`。
- **查**：事件去重/顺序、断线重订阅、告警频率/清理、运行结束后的迟到消息与面板状态。**run**：`monitoring-smoke`、`notifications-ipc-smoke`、`observability-ipc-smoke`；布局 Toaster 属 M24，只读。

#### M20 · 语音输入与界面状态
- **写**：`M/voice/**`、`M/ipc/voice.ts`、`R/components/chat/MicButton.tsx`、`R/components/layout/VoiceListeningOverlay.tsx`、`R/hooks/useVoiceInput.ts`、`R/lib/voiceController.ts`、`R/components/settings/VoicePanel.tsx`、`C/ipc/voice.ts`。
- **查**：麦克风权限拒绝、取消/并发录音、模型文件路径与释放、切会话后转写归属。**run**：`voice-smoke`、`frontend-smoke`；不录真实用户音频。

#### M21 · 本地 Office 与文档预览
- **写**：`M/onlyoffice/**`、`M/ipc/onlyoffice.ts`、`R/components/ide/OnlyOfficeEditorPane.tsx`、`R/components/templates/**`、`R/components/settings/{OfficePanel,OfficeLocalInstallSection}.tsx`、`R/lib/i18n/{zh,en}/templates.ts`、`C/ipc/onlyoffice.ts`。
- **查**：预览资源/本地服务失败、编辑器退出与保存、临时文档清理、文档预览尺寸/错误；不启动真实用户的 Office 服务。**run**：`onlyoffice-smoke`、`frontend-smoke`；资料库 PDF 导入不在此任务。

#### M22 · 聊天输入与附件/提问
- **写**：`R/components/chat/{ChatPane,ComposerEditor,ComposerToolbar,ComposerToolbarToggle,AttachMenuButton,FileMentionPicker,LibraryPicker,SlashCommandPicker,QuestionPrompt}.tsx`、`R/hooks/{useComposerRowFit,useCursorAnchor}.ts`、`R/lib/i18n/{zh,en}/chat-composer.ts`。
- **查**：发送/排队/停止竞态、附件和提及指向失效文件、键盘/IME、弹窗审批与焦点恢复。**run**：`frontend-smoke`、`conversation-queue-smoke`、`ui-interaction-smoke`；记忆按钮归 M17。

#### M23 · 消息流、水合与会话前端状态
- **写**：`R/stores/sessionStore.ts`、`R/hooks/useClaudeEvents.ts`、`R/components/chat/{MessageTimeline,MessageBlocks,Markdown,ChunkedMarkdown,ActivityCluster,ActivityConsole}.tsx`、`R/components/chat/{transcriptBlocks,outputRows,activityShared}.ts`、`R/lib/i18n/{zh,en}/chat-stream.ts`。
- **查**：乱序 delta、重复结果、水合后空白块/敏感内容呈现、长列表性能、错误可见与卸载时事件释放。**run**：`session-store-smoke`、`node-transcript-smoke`、`frontend-smoke`；`ChatPane.tsx` 归 M22。

#### M24 · 布局、侧边栏与导航
- **写**：`R/components/layout/**` **除** `VoiceListeningOverlay.tsx`、`R/components/sidebar/**`、`R/lib/i18n/{zh,en}/layout.ts`；`R/App.tsx` 留到 M37。
- **查**：面板宽度/Tab 状态、跨会话导航、关闭/撤销、键盘焦点、响应式遮挡与 tooltip 可达性。**run**：`ui-interaction-smoke`、`frontend-smoke`、`session-store-smoke`。

#### M25 · 通用设置与运行时面板
- **写**：`R/components/settings/{GeneralPanel,AppearancePanel,DataRootPanel,RuntimePolicyPanel,RuntimesPanel,ToolchainSection,AboutPanel,SettingsSection,SettingRow,PanelHeader}.tsx`、`R/lib/appearance.ts`。
- **查**：重进设置的草稿/保存竞态、错误提示、默认值兼容、无障碍与移动端差异。**run**：`settings-panel-smoke`、`frontend-smoke`；`SettingsPage.tsx`、脏的 `settings.ts` 双词典和 ConversionSection 不属于此任务。

#### M26 · 设置中的集成/快捷键面板
- **写**：`R/components/settings/{McpPanel,PluginsPanel,SkillsPanel,ProjectSkillsView,HooksPanel,CustomModelsPanel,InstitutionAuthPanel,SettingsBrowserPanel,SettingsTerminalPanel,ShortcutsPanel,GesturesPanel,UsagePanel,OutputStylePanel,TitleGenPanel,RemoteControlPanel}.tsx`。
- **查**：授权撤销/保密信息不回显、快捷键冲突、MCP/插件失败重试、表单焦点与可访问性。**run**：`settings-panel-smoke`、`ui-interaction-smoke`；其他专属面板和共享 `settings.ts` 词典只读。

#### M27 · 打包、CI 与测试入口
- **写**：`.github/workflows/{ci,release}.yml`、`apps/desktop/build/**`、`apps/desktop/electron-builder.yml`、`apps/desktop/electron.vite.config.ts`、`docs/testing.md`；根包锁/依赖清单未获授权不得改。
- **查**：CI 真实执行与缓存、构建产物路径、受管二进制校验、Windows/macOS/Linux 打包差异、失败时是否假绿。**run**：`node --test apps/desktop/scripts/run-smokes.test.mjs` 及既有安装/更新定向套件（先确认不会联网）；**不签名、不发布、不下载安装新依赖**。`run-smokes.mjs` 是 M36 保留共享入口。

### B 组：**UI-MODULES-P2 释放后**才可领（当前 M28～M32 门禁关闭）

#### M28 · 工作流调度、任务状态与只读能力执行
- **写**：`M/orchestration/{scheduler,executionEngine,runner,runStore,executionContext,executorRegistry,nodeInputBuilders,moduleCapabilityExecutor,workflowTrust,workflowValidation,builtins}.ts`、`M/workflows/{assets,seed}.ts`、`C/{workflow,condition}.ts`；只在 P2-05/06/07 都完成并解除原所有权后开始。
- **查**：新/旧 runner 注册与模型 fallback、runId/dispatch 尝试、取消竞态、重试/循环、状态持久化、工作流导入信任边界。**run**：`scheduler-smoke`、`execution-engine-smoke`、`run-store-smoke`、`module-executor-smoke`；M29 自动化文件只读。

#### M29 · 自动化来源链、触发器与 hooks
- **写**：`M/orchestration/{automationEventOrigin,automationPayload,automationRunner,automationStatus,triggerVars}.ts`、`M/hooks/**`、`M/ipc/hooks.ts`、`C/{hook,cron}.ts`；P2 完成后再核对 M28 的执行输入协议。
- **查**：manual 与事件自动化不混同、per-trigger 启停的旧数据默认值、来源身份冻结、钩子超时与输出脱敏、取消后不得补跑。**run**：`automation-smoke`、`hooks-smoke`、`hook-runner-smoke`、`hook-exec-smoke`；跨到 `builtins.ts` 的请求归 M28。

#### M30 · 工作流编辑器与节点配置 UI
- **写**：`R/components/settings/workflows/**`、`R/components/chat/{WorkflowBoardPanel,WorkflowDropdown,WorkflowFlowMini,WorkflowNodeProgressCard,WorkflowStepCard,BranchChoiceCard}.tsx`、`R/lib/{workflowLive,workflowQueued,automationHistory}.ts`、`R/lib/workflowLabels.tsx`。
- **查**：图拖拽/撤销重做、节点参数丢失、草稿并发保存、目录目标失效、错误提示/键盘/中英文；**run**：`workflow-ui-smoke`、`workflow-view-smoke`、`workflow-validation-smoke`、`module-catalog-ui-smoke`。`settings.ts` 双词典当前为脏共享文件，跨任务请求 M37。

#### M31 · 模块能力宿主与 UI 扩展
- **写**：`M/modules/**`、`M/ipc/modules.ts`、`R/components/modules/**`、`C/{moduleCapability,moduleClient,modules,nodeType}.ts`、`C/ipc/modules.ts`。必须尊重 P2 冻结契约，不能把用户导入模块悄悄变成无人值守目标。
- **查**：菜单/工作流是否共宿主、元数据与限额、资源越界/伪装内置、取消与 requestId、目录快照和模块卸载。**run**：`module-platform-smoke`、`module-catalog-smoke`、`module-phase2-security-smoke`、`module-phase2-e2e-smoke`；P2 原测试文件只读。

#### M32 · 手机端 UI / Web API 镜像
- **写**：`R/AppMobile.tsx`、`R/components/mobile/**`、`R/lib/webApi.ts`、`R/lib/i18n/{zh,en}/mobile.ts`。`webApi.ts` 当前归 P2-05，释放前整个 M32 不领。
- **查**：手机无 preload 时 RPC 镜像是否齐全、切项目/会话后旧请求回写、弱网重连/令牌撤销、移动文件/Git/设置错误可见。**run**：`mobile-sync-smoke`、`mobile-pairing-smoke`、`ipc-parity-smoke`；不访问真实手机/LAN。

### C 组：资料库当前活跃修改释放后才可领（当前 M33～M35 门禁关闭）

#### M33 · 文件/PDF 导入与转换入口
- **写**：`M/library/{fileImport,importDispatch,pdfImport,convert,notesImport,pdfRead,pdfText}.ts`、`M/ipc/library.ts`、`R/components/settings/ConversionSection.tsx`。
- **查**：文件归属/重复导入、MinerU 输入与结果目录包含关系、失败重试和清理、导入事件是否实际落库；不得自造已退役的核心 DOI/全文下载功能。**run**：`library-import-smoke`、`library-py-smoke`、`mineru-py-smoke`；只用 fixture，不调用真实第三方服务。

#### M34 · 资料库条目、路径、回收站与关联
- **写**：`M/library/{manifest,operations,paths,trash,groupRegistry,suppress,adoptMarkdown,broadcast}.ts`、`C/{library,libraryTypes}.ts`；M33 的导入接口与 M35 的预览实现只读。
- **查**：重命名/移动时引用与一跳关联、屏蔽规则继承、删除与恢复、重复条目/未清理的临时文件。**run**：`library-create-smoke`、`library-move-smoke`、`library-trash-smoke`、`library-adopt-smoke`。

#### M35 · 资料库前端与 PDF 标注
- **写**：`R/components/library/**`、`R/stores/libraryStore.ts`、`R/lib/{libraryLabels,libraryPreview}.ts`、`R/lib/i18n/{zh,en}/library.ts`、`M/library/{pdfFile,pdfHighlightsStore,markdownPreview}.ts`、`C/pdfHighlight.ts`。
- **查**：列表/预览过期回写、标注定位与重启保存、导入错误、键盘可达和大文件预览；不重写 M33 的导入或 M34 的条目事务。**run**：`pdf-annotation-smoke`、`library-paths-smoke`、`frontend-smoke`。

### D 组：领域任务完成或经用户逐项豁免后串行收尾（M36 → M37 → M38）

#### M36 · 跨进程桥与共享契约总校验
- **写**：`C/ipc.ts`、`C/ipc/rpcMap.ts`、`M/ipc/index.ts`、`M/index.ts`、`M/lib/systemPrompt.ts`、`apps/desktop/src/preload/index.ts`、`R/lib/api.ts`、`apps/desktop/scripts/{run-smokes.mjs,run-smokes.test.mjs}`。其余按域分配的 `C/ipc/*`、各 `main/ipc/*`、`webApi.ts` 只读。
- **查**：契约 → preload → main 三层白名单、renderer/mobile 能力差异、未知 RPC 失败关闭、共享入口是否引入模型 fallback、测试 runner 假绿和输出日志。**run**：`ipc-wiring-smoke`、`ipc-parity-smoke`、`module-phase2-e2e-smoke`、`node --test apps/desktop/scripts/run-smokes.test.mjs`；不抢先修领域任务文件。

#### M37 · 共享 UI 入口、词典与设计系统
- **写**：`R/App.tsx`、`R/components/settings/SettingsPage.tsx`、`R/styles.css`、`R/components/ui/**`、`R/lib/i18n/{index,core}.ts`、`R/lib/i18n/{zh,en}/{settings,ide,common}.ts`；只在先前词典脏改与 P2 UI 均释放后领取。
- **查**：桌面/手机共有组件入口、缺少 zh/en key、主题/宽度/暗色、错误边界、键盘焦点与性能；按各领域报告的跨任务请求做最小共享适配。**run**：`frontend-smoke`、`ui-interaction-smoke`、`workflow-ui-smoke`、`module-catalog-ui-smoke`；浏览器缺失不伪称通过。

#### M38 · 冻结候选、全量回归与最终交付
- **写**：仅本任务 `reports/M38.md`、`docs/parallel-maintenance/final.md` 及本文件 M38 状态行；**默认不改生产源码或别的任务报告**，问题退还原所有者复修。
- **查**：核对 M01～M37 的完成/豁免、任务行与报告一致、文件归属和未解决 P0/P1；短暂停写或记录冻结候选的 HEAD/关键 SHA。**run**：`node apps/desktop/scripts/run-smokes.mjs --all`（套件数取动态发现值）、desktop/contracts 双包 TypeScript 检查、`git diff --check`；日志落盘，连接中断先恢复已有日志，不盲目重复全量。未做的真实模型/用户库/安装包验证必须明写“未验证”。

## 4. 每个任务的报告模板与完成条件

任务领取后新增 `docs/parallel-maintenance/reports/MNN.md`（若尚不存在），仅由该编号对话维护：

```md
# MAINT-2026-09 / MNN · <标题>
状态：已接手 / 阻塞 / 待复验 / 已完成
承接对话：<唯一标识>；领取时间：<ISO+时区>；领取 HEAD：<sha>
原始 git status（限相关文件）：<路径和归属，不复制用户隐私>
## 检查清单与证据
- 对象/反例/成功/失败路径；哪些只读检查、哪些真实跑过。
## 发现与修复
- BUG-MNN-01：级别、复现、影响、根因、实际修改文件与行为；无 bug 则写“未发现需改问题”及依据。
- 性能优化：优化前后测量方式/数值；不确定或跨域问题只列建议。
## 红灯 → 绿灯 / 兼容验证
- 命令、退出码、断言为何真的触达目标、日志路径；缺依赖/环境不可用须单列。
## 跨任务请求、未完成与风险
- 指出归属编号、请求点、阻塞状态，不越权顺手修改。
## Git
- 实际改动文件逐一列出；未提交/未推送；他人改动保持原样。
```

**完工门槛**：本任务列出的检修点逐项记录；确证的 bug 有有效红灯/最小修复/绿灯及兼容检查；未修问题有责任人和阻塞状态；本文件**自己的状态行**变为 `已完成`，填入实修摘要（或“未发现需改问题”）和报告/测试证据。只写报告、不更新状态行，或只改状态不写修复内容，都不算完成。

## 5. 可以原样转发的统一派工提示词

> 将下方整段复制给每个新对话；要定向分配就把 `AUTO` 换成不同的 `MNN`。`AUTO` 模式只在**门禁开放**的 `未接手` 行里选择；多人同时挑中一个编号，只有成功读回认领状态的一方能执行。

```text
阅读远端 mcode/docs/parallel-maintenance/PLAN.md 和 mcode/AGENTS.md、mcode/CLAUDE.md、mcode/docs/testing.md。执行 MAINT-2026-09 的任务 ID：AUTO（或由我改填 MNN）。本对话只接一个任务。除只读选择任务/确认规则与 git 状态外，你的第一项写操作必须用 MCP read_files 获得 PLAN.md 的 SHA-256，然后用 apply_patch(expected_versions)把该任务状态从“未接手”改为“已接手”，写入唯一对话标识、含时区时间和当前 HEAD；读回确认后才检查源码、运行测试或修改文件。若任务已被认领、门禁未开放、现有任务/脏文件归他人或出现 STALE_FILE，重新读取并改选合格的未接手任务或停止，绝不抢占。
仅修改该任务“写”栏列明的文件、独占 maint-mNN-smoke 测试目录、自己的 reports/MNN.md 以及 PLAN.md 中自己的状态行；其他内容只读。先用能触及目标的失败测试复现 bug，再做最小修复/有证据的优化，跑相关旧新测试与定向类型检查；不用真实模型、真实用户库、未经批准的安装/网络下载，不清理其他对话产物，不自动 commit/push。没有 bug 也记录完成的检查与证据，不虚构修复。完成后写明实际修复内容、命令/退出码/日志与跨任务请求，再以 expected_versions 把 PLAN.md 自己行改为“已完成”并补修复摘要和报告路径，读回确认。全量测试和跨文件集成留给 M38/协调者。
```
