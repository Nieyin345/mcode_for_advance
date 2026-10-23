# T19｜扩展 API 面：92 条 danger RPC 对已装扩展敞开，收窄它

- Status: done（2026-10-23 执行回写，见文末）
- Category: **bug（授权放宽）**
- Priority: **P0 安全**
- Depends on: T18（已交付三态权限 `e6515e45`）
- Exclusive writable files: `packages/contracts/src/appPermission.ts`、`apps/desktop/src/main/modules/ModuleHost.ts` 的授权分支、新建回归套件。逐个确认后写进回写区。

## Required Skills
- `security-best-practices`: 这是权限边界改动，必须论证每个降级路径。
- `mcode-smoke`: 建恶意扩展回归（越权、伪造身份、绕过审批）。
- `code-review`: 确认没有开出第二条绕过 ModuleHost 的通路。

Read before work: `CLAUDE.md`、`tasks/T18-extension-install-permission-card.md`、`docs/planning/product-roadmap/T15-agent-host-baseline.md` **N1 段**、`packages/contracts/src/appPermission.ts`、`apps/desktop/src/main/appControl/policy.ts`、`apps/desktop/src/main/modules/ModuleHost.ts`。

## 我原卡的前提是错的（必须纠正）

我在 T19 卡里写的是「**让扩展能调到 Mcode 的全部能力**」，把它当成一个**开放**任务。

**T15 基线证明这是反的**：

> 无面板扩展已能经 `core.app.call` 调任意已授权 RPC；其「danger 直接拒」验收与现状 **91 条可委托**冲突，**落地将是行为收紧，需迁移已装扩展授权**。

## 已核实的真实数字（我用脚本数的）

```
APP_METHOD_PERMISSIONS 总条目：443
  其中 null（不可委托）：77
  其中数组（可委托）：   366

policy.ts 的 DANGER 表：  92 条
policy.ts 的 BLOCKED 表： 59 条
```

**关键机制**：`assertAppMethodPermission` 只做两件事——

```ts
const required = permissionsForAppMethod(method);
if (required === null) throw Error("不可委托给扩展");        // BLOCKED 已拦
if (required === undefined) throw Error("未知方法");
for (const p of required) if (!granted.includes(p)) throw;   // 只看权限，不看档位
```

**`required` 是数组的 366 条方法里，凡是落在 `DANGER` 表（92 条）的，只要扩展在安装时拿到对应权限，`invoke` 就直接放行——不逐次审批。**

这就是 `git.push` / `project.delete` / `modules.install` 这类操作对已装扩展敞开的原因。

## 目标

让 `danger` 档在扩展调用时**逐次审批**，而不是靠安装时的权限一次性放行。

### 必须做到

1. **建立档位到扩展的映射**：`assertAppMethodPermission` 或它的调用方要能知道某个方法是 `danger` 档。
   - 注意：`policy.ts` 在 `apps/desktop/src/main/`，而 `appPermission.ts` 在 `packages/contracts/`。**契约层不能依赖主进程**。
   - 要么把档位信息下沉到契约层，要么在 ModuleHost 侧做判定。**必须论证选择。**
2. **danger 档的扩展调用要触发审批**，不能只看 `granted`。
3. **`blocked` 档保持现状**（已经 `null`，永远拒）。
4. **不给扩展任何「始终允许 danger」的路径**——即使安装时授予了权限，每次调用都要问。

### 迁移（这是本卡最难的部分）

现在可能有已装扩展依赖「安装授权即放行」的行为。收窄会打断它们。

**必须做到**：
- 列出收窄后哪些现有路径会变严
- 给出**可观测的拒绝理由**（不是静默失败）
- 如果某扩展确实需要反复执行 danger 操作，**它应该走工作流授权（`issueWorkflowGrant`），不是靠安装权限**

## 验收判据

1. 一个持有 `git.write` 权限的扩展调用 `git.push` → **触发审批**，不是直接放行。
2. 同一扩展调用 `BLOCKED` 表里的方法 → **直接拒**，不弹审批。
3. 同一扩展调用 `read` 档方法 → **不触发审批**（保持现状）。
4. 伪造模块 ID（渲染端传别人的 ID）→ 主进程按真实身份判定，拒绝。
5. 有面板扩展的既有 `api.call` 行为**不回归**（跑 `module-permissions-smoke` 等）。
6. 迁移：收窄后哪些路径变严，逐条列出，并验证每条给出可读的拒绝理由。
7. 变异验证：把 danger 档判定改成放行 → 第 1 条必须变红；逐字节还原（`cmp`）。
8. 双包 typecheck 通过。

## 从 T26 移交的一处文案

T26 查出 `ModuleHost.ts:543` 的抛错文本仍是「允许一次」。它是**用户可见字符串**，但该文件的授权分支是本卡的独占写入范围，T26 的硬约束禁止它碰。

**本卡改写这段授权分支时，一并把该文案改成「本次运行允许」**，与 `ide.ts` 的按钮和脚注保持一致。

## 边界

- **不新增权限名**（36 个不动）。
- **不开放 `BLOCKED` 表里的任何方法**。
- **不做 VS Code API 映射**——那是另一条线。
- **不碰** `workflowEngines/`、`orchestration/`、`document/`、`appControl/apiCatalog.generated.ts`、`ipc/settingsTransfer.ts`、`renderer/`。
- 若发现 `policy.ts` 与 `appPermission.ts` 的档位判定已经不一致，**报告而不是单方面统一**。

## 结果回写（2026-10-23）

### 1. 选择：宿主侧判定（不把档位下沉到契约层）

判定落在 `apps/desktop/src/main/modules/ModuleHost.ts` 的 `approveDangerAppCall`，直接
`import { policyFor } from "@main/appControl/policy.js"`。

论证：

- **下沉只能产生第二份 danger 名单。** 契约层不能 import 主进程，唯一能下沉的形态是把
  「哪些方法是 danger」抄进 `packages/contracts/src/appPermission.ts`。而该文件是
  `apps/desktop/scripts/gen-module-permission-map.mjs` 的**生成物**——手写的内容会被下一次
  生成覆盖；若改成让生成器写进去，生成器就会把 `apiCatalog.generated.ts` 里 10 条
  **目录已前进、权限映射尚未归类**的方法（`document.apps` / `document.markdownEdit` /
  `document.markdownRead` / `document.render` / `document.toolCall` / `document.toolDescribe` /
  `document.toolsList` 共 7 条 `document.*` + `framework.list/save/reset`）一次性收进
  委托面——那是**放宽**方向，正好与本卡相反。仓库硬规矩「共享实现只有一份」禁止两份
  danger 表并存。
- **宿主就是主进程，能直接复用唯一判据。** `policy.ts` 是零 import 的叶子模块（不碰
  electron/DB/UI，`grep -c '^import '` = 0），`service.ts` 与多个无头套件早已在同一 bundle
  里带上它。`policyFor` 改了，扩展闸门下一次调用就跟着变，不存在漂移。
- 契约函数 `assertAppMethodPermission` 的语义**原样保留**（只回答「权限够不够」）；
  档位是另一个维度（谁能调 vs 调了要不要再问），由宿主这一层补。

落点是一次扩展 RPC 的**唯一派发口** `callAppFromExtension`：权限判定之后、`invokeAppCall`
之前调 `approveDangerAppCall`。没有放进 `authorizeAppMethod`，因为它在一次调用里被调用
四次（`callAppFromExtension` 前后 + `invokeExtensionAppCall` 前后），放进去会弹四遍卡。

### 2. 92 条 danger 里现在会被拦的

`policyFor` 现算的 92 条 danger 中：

- **91 条可委托**（`APP_METHOD_PERMISSIONS[method] !== null`）→ 现在**每次调用先审批**
  （权限仍要够）。集合与新套件逐名相等，数量钉死 91：`policy.ts` 增删 danger 条目时
  套件会红，强迫重新审视本卡。卡面点名的 `git.push` / `project.delete` / `modules.install`
  都在内，另有 `setting.set` / `session.updateSettings` / `document.edit` / `customModel.save`
  / `agentSsh.approveHost` / `workflow.choose` 等。
- **1 条不可委托**：`workflowEngine.load`（映射 `null`）→ 仍在 `assertAppMethodPermission`
  处**直接拒、不弹卡**（"谁都够不到"不是"够得到但要问"）。
- **blocked 76 条**（含 `CREDENTIAL_BEARING`）保持不变：映射全部 `null`（套件对 76 条逐一断言），
  直接拒、零审批卡。

与卡面「92 条 danger 对已装扩展敞开」的差异：真实敞开的是 **91 条**（`workflowEngine.load`
早在 `gen-module-permission-map.mjs` 的 `nonDelegableOverrides` 里被钉 null）。这一点与
T15 §5 对 T19 的勘误（「91 条可委托」）一致。

### 3. 迁移影响面：收窄后哪些路径变严

只有一条路径变严：**已装扩展经 `core.app.call` 调用 `policy.ts` 判 danger 的方法**。

- 以前：安装时拿到对应权限 → 直接放行。
- 现在：每次调用多一道确认框（主进程原生 `dialog.showMessageBox`）；用户拒绝 → 调用失败，
  子进程拿到可读错误，宿主不派发、不写账。
- **read / write / ui 档不变**（套件对 read/write 有正控：零审批）。面板桥
  `mcode.api.call` 与 Agent `app_api_call` 本来就在 danger 档逐次弹卡，不受影响。
- **已装扩展需要做什么**：若它确实需要反复执行 danger 操作（而不是每次让用户点），按卡面
  指引应改走**工作流授权**（`issueWorkflowGrant`）——它只放行**只读** query/task 能力，
  够不到 RPC 桥，因此不是 danger 的旁路，而是"把只读任务自动化"的正路。本卡不给 danger
  任何自动化旁路（这本身就是要求 4）。
- **可读拒绝理由**（四类，各有稳定 `moduleRefusal` 码，上层据此报 REJECTED 而非 UNCERTAIN）：
  1. 权限不足 → `scope_denied` +「这个扩展没有 git.write 权限（调用 git.push 被拒绝）」
  2. blocked/不可委托 → `scope_denied` +「方法 X 不可委托给扩展」
  3. 用户拒绝 danger 审批 → `approval_denied` + 审批端口给出的原因（原生框：「用户拒绝了…」）
  4. 宿主没有审批通道 → `approval_unavailable` + 点名方法名的 fail-closed 说明
- 没有扩展会因本卡**被卸载或授权失效**：安装授权表格式未变，失效路径只有原有的
  版本/指纹/bootId 三条。

### 4. 恶意扩展测试（新套件 `extension-danger-delegation-smoke`，34/34）

| 攻击/回归 | 断言 |
|---|---|
| 持有 `git.write` 的全权限扩展调 `git.push` | 触发一次审批；`scope:"danger"`、`method:"git.push"`、`moduleId` 为宿主绑定身份、`resource` 带真实文件；批准后才派发 |
| **全部 91 条** danger 可委托方法逐一调用 | 每一条都且只出现一次审批；`dispatched` 数量一致 |
| 91 条全部拒绝 | `refused=91`、`dispatched=0` |
| blocked 方法（`claude.approve` 等 5 条 + 76 条全量映射检查） | 直接拒、**零审批卡**、零派发 |
| `workflowEngine.load` | 直接拒、零审批卡 |
| read 档（`file.readFile` 等 4 条）/ write 档（2 条） | 零审批（保持现状） |
| 「始终允许」 | 同一方法连续 3 次 = 3 次审批；期间**零授权存档写入**，授权表字节不变 |
| 无审批端口 | `approval_unavailable`，零派发 |
| 伪造身份：只读扩展调 `git.push` / 未知模块 id | 权限不足即拒（`scope_denied`），**连审批都不弹** |
| 审批挂起期间卸载模块 | 批准后复查发现模块已换 → 拒，零派发 |
| 端到端（真子进程 NDJSON） | `git.push` 先弹审批再派发；拒绝时子进程拿到可读错误且不派发；blocked 直接拒、不弹卡 |
| 迁移四类拒绝 | 每条都有可读理由与 `moduleRefusal` 码 |

### 5. 变异证据

**卡面第 7 条要求的原地变异 + 逐字节还原**：

- 把 `approveDangerAppCall` 的档位判定改成放行（`... !== "danger" || true`）并把调用点断开
  → 新套件 6 条断言同时变红（①「git.push 必须触发一次审批」、91 条逐一、全拒绝零派发、
  三次=三次审批、无端口拒绝…）；`cmp` 还原后 **BYTE-EXACT**，复跑 34/34。
- `build.mjs` 内置两条变异（与上面同两个锚点，esbuild onLoad 注入）：
  `danger-allowed` → ①/91 条/全拒绝/三次审批/无端口 5 组红；`no-approval-needed`（只断调用点）
  → 同一断言「①」与「91 条」变红。两条均 PASS（expected assertion RED）。

**既有红（非本卡造成，已核实）**：

- `module-permissions-smoke`：`Unmapped RPC method: document.apps` —— 与 T18 回写第 6 节同一
  既有红（`apiCatalog.generated.ts` 含 10 条 T24 带入的方法，`appPermission.ts` 未重新生成）。
  两者都在本卡边界外；本卡未碰。
- `capability-smoke`：`MC-099 三处同源` —— `core.app.call` 在 `fileCapabilities` 与
  `HOST_CAPABILITY_DECLARATIONS` 里有、`host.catalog().capabilities` 只列 query/task 时
  缺它。**用完整回退法核实**：把 `ModuleHost.ts` 原地回退到 HEAD 后该套**同样一条红、
  同一 detail**，再逐字节还原。与 T19 无关（是该套自身把 action 能力排除后仍拿全量声明表比）。

### 6. 测试与验证（提交后重跑）

- 新套件 `extension-danger-delegation-smoke` **34/34**，两条变异 PASS。
- 按 `smokes-for.sh` 映射跑关联套件，全绿：
  `module-app-call-smoke` 13/0（3 变异 PASS）、`module-install-consent-smoke` 36/36（4 变异 PASS）、
  `module-phase2-security-smoke` 32/0、`module-phase2-e2e-smoke`（真 Electron 旅程）10/0、
  `module-permissions-smoke` 10/1（既有红）、`extension-authoring-smoke` 24/24、
  `module-grant-revoke-safety-smoke` 34/34、`module-extension-lifecycle-smoke` 160/160、
  `module-catalog-smoke` 21/21、`module-catalog-ui-smoke` 26/26、`module-platform-smoke` 33/33、
  `module-executor-smoke` 30/30、`module-ui-smoke` 13/13、`module-workflow-smoke`（含 save-guard）、
  `vscode-l1-smoke` 27/27、`maint-m31-smoke` 8/0、`custom-ui-smoke` 292/292、
  `workflow-ui-smoke` 21/0、`app-control-smoke` 574/574、`policy-engine-smoke` 207/207、
  `startup-wiring-smoke` 13/13、`ipc-wiring-smoke` 45/45、`ipc-parity-smoke` 13/13。
- 双包 typecheck：`packages/contracts` exit 0、`apps/desktop` exit 0（仓库钉住的 TS）。

### 7. 提交 SHA

代码 + 回归套件：`1dd4211f5aea58f94459a90437f8d1ba8ded81ce`
（`fix(T19): approve every extension danger RPC call individually`）。
本回写单独提交，见其后一条 `docs(tasks): record T19 result writeback`。

### 8. 独占写入文件（实际）

- `apps/desktop/src/main/modules/ModuleHost.ts`（授权分支 + `callAppFromExtension` + 注释）
- `apps/desktop/src/main/modules/moduleApproval.ts` —— **只加 3 行注释**（说明 danger scope
  当前按写档文案呈现），无行为改动。它在卡的"授权分支"邻域内；若总控认为超出边界，可单独回退这 3 行。
- 新建 `apps/desktop/scripts/extension-danger-delegation-smoke/**`。
- **未改** `packages/contracts/src/appPermission.ts`（选择宿主侧判定后无需改；也是生成物，
  避免被下次生成覆盖）。**未碰** `workflowEngines/`、`orchestration/automationRunner.ts`、
  `document/`、`apiCatalog.generated.ts`、`ipc/settingsTransfer.ts`、`renderer/`、
  `build/vendor-licenses/`。

### 9. 发现的既有安全问题候选（报告，未单方面统一）

1. **权限映射与目录已漂移（10 条）**：`apiCatalog.generated.ts` 有、`APP_METHOD_PERMISSIONS`
   没有的 10 条 —— `document.apps`、`document.markdownEdit`、`document.markdownRead`、
   `document.render`、`document.toolCall`、`document.toolDescribe`、`document.toolsList`、
   `framework.list`、`framework.reset`、`framework.save`。后果是**双向**的：
   （a）`module-permissions-smoke` 的 closed-world 断言红（既有红）；
   （b）本卡的 danger 闸门对**没有权限映射**的方法走不到（`assertAppMethodPermission` 对
   `undefined` 直接抛「未知方法」→ 已被拒），所以扩展**够不到**它们（fail-closed）；
   （c）但这意味着 T24/T25 新加的方法对扩展是**不可用**的，直到重新生成映射。
   **未单方面统一**：`gen-module-permission-map.mjs` 是生成器卡（T15 N2）的范围，且重新生成
   会把上面 10 条一次性放进委托面——需由生成器卡决定归类，不能在本卡顺手做。
2. **`document.read` / `document.capabilities` 在 policy.ts 里是 blocked，reason 却写着
   `"read"`**（`policy.ts:151-152` 两条 `"document.read": "read"` 形式的值被当成 blocked 理由）。
   文案上把 blocked 方法标成 "read"，对模型/用户都是误导；且 `document.read` 是文档能力的
   只读入口，本应可委托。**这是 policy.ts 与 appPermission.ts 的判定不一致**（映射 `null` =
   不可委托，policy 说 blocked，但 reason 又暗示 read）。按卡面要求**报告而不是统一**。
3. **`moduleApproval.ts` 的 danger 文案**：扩展 danger RPC 的原生确认框目前复用"请求执行写
   操作"文案（无专属 i18n 键；词典在 `renderer/`，T19 边界外）。判定正确（每次都问），但
   用户看到的标题不点明"高风险方法、安装授权不能替代、没有始终允许"。建议后续卡补
   `common.moduleDangerApproval*` 词典键并接进 `moduleApproval.ts`。
4. **`dangerNonDelegable` 的语义依赖生成器**：`workflowEngine.load` 之所以不可委托，靠的是
   `gen-module-permission-map.mjs` 的 `nonDelegableOverrides` 硬编码，而不是 `policy.ts` 的
   档位。若未来有人新增 danger 方法却忘了加进那个集合，它默认会变成**可委托**（需 grant 且
   现在会逐次审批，但仍是"够得到"）。建议生成器卡把它改成"danger 默认 null，白名单可委托"。
