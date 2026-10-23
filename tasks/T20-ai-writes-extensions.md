# T20｜AI 写扩展的闭环（生成 → 校验 → 装机 → 可回滚）

- Status: done（2026-10-23 执行回写，见文末）
- Category: feature
- Priority: P1
- Depends on **T18**（安装权限卡片）与 **T19**（扩展 API 面）。**不得先于两者开工。**
- Exclusive writable files: 新建的扩展工坊模块（主进程 + 渲染端）、其 IPC 契约、新建回归套件。逐个确认后写进回写区。**不改** T18/T19 的文件、`workflowEngines/`、`orchestration/automationRunner.ts`、`appControl/apiCatalog.generated.ts`、`ipc/settingsTransfer.ts`、`lib/worktreeOps.ts`、`arc005-visual-baseline/`。

## Required Skills
- `security-best-practices`: AI 生成的代码要被装进宿主执行，是整个项目最高风险的一环。
- `codebase-design`: 决定闭环的边界——哪些步骤 AI 做、哪些必须用户确认。
- `mcode-smoke`: 建「AI 生成恶意扩展」的负控回归。
- `code-review`: 确认没有任何一步让 AI 绕过用户授权。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`docs/planning/extension-vscode-compat.md`、`docs/planning/mcode-product-roadmap.md`、`tasks/T18-extension-install-permission-card.md`、`tasks/T19-extension-api-surface.md`。

## 产品要求（用户原话）

> 「我想要的是这个扩展可以自己写，把 mcode 的能力都暴露出去……我可以让 mcode 里面的 ai 帮我写插件」

产品路线：

> AI 可以根据用户的自然语言描述**创建、测试、修复并安装扩展**，用户也能自行开发和管理扩展。

## 目标

把「用户说一句 → AI 写出扩展 → 装进 Mcode」做成**有闸门**的闭环，而不是一键装任意代码。

### 闭环必须有的步骤

1. **需求理解 → 清单草案**：AI 产出 `ModuleManifest`（含能力声明与所需权限）。**清单是声明式的，不含可执行代码**。
2. **代码生成**：在受控目录写扩展文件（`permissionedProcessRunner` 管辖的安装位）。
3. **静态校验**（不执行）：清单 schema、权限都在 `MODULE_PERMISSION_NAMES` 内、入口文件存在、没有 `blocked` 档能力的声明。
4. **沙箱冒烟**：用 `permissionedProcessRunner` 真跑一次最小调用，验证扩展能启动、能调一个 `read` 档方法。**沙箱内失败不装机。**
5. **用户确认**：走 T18 的权限卡片。**用户看到的是「这个扩展要干什么 + 要什么权限」，不是源码 diff。**
6. **安装与回滚**：装完记录可回滚点；用户能一键卸载并恢复。

### 安全硬要求

- **AI 不能自己批准安装**。生成的扩展必须经过 T18 的用户确认，AI 无权代签。
- **AI 不能在扩展里声明 `blocked` 档能力**——静态校验必须拒。
- **生成的代码要在隔离进程里跑**，不能进主进程、不能进渲染端主线程。
- **失败可回滚**：装着装着失败，必须回到装之前的状态，不能留半个扩展。
- **不得自动修复后自动重试无限循环**：修复重试要有次数上限，超限交还用户。

### 明确不做

- 不做扩展市场/分发。
- 不做自动签名与可信链。
- 不做 VS Code 扩展的直接生成（那是兼容层，另一条线）。

## 验收判据

1. 用户描述「每次保存文档时备份一份」→ AI 产出清单 + 代码 + **权限需求列表**，停下来等确认。**不经确认不写盘。**
2. AI 生成的清单里写 `blocked` 档能力 → 静态校验拒绝，给出明确错误。
3. 沙箱冒烟失败 → 不装机，回滚干净，无残留目录。
4. 用户拒绝权限 → 不装机。
5. 装机成功后扩展能被 T19 的 API 面调用；卸载后无残留。
6. 修复循环超过上限 → 停下并报告，不无限重试。
7. 变异验证：把「AI 不能自己批准」改成自动批准 → 对应断言必须变红；逐字节还原（`cmp`）。
8. 双包 typecheck 通过。

## 结果回写（2026-10-23）

- Status: done
- 提交：`0d6e9b58`（实现 + 回归套件）；半成品基线 `dfbbf6e5`（前一个执行者，进程被杀）。
- 本卡独占可写文件（实际改动）：
  - `apps/desktop/src/main/modules/extensionWorkshop.ts`（重写，636 → 约 900 行）
  - `packages/contracts/src/extensionWorkshop.ts`（扩了 stage / handoff / 常量）
  - `apps/desktop/src/main/appControl/tools.ts`（**只新增**：两个工具 + 运行时装配 + 一个 switch 分支；未动既有逻辑）
  - `apps/desktop/src/main/appControl/engineTools.ts`（`isAppToolName` 前缀判据放宽到 `extension_*`，按表成员资格）
  - `apps/desktop/scripts/extension-workshop-smoke/`（新建回归套件 + 变异驱动）

  **未碰** `modules/ModuleHost.ts`、`packages/contracts/src/appPermission.ts`、
  `renderer/components/modules/ModuleSurface.tsx`、`workflowEngines/`、
  `document/genofficeNativeVendor.ts`、`build/vendor-licenses/`。

### 0. 半成品评估（dfbbf6e5 有多少可用）

结论：**思路可用，接线全缺，安全断言为零**。

- **可用**：模块骨架、目录布局（`state.json` 与 `draft/` 分离，修复计数不会被 `rm -rf` 一起删）、
  修复预算（`attempts` / `repair_exhausted`）、静态校验的 blocked/不可委托判定、状态读写与只读清单。
- **不可用 / 缺失**：
  1. 没有任何工具或 IPC 暴露它 —— `grep extensionWorkshop` 在 `apps/desktop/src` 只有它自己；
     也就是说半成品**根本没有进入 AI 能触达的路径**，闭环一步都没通。
  2. 沙箱调用了 `runPermissionedProcess` 却没接 `onAppCall` —— 扩展里任何 `mcode.api.call`
     都会在子进程里挂起或失败，与「验证扩展能调一个 read 档方法」的卡面要求不符。
  3. 没有「不经确认不写盘」：`buildExtension` 直接落草稿，前面没有审批卡。
  4. 没有全局草稿数上限（换模块 id 即可无限铺目录）。
  5. 没有安装交接材料（AI 拿到 `ok:true` 后不知道下一步传什么、更拿不到"恒 allow-once"的约束）。
  6. 没有回滚对账（装上/卸下之后工坊状态不会跟宿主目录对齐，卸载后草稿残留）。
  7. 没有 `vm.Script` 编译期检查，语法错要浪费一次沙箱才发现。
  8. 没有任何回归套件（`smokes-for.sh` 报"没有套件覆盖它"）。
- **半成品的关键判断正确、本卡沿用**：**不新增 RpcMap**。理由见 §2。

### 1. 六步闭环各自状态

| 步骤 | 谁做 | 状态 | 证据（套件断言） |
|---|---|---|---|
| ① 需求理解 → 清单草案 | AI | 完成 | `extension_build` 收 `{manifest, notes?}`；清单是声明式的，可执行部分只有 `program.source` |
| ② 代码生成（受控目录） | 工坊 | 完成 | `<数据根>/extension-workshop/<id>/draft/` 下写 `extension.json` + `draft.json` + 样例文件；入口写后 `lstat` 校验非空 |
| ③ 静态校验（不执行） | 工坊 | 完成 | 权限闭集（36 个）逐值点名；`vm.Script` 只编译不执行；blocked / 不可委托字面量调用硬拒；动态方法名如实降级为"运行期兜底" |
| ④ 沙箱冒烟 | 工坊 | 完成 | 真子进程 `runPermissionedProcess`；read 档 RPC 经桥派发（正控证明真的调通）；write/danger 在冒烟阶段一律拒；失败删除草稿 + `attempts+1` |
| ⑤ 用户确认 | **强制人工** | 完成 | `extension_build` 在写盘前弹 write 档审批卡；安装交接材料恒 `installConsent:"allow-once"` + `requiresUserApproval: true`；实际安装走既有 `modules.install` 的 T18 三态卡 |
| ⑥ 安装与回滚 | 既有事务 + 工坊对账 | 完成 | 装上 → `reconcileWorkshopStates` 记可回滚点（版本 + 上一版）；卸载 → 标 `rolledBack` 并删草稿；幂等 |

**哪些步骤强制人工**：⑤ 用户确认安装（`modules.install` 的 danger 审批卡）是唯一能让扩展落地的
入口；AI 的工坊路径（`extension_build`）最多把材料准备到"可以安装（还差用户确认）"。此外：

- `extension_build` 本身要一次 write 档审批（草稿目录也是写盘、且要在隔离进程里跑 AI 代码）；
- 装好后的 danger 档 RPC **每次**都要用户本人批准（T19，见 §4）；
- `modules.setPermissions` / `issueWorkflowGrant` 等仍是 blocked —— AI 连调都够不到。

### 2. 为什么「不新增 RPC」，以及排除那条路的代价

新增一条 `RpcMap` 键会要求重跑 `gen-app-api-catalog.mjs` 与 `gen-module-permission-map.mjs`：

- `apiCatalog.generated.ts` 是他人未提交的 dirty 文件（T15/T18 回写点名），本卡边界不碰；
- 更关键的是 **`appPermission.ts`**：按生成器重生成会把 `apiCatalog.generated.ts` 里
  **10 条目录已前进、权限映射尚未归类**的方法（`document.apps` / `document.markdownEdit` /
  `document.markdownRead` / `document.render` / `document.toolCall` / `document.toolDescribe` /
  `document.toolsList` 共 7 条 `document.*` + `framework.list/save/reset`）一次性收进
  **委托面** —— 那是**放宽**方向，正好与本卡相反（T19 回写 §1 有同一条论证）。

所以闭环落在**既有** `appMcpTools()` 工具面 + 既有 `modules.*` 通道上：

- `extension_build`（write 档，`invokeAppTool` 里先 `gateAppAction`）—— ①–④；
- `extension_workshop_status`（只读，进 `APP_READONLY_TOOLS`）—— 状态投影；
- 安装 = `app_api_call({method:"modules.install", input:handoff.input})`（既有 danger 通道）；
- 卸载 = `modules.remove`（既有事务）。

反证断言：套件直接读源码，断言工坊模块不 import electron、不出现 `RpcMap`、不调用
`.install(`，且契约里写着「不新增 RpcMap」。

### 3. 沙箱与回滚证据

沙箱（真子进程，不是桩）：

- **正控**：清单声明 `project.read`、程序在子进程里 `mcode.api.call("project.list")`
  → 桥校验（read 档 + 权限已声明）→ 派发桩返回项目 → 结果真的回到 `ModuleResult`（`26/26` 里的一条）；
- **负控**：同样程序但清单缺 `project.read` → 桥拒 → `stage:"sandbox"` 失败；
- **负控**：程序调 `file.writeFile`（write）或 `git.push`（danger）→ 冒烟阶段拒（"read 档"错误）；
- **越界**：程序 `readFileSync("C:\\Windows\\win.ini")` → 子进程 `--permission` 拦下
  (`ERR_ACCESS_DENIED`) → 不装机、草稿清空；
- **失败注入**：沙箱替身抛错 → `stage:"sandbox"`、草稿目录删除、`state.attempts=1`
  （状态文件留在模块目录，修复计数不丢）。

回滚：

- 沙箱失败 → `rm -rf draft/`，无残留目录（断言 `existsSync(workshopDraftDir) === false`）；
- 用户拒绝安装 → `ModuleHost.install(...,"deny")` 在任何写盘前抛；`persist` 调用数、权限表、
  模块目录三处均不变（本套用真 `ModuleHost` + 内存桩重验）；
- 卸载 → `modules.remove` 既有事务（撤工作流授权、删清单、取消运行中任务）+ 工坊对账把状态
  标 `rolledBack` 并删草稿；再对账一次幂等。

修复上限：

- `WORKSHOP_MAX_REPAIR_ATTEMPTS = 3`；超限 `repair_exhausted` 后 `buildExtension` 返回
  `stage:"budget"` 且**不再跑沙箱**（断言沙箱替身调用数不增）；
- 全局 `WORKSHOP_MAX_DRAFTS = 64`：换模块 id 也绕不过去（断言预算不足时沙箱未运行）；
- 一次成功生成把 `attempts` 归零。

### 4. 恶意生成负控

| 攻击 | 断言 |
|---|---|
| 清单声明 `unsafe.exploit`（不在 36 个内） | 静态拒绝、点名该权限、**不落盘** |
| 程序字面量调 `claude.approve`（BLOCKED 表） | 静态拒绝（blocked 分支）、不落盘 |
| 程序字面量调 `workflowEngine.load`（映射 null，不可委托） | 静态拒绝（"不可委托"分支） |
| 程序语法错 | 编译期拒绝（`vm.Script`），不进沙箱 |
| 动态拼接 `"claude."+"approve"` | 静态看不出 → **不误拒**，回执如实写"只认字面量，运行期 T19 兜底" |
| 程序字面量调 `git.push`（danger） | 静态**不拒**（运行期逐次审批），回执警告"每次都要用户本人批准" |
| 未声明权限的只读 RPC | 静态仅警告；**真沙箱里桥拒**（沙箱不比清单更宽） |
| 沙箱里尝试 write / danger | 冒烟阶段一律拒，不能预支用户批准 |
| 试图让工坊自己安装 | 工坊模块源码断言不调用 `.install(`；交接材料无"已批准"字段 |
| 交接材料被篡改成 `allow-always` | 断言把它钉回：材料恒 `allow-once`；且 `resolveInstallDecision`（Agent 无桌面发送方）再把它收窄成 `allow-once` |

### 5. 危险档审批断言（T19 的闸没有被绕开）

用真 `ModuleHost` 装一个工坊形态的扩展（声明 `files.read` + `git.write`，程序调 `git.push`），
经 `callAppFromExtension`（T19 的唯一派发口）连续调用 3 次：

- 3 次调用 = **3 条** danger 审批（`scope:"danger"`、`method:"git.push"`），不存在「始终允许」；
- 全部批准 → 3 次派发；用户拒绝 → `approval_denied`、**零派发**。

这证明：工坊只负责把扩展**准备**到安装卡前，装上之后危险操作仍走 T19 的逐次审批。

### 6. 变异证据

1. **build.mjs 内置两条**（源码锚点注入，锚点缺失即构建失败）：
   - `self-approve`：交接材料 `installConsent` 改 `allow-always` → 「★ 交接材料：requiresUserApproval
     恒 true、installConsent 恒 allow-once」变红（另有 1 条连带）；
   - `no-sandbox`：沙箱失败判定改 `false &&` → 「★ 沙箱冒烟失败 → 草稿清空、状态记一次失败」
     变红（另有 5 条连带）。两条均 `PASS (expected assertion RED)`。
2. **卡面第 7 条的原地变异**：把 `invokeAppTool` 里 `extension_build` 的 `gateAppAction` 改成
   自动批准（`denied = null` + `if (false) await gateAppAction(...)`）→ 「★ 不经确认不写盘」
   与「★ 回执摘要…」两条变红 → `cmp` 还原 **BYTE-EXACT**，复跑 26/26。
   （变异脚本在 `.tmp/t20-mut/` 下、跑完已删。）

### 7. 验证

- `bash apps/desktop/scripts/extension-workshop-smoke/run.sh` → **26/26 通过**，两条变异
  `PASS (expected assertion RED)`；
- 既有相关套件全绿（各 1 次）：`extension-authoring` / `app-control` /
  `extension-danger-delegation` / `module-install-consent` / `host-mcp-server` /
  `host-mcp-stdio` / `module-catalog` / `module-catalog-ui` / `extension-bridge` /
  `module-phase2-e2e` / `effective-tools` / `capability` / `agent-guide` /
  `module-app-call` / `module-contract` / `module-executor` / `module-workflow` /
  `module-ui` / `module-grant-revoke-safety` / `startup-wiring` / `installers-ipc` /
  `public-mcp-session` / `panel-ask-resilience` / `custom-ui-refresh` / `published-tools` /
  `mcp-text` / `mcp-endpoint` / `extension-store` / `library-preview-extension` /
  `vscode-l1` / `workflow-extension-seams` / `base-capability-matrix` / `runtime-node-modules`；
- `npx tsc --noEmit -p packages/contracts/tsconfig.json` → 干净；
- `npx tsc --noEmit -p apps/desktop/tsconfig.json` → 本卡涉及的 4 个文件干净。
- `smokes-for.sh src/main/modules/extensionWorkshop.ts` 现在会带上 `extension-workshop-smoke`
  （此前是"没有套件覆盖它"）。

### 8. 未覆盖项 / 已知边界

- **双包 typecheck 不是"整包全绿"**：`apps/desktop` 的 tsc 当前另有 3 个文件的错误，
  **全部来自其他会话未提交的 dirty 文件**，与本卡无关、也不在本卡可写边界内：
  - `apps/desktop/scripts/electron-u1/driver/runner.ts`（T42 进行中：`ensureFocus` 改名后调用点未跟、`State.windowVisibleMs` 未同步）；
  - `apps/desktop/src/main/document/documentToolRuntime.ts`（未提交改动）；
  - `apps/desktop/src/renderer/components/modules/{ModuleContributions.tsx,moduleCatalogShape.tsx}`（未提交 / 未跟踪）。
  本卡改动前这些文件不在我的 diff 里；`git stash` 会对其他会话的并行工作造成破坏，
  故如实记录而不是代为修。
- **动态方法名静态拦不住**：这是 JS 的固有边界，已在回执里如实说明；运行期由 T19 的
  `callAppFromExtension` 逐次鉴权 + 逐次审批兜底。
- **网络 / 写权限不在冒烟里验证**：冒烟只证明"能启动、能读、能返回"；write/network 是用户卡与
  运行期审批的事（不替用户预支）。Windows 上声明 `network` 的可执行扩展本身由
  `requireNetworkExtensionSupport` 在安装期拒绝，这条沿用既有行为、本卡未改。
- **工坊根在真实数据根下**（`<数据根>/extension-workshop`）：套件用临时数据根；真实路径下
  的目录清理归 §6 的对账，但"用户手工放进工坊根的目录"不会被识别为坏档（只跳过）。
- **渲染端 UI 未做**：卡面要求的用户确认走的是 T18 既有卡片（`ModuleSurface.tsx` 区域，
  本卡不改）；工坊状态目前只有工具面（`extension_workshop_status`），没有专门的面板。
  若产品需要可视化草稿/回滚点面板，另开卡。
- **不做**扩展市场、签名验证、VS Code 扩展生成（卡面明确不做，本卡未做）。

