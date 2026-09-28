# Skill 管理修复 / 2026-09-28

## 状态
READY_FOR_INTEGRATION：本任务源码修复及定向验证完成；安装版/全量集成未验收。

承接对话：Arena / SKILLS-MANAGEMENT-6d496c。

这是用户在上一项模块平台工作已移交后新分配的 Skill 管理任务，不恢复 UI-MODULES-P2 的 01/05/06/07 所有权，不改写那些交接报告。

- 开始 HEAD：`22f606630db4552782fff01ff4ba1115b3fc8d5b`。
- 开始工作区已有他人改动：`ui-interaction-smoke/{build.mjs,main.jsx,mocks.js,verify.mjs}`、`MemoryExplorerPanel.tsx`、中英文 `memory.ts`；本任务不修改或清理。
- 不自动提交或推送，不删除真实用户 Skill，不读写真实用户数据库，不启动/重启用户主应用，不调用真实模型，不安装依赖。

## 用户确认的目标
1. 每个 Skill 行提供删除按钮，位置与整组删除一致，不必先打开原文。
2. 修复 `.system` 被列出后触发 `invalid skill name` 的问题；保留名称和路径校验，不把系统容器当作可删 Skill。
3. 修复部分 Markdown 原文为空的问题；区分真正空文件、文件读取失败和身份/项目定位错误。
4. 第二个 Tab 增加项目下拉框，可选择不同项目进行管理，且不切换当前聊天项目。

## 文件范围
生产：`src/main/ipc/skills.ts`、`src/main/lib/skillEngines.ts`、`packages/contracts/src/ipc/skills.ts`（技能契约说明/必要兼容）、`SkillsPanel.tsx`、`ProjectSkillsView.tsx`，以及 `zh/settings.ts` / `en/settings.ts` 中的 **settings.skills** 词条。

测试：新增独立 `scripts/skills-management-smoke/`、`scripts/skills-management-ui-smoke/`；`scripts/skill-engines-smoke/main.ts` 中目录是否构成 Skill 的旧期望随明确需求调整，其余断言保留。

现有模块平台源码/报告、既有 UI 交互测试、记忆相关文件保持只读。中英 settings 文件只做技能块的精确增量，所有已有文件写入须通过新鲜 SHA 版本检查，冲突时停止。

## 已定位并修复
- `scanSkillsRoot` 与 `skillNamesInRoot` 把没有 SKILL.md 的目录也作为 Skill；前者缺隐藏目录/合法名称过滤。
- 列表用 frontmatter `name`，read/save/delete/copy 却把逻辑名称直接拼成目录，名称与真实目录不同时定位错。
- 项目技能读取/编辑分支漏传 projectPath；read 把所有异常吞为 `""`。
- 手写读取异步没有防止迟到响应覆盖新选择。
- 当前项目管理组件直接依赖 activeProjectId，没有独立的管理目标选择。
- 新增每行直删，保留整组删除及部分失败提示；插件/内置只读不开放删除。项目复制保持不覆盖已有同名逻辑技能。
- read/save/delete/copy/项目总览统一使用逻辑名称到实际目录的映射；保留严格名称校验，以及删除链接而不删除其目标的行为。
- 全局库与选定项目列表分开查询；读取失败显式显示错误和重试、禁止保存空缓冲区；真实零字节文档有单独提示。读写操作始终携带完整项目身份，迟到结果不能覆盖新选择。
- 第二 Tab 的项目下拉框独立于当前聊天项目；第三 Tab 的只读节点总览仍保留当前聊天项目独有的 Skill 引用。

以上定位来自源码审查和隔离夹具复现，不代表检查过用户某个具体 Skill 的内容。`.system` 仅从可操作技能列表中过滤，未删除真实目录，也没有放宽正则。

## 测试证据
已先增加测试并运行未修复代码，再实施修复：

- 后端有效红灯：19 项中 4 PASS / 15 FAIL，exit 1；日志 `apps/desktop/.tmp/smoke-runs/1790558747773-37136-VEy2EW/`；实际夹具 `apps/desktop/.tmp/skills-management-OB1rrc/`。
- UI 有效红灯：13 项中 1 PASS / 12 FAIL，exit 1；日志 `apps/desktop/.tmp/smoke-runs/1790558870822-29056-SJEjl7/`；截图/断言 `apps/desktop/.tmp/skills-management-ui-Sf9kYC/`。
- 首轮后端绿灯：`skills-management-smoke` 19/19、`skill-copy-smoke`、`skill-engines-smoke` 三套全部通过，exit 0；日志 `apps/desktop/.tmp/smoke-runs/1790559010859-33088-E0SFUE/`。
- 首轮 UI 绿灯：13/13，exit 0；日志 `apps/desktop/.tmp/smoke-runs/1790559285374-33128-Dq0BPr/`；图像 `apps/desktop/.tmp/skills-management-ui-LIavIA/`，已查看列表按钮、项目选择和项目编辑器截图。
- 共享工作区 desktop tsc：exit 2，错误来自并行编辑中的 `MemoryExplorerPanel.tsx:329,564–566` 语法；本任务没有改动该文件。该次没有执行 contracts tsc，不能记作双包通过。
- 第一个独立 Skill 候选 `mcode/.tmp/skills-fix-candidate-ZaWvQy/`，树 `d78e1c29325fa24586362ee02e7876edf6bc377e`：runner 自测、双包 tsc、15 个定向影响套件、diff check、候选未变校验全部通过，exit 0。不是全量回归。其运行期间只在 live 增加后续测试，冻结代码没有变动。
- 随后审查补充了节点总览兼容、整组部分失败、重名项目路径区分、无项目这四项 UI 用例。扩展套件先出现 16 PASS / 1 FAIL，唯一失败为总库/项目拆分后丢失当前项目独有的节点引用；日志 `apps/desktop/.tmp/smoke-runs/1790559679158-38552-U62r5B/`，工件 `apps/desktop/.tmp/skills-management-ui-70ZkdY/`。
- 已在 SkillsPanel 恢复第三 Tab 按当前聊天项目读取只读技能清单，与第二 Tab 管理目标独立。下面的最终独立候选包含这项修复，扩展 UI 套件为 **17/17 PASS**。

## 最终独立候选：已完成

- 命令：`cmd_4ef5ad5fcd173895ea2b9d770b11c0ef3ad8baf028651c03`，终态 completed，**exit 0**。
- 候选目录：`mcode/.tmp/skills-fix-candidate-qy7WTk/`。
- 固定基线：`22f606630db4552782fff01ff4ba1115b3fc8d5b`；树：`7a03753ac869f89cb3c360496de69fa635b0f7a8`。
- 从该基线独立 detached clone，仅覆盖本任务明确列出的 **21 个文件**（7 个生产文件、1 个既有测试、12 个新增测试/说明文件、1 个报告）。没有借用其他对话未提交的源码，也没有在共享仓库暂存或创建提交。
- `manifest.json` / `input.json`：覆盖文件及 SHA-256；`candidate.patch`：精确补丁；`results.json`：所有阶段退出码及耗时；`result.json`：终态；`source-after.json`：同源校验。

| 验证项 | 最终结果 |
|---|---|
| 统一 smoke runner 自测 | 10/10 PASS |
| contracts 类型检查 | exit 0 |
| desktop 类型检查 | exit 0 |
| 新后端管理回归 | 19/19 PASS |
| 新浏览器 UI 回归 | 17/17 PASS |
| 定向影响回归 | 15/15 套件 PASS，exit 0 |
| 候选 staged diff check | exit 0 |
| 测试结束候选源码未变 | true |
| 测试结束 live 覆盖文件未变 | true |

**不是全量回归。** `--all --list` 只发现 157 套，没有运行这 157 套；`fullSuiteRun` 为 false。旧模块平台收尾仍由 Arena / MAINT-REVERIFY-9ec50b 承接，不恢复其所有权。

15 套范围：`skills-management-smoke`、`skills-management-ui-smoke`、`skill-copy-smoke`、`skill-engines-smoke`、`node-skills-view-smoke`、`engine-regressions-smoke`、`settings-panel-smoke`、`provider-context-smoke`、`mcp-engines-smoke`、`plugins-smoke`、`plugins-ipc-smoke`、`ipc-parity-smoke`、`ipc-wiring-smoke`、`context-files-smoke`、`memory-codex-smoke`。

最终详细日志及工件（均相对候选目录）：
- 汇总：`focused.stdout.log`。
- 各套日志：`repo/apps/desktop/.tmp/smoke-runs/1790559789015-48704-4HgLsu/`；两个新套件的文件名分别为 `skills-management-smoke.log` 和 `skills-management-ui-smoke.log`。
- 后端夹具：`repo/apps/desktop/.tmp/skills-management-Ld9Dw1/`。
- 浏览器结果/截图/源码哈希：`repo/apps/desktop/.tmp/skills-management-ui-ZwCOfA/`。最终行删除、项目选择复制/移除、节点总览三张截图已取回并目视核对；此前也核对过项目原文编辑器截图。

## 共享工作区收尾检查

- 并行对话期间共享 HEAD 已推进；收尾只读检查时为 `afa254cfc46b8d42190010d33d254529edecd931`，不是本任务提交。
- 早先的 MemoryExplorerPanel 语法错误只代表当时状态。收尾再次运行共享工作区类型检查，命令 `cmd_858f00df8671c0de21dce3f6d47a8c670715ae577d0cf0fa` 已 completed / exit 0：**desktop=0，contracts=0**。
- `git diff --check` 在共享工作区也返回 exit 0。其他对话的 `ui-interaction-smoke/verify.mjs`、中英文 `memory.ts` 等改动保留，未清理、覆盖或纳入本任务候选。
- 本报告在验证完成后补录终态，因此其最终文档哈希与候选中的 IN_PROGRESS 版本不同；没有在验证完成后改动本任务生产/测试实现。

## 测试边界及待集成事项

- 后端使用真实文件系统/生产处理函数及隔离 HOME/USERPROFILE，Electron/仓库依赖使用测试替身；没有读取或改动真实用户 Skill 目录、数据库。
- 浏览器运行真实 React 组件、hooks、UI primitives 和样式，但 API/session 是显式夹具；不等于验证了原生 Electron IPC、安装包或用户当前实例。
- 未做原生/安装版、移动端、真实模型或全库全量验收。集成负责人在纳入其他并行变更后安排整体回归；不要把本报告的 15 套说成全量通过。
- 本次涉及主进程改动。要人工试用，需运行更新后的开发构建或重新构建的程序；已安装旧程序不会因为仓库源码变化自动获得修复。本任务未代替用户启动/重启主应用。
- 人工验收建议：确认行右侧可直接删除且仍有组删除；`.system` 不再成为可点开的技能条目；正常原文可编辑、失败可重试且不可保存、真实空文件有提示；第二 Tab 切换项目后查看/编辑/复制/移除均作用于所选路径，当前聊天项目不变。

## Git 与交接

本任务未提交、未推送；没有新增依赖。需提交时请由用户明确授权后按 manifest 的 owned-only 范围处理，不要 `git add .`，不要顺带提交 Memory/UI 其他对话的文件。

可重跑本任务两套回归：`node apps/desktop/scripts/run-smokes.mjs skills-management-smoke skills-management-ui-smoke`（仓库根目录）。所有最终运行已终止，没有本任务仍在进行的测试或用户应用重启。
