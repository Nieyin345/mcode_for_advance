# T49｜扩展调用面：把 438 个 RPC 暴露给扩展

| 项目 | 值 |
|---|---|
| 编号 | T49 |
| 类型 | **扩展系统主线**（用户：扩展要能操作所有的软件内容，都要有接口） |
| 优先级 | **最高** |
| 建议并发 | 改 `main/modules/`；**必须先完成 T48**（权限模型是它的地基） |
| 预计规模 | 中 |

---

## 一句话

T48 让扩展**有权限**调这些 API，T49 让扩展**真能调到**。

现在 `ModuleHost` 只有 **2 个内置能力**：

```ts
export const BUILTIN_CAPABILITY_CATALOGUE = [
  { id: "core.file.inspect", kind: "task",  source: "host" },  // 文件大小 + SHA-256
  { id: "core.file.info",    kind: "query", source: "host" },  // 字节数 + 修改时间
];
```

**扩展能做的事：看文件的哈希。**

---

## 关键发现：面板已经能调全部 RPC

```ts
// renderer/components/customUi/panelBridge.ts:216
case "api.call": {
  // 面板的 `mcode.api.call(method, input)` —— 调**任意**主进程方法。
  // 权限分类在**主进程**（`panelApiCall` 复用 agent `app_api_call` 那一套）
  const first = await api.customUi.panelApiCall({ method, input, panelLabel: label });
  if (!first.ok) {
    if (!first.needsApproval) throw new PanelCallError(...);
    // 弹确认框 → 用户点头 → 带 approved:true 重调
  }
}
```

**这条通路已经存在，而且走的是 `policy.ts` 的完整五档判定。**

但它只对有**面板 UI**的扩展开放。独立脚本（`ModuleHost`）调不到。

**所以 T49 的核心不是「造一条新通路」，是「把这条已有的通路接到 ModuleHost 上」。**

这是仓库硬规矩 2 的直接应用：**共享实现只有一份。**

---

## 目标

扩展能像面板一样调用任意 RPC：

```js
// 扩展的 program.source
export const run = async (resource) => {
  // 读文件
  const content = await mcode.api.call("file.readFile", { projectPath, path });

  // 让 AI 干活
  const session = await mcode.api.call("session.send", { sessionId, prompt: "..." });

  // 跑工作流
  await mcode.api.call("workflow.run", { workflowId });

  // 写结果
  await mcode.api.call("file.writeFile", { projectPath, path, content });

  return { ok: true, bytes: content.length };
};
```

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/appControl/tools.ts` 的 `app_api_call` / `panelApiCall` ——
   **这是要复用的那条实现**。
3. `apps/desktop/src/renderer/components/customUi/panelBridge.ts:216-240` 的
   `api.call` 分支 —— 面板侧怎么调的。
4. `apps/desktop/src/main/appControl/policy.ts` 的 `policyFor` 与五档判定。
5. `apps/desktop/src/main/modules/ModuleHost.ts` 的 `invoke` 与 `Capability` 接口。
6. `apps/desktop/src/main/modules/permissionedProcessRunner.ts` ——
   扩展跑在独立子进程，**不能直接调主进程函数**。
7. `apps/desktop/src/main/modules/vscodeL1Bridge.ts` ——
   现在怎么在子进程里注入 `vscode` 对象（`childL2Snippet`）。
8. T48 的产出 —— 授权表与权限映射。
9. `packages/contracts/src/modules.ts` 的 `ModuleResult` 形状。

---

## 执行内容

### 第 1 步：新的内置能力 `core.app.call`

在 `BUILTIN_CAPABILITY_CATALOGUE` 加一条：

```ts
{ id: "core.app.call", kind: "action", source: "host" }
```

**为什么是 `action` 而不是 `query`**：它能改东西。但注意——这个能力本身
**不代表任何具体权限**，真正的判定在 `policy.ts`（按被调用的方法名）。

它的输入：

```ts
{ method: string, input?: unknown }
```

输出：

```ts
ModuleResult  // 与 app_api_call 同形状
```

**实现必须复用 `invokeAppTool`**，不能另写一份判定。

### 第 2 步：跨进程的调用通路

扩展在**独立子进程**里（`permissionedProcessRunner`），不能直接 import 主进程函数。

现有的通信方式（实读 `permissionedProcessRunner.ts`）：
- 扩展源码与入参经 **stdin** 送入
- 结果经 **stdout** 单行协议回传

**这是一个一次性的请求/响应，不是双向通道。**

要做 `mcode.api.call`，需要扩展在运行期间**多次**向主进程请求。

两条路：

- **A：扩展程序改成可多次调用**
  现在 `program.source` 求值出一个 `{ [短名]: async (resource) => result }`，
  每次 invoke 调一次就结束。改成扩展能在一个运行里多次 call。

- **B：主进程预取**
  一次性把所有需要的数据喂给扩展，扩展算完一次性返回。
  但这样扩展**不能主动让 AI 干活**（`session.send` 是长任务）。

**必须走 A。**

实现方式：把 `stdout` 单行协议扩成 **NDJSON 双向通道** —— 扩展发一行
`{"__mcode_call": 1, "id": 1, "method": "...", "input": {...}}`，
主进程回一行 `{"__mcode_reply": 1, "id": 1, "ok": true, "result": ...}`。

**注意**：现有的 `NETWORK_GUARD`、`--permission` 限制不能因此松动。
扩展仍然不能 `require("http")`。它只能经这条通道请求。

### 第 3 步：`vscode` 对象的扩展（可选，取决于 T50）

如果同时做 VS Code 兼容，`vscode.*` 的每个 API 也要走同一条通道。
但**本卡只做 `mcode.api.call`**，`vscode.*` 是 T50 的事。

### 第 4 步：权限判定的接线

`core.app.call` 的一次调用要经过：

```
1. 扩展有没有 core.app.call 这个能力？（ModuleHost 的既有判定）
2. 被调用的方法 M 需要哪个权限？（T48 的映射）
3. 扩展的授权表里有没有那个权限？（T48 的授权表）
4. M 是不是 blocked？（policy.ts 的 BLOCKED 表）
5. M 是否需要额外的资源授权？（authorize(resource)）
```

**第 2/3/4 步全部复用 T48 与 `policy.ts`，不另写。**

### 第 5 步：给 AI 写插件用的文档

**这是用户明确要的**：「我可以让 mcode 里面的 ai 帮我写插件」。

在 `app_guide` 里加一个 topic：`extensions`。内容包括：
- 扩展清单的形状（`ModuleManifestSchema`）
- 可用的权限清单（T48 的）
- `mcode.api.call` 的用法 + 常用的 10 个方法示例
- 一个最小可用的扩展模板

**AI 写插件时先读这个 topic，就能知道怎么写。**

---

## 边界（不要碰）

- **不新建第二套权限判定**（复用 `policy.ts` + T48 的映射）。
- 不放松 `NETWORK_GUARD` 与 `--permission`。
- 不改 `blocked` 表。
- 不改面板桥（`panelBridge.ts`）—— 它是另一条通路，两边共用判定即可。
- 不改文档 / 工作流 / Node-RED 相关代码。

---

## 验收判据

1. 一个扩展能调用 `file.readFile` 读到真实文件内容（有断言）。
2. 一个扩展能调用 `session.send` 让 AI 回一句话（有断言，可用假 provider）。
3. 调用**未授权**的方法 → 拒绝，且错误消息点名缺哪个权限（有断言）。
4. 调用 `blocked` 的方法 → 拒绝（有断言）。
5. 扩展**不能** `require("http")` / `require("child_process")`（既有断言不回归）。
6. 长任务（如 `session.send`）期间，取消信号能传到扩展（有断言）。
7. `app_guide` 的 `extensions` topic 能被 `app_guide { topic: "extensions" }` 读到。
8. 现有 `module-*` 套件全绿。
9. 双包 tsc 干净。
10. **变异验证**：撤掉权限检查 → 判据 3 红；撤掉 `blocked` 判定 → 判据 4 红；
    撤掉取消传播 → 判据 6 红。

---

## 回写区要回答

- 双向 NDJSON 通道对现有的一次性协议有没有破坏？（`isolated_timeout` /
  `isolated_cancelled` 这些失败码还成立吗）
- 扩展在一个运行里能发多少次 `api.call`？有没有上限？
- `session.send` 这种长任务，扩展怎么知道进度？
- 扩展能不能调 `mcode.api.call` 访问**别的扩展**的 storage？
- AI 用 `app_guide` 的 `extensions` topic 能不能真的写出一个能跑的扩展？
  （让 AI 试一次，把结果写进回写区）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 T49 执行回写

- **调用面与唯一实现**：在宿主内置能力目录新增 `core.app.call`（action）；隔离 `program.source` 运行期挂入 `mcode.api.call(method,input)`。主进程装配时将可信的模块调用端口接到已有 `invokeAppTool("app_api_call")`，再走既有的 `findEntry` / `policyFor` / T48 `authorizeAppMethod` / `callRpc` / 结果判定。模块 ID 由 `ModuleHost` 绑定（不信任子进程传入的 moduleId）；授权在派发前、结果发布前重新核验。未安装/未授权/blocked 全部拒绝；安装同意的写与 danger 方法跳过逐次审批，但不放开 blocked。
- **协议兼容**：旧 `runPermissionedProcess` 无 `onAppCall` 时保留原来的 `spawnRun` 单次 stdin → stdout 协议；仅宿主提供回调时启用双向 NDJSON，子进程 stdout `@@mcode:ext-call` 发请求，stdin `__mcode_reply` 回包，`@@mcode:ext-result` 发最终结果。继续使用同一组文件系统 `--permission` 参数、`NETWORK_GUARD`、OS egress 决策。失败码 `isolated_timeout`、`isolated_cancelled`、`isolated_crash`、`isolated_denied` 保留。
- **额度与长任务**：一次扩展能力运行最多 128 次 RPC 请求、最多 8 条并发、单条请求 64 KiB，双向协议总输出 256 KiB，保留模块 program.timeoutMs 的墙钟上限。长 `claude.sendTurn` 可以 await 结果；目前没有单独进度事件，取消通过 AbortSignal 终止子进程并拒绝迟到结果；正在进行的外部 RPC 已落定的副作用不能保证撤回。
- **真实方法名**：任务示例里的 `session.send` 是授权域名，不是现有 RPC 方法。真实可调方法为 `claude.startSession` / `claude.sendTurn`，`file.readFile` 的实际入参为 `{filePath}`。测试与 AI 指南采用真实形状。
- **隔离与跨扩展存储**：`mcode.api.call` 不能直接声明他人模块身份；`extensionStore.*` 仍经过既有 `runWithUnboundAgentExtensionScope`，因此不能通过通用 agent RPC 访问其他扩展的数据区；扩展自己的存储须走已有宿主绑定接口。 `child_process`、未授权 HTTP 出站的负例均按预期失败；Windows JS 守卫降级仅在测试中以明确注入允许，生产仍由用户设置控制。
- **AI 文档**：`app_guide({topic:"extensions"})` 的清单模板、权限名和方法说明由 T51 同时接入的 `extensionAuthoringGuide` 提供，并明确 `mcode.api.call` 用法。专项 `extension-authoring-smoke` 通过；本任务以实际 `ModuleManifestSchema` 清单安装 + 程序源运行作为可运行模板验证，未执行独立 AI 模型实时生成插件的端到端试写。
- **专项验证**：`node apps/desktop/scripts/run-smokes.mjs module-app-call-smoke` 基线 7 pass / 0 fail，运行真实 fixture 文件、假 AI provider、无授权、blocked、隔离、撤权取消；三组变异分别撤掉宿主授权校验、blocked 判定、AbortSignal 监听，均触发对应断言红例，详见 `apps/desktop/.tmp/module-app-call-*/{baseline,auth,blocked,cancel}.log`。
- **回归限制**：新加 `core.app.call` 后已更新模块能力目录两个旧的定长断言；module-catalog/module-catalog-ui/module-workflow、extension-authoring 等通过。16 条 module-* 汇总检查中 `module-contributions-smoke`（并行 T50 的 task/result 断言）与 `module-phase2-e2e-smoke`（native-window 工作流 UI 找不到 File inspection）尚未全绿，不归到 T49 权限/协议处理，判据 8 暂未达成。
- **类型检查**：contracts `node_modules\\.bin\\tsc --noEmit -p packages/contracts/tsconfig.json` exit 0；desktop 同命令另行复跑验收。

### 2026-10-21 T49 收尾验收回写

- **实现提交 SHA**：`2af6b0ec`（`fix(T49): finish extension app call regression checks`）。
- **本次实现提交文件**：
  - `apps/desktop/src/main/appControl/tools.ts`
  - `apps/desktop/src/main/modules/ModuleHost.ts`
  - `apps/desktop/src/main/modules/builtinCapabilityCatalogue.ts`
  - `apps/desktop/src/main/modules/fileCapabilities.ts`
  - `apps/desktop/src/main/modules/moduleApproval.ts`
  - `apps/desktop/src/main/modules/permissionedProcessRunner.ts`
  - `apps/desktop/src/main/modules/service.ts`
  - `apps/desktop/scripts/module-app-call-smoke/main.ts`
  - `apps/desktop/scripts/module-app-call-smoke/build.mjs`
  - `apps/desktop/scripts/module-app-call-smoke/run.sh`
  - `apps/desktop/scripts/module-catalog-smoke/main.ts`（仅更新新增 host capability 对应的定长断言）
  - `apps/desktop/scripts/module-catalog-ui-smoke/verify.ts`（仅更新新增 host capability 对应的定长断言）
  - 未纳入 `apiCatalog.generated.ts`、T76/T82/T83/T84/T50 或其他执行对话的文件；共享 smoke 文件只提交了上述 T49 所属 hunk。

- **专项命令与变异验证**：最终单独执行 `node apps/desktop/scripts/run-smokes.mjs module-app-call-smoke`，13 PASS / 0 FAIL；日志：`apps/desktop/.tmp/smoke-runs/1792597063230-3776-ppr7sW/module-app-call-smoke.log`。断言覆盖真实 fixture 的 `file.readFile`、假 AI provider 的 `claude.sendTurn`、未授权拒绝、blocked 拒绝、`child_process` / HTTP 出站拒绝、128 次调用上限、8 并发上限、64 KiB 单请求上限、256 KiB stdout 上限、timeout、撤权取消和迟到结果不发布。变异产物：`apps/desktop/.tmp/module-app-call-IRpmg7/{baseline,auth,blocked,cancel}.log`；auth / blocked / cancel 三组均触发各自预期断言红例。
- **变异源字节证据**：在最终专项复验前，以二进制方式备份 `ModuleHost.ts`、`appPermission.ts`、`permissionedProcessRunner.ts`；变异由 esbuild `onLoad` 在内存中施加，不写原文件。运行后对三个原文件分别执行 `fc /b`，均输出“找不到差异”；备份目录随后仅清理本次创建的目录。没有对源文件做变异后恢复，也没有碰其他工作区修改。

- **完整 module 回归实际命令**：
  `node apps/desktop/scripts/run-smokes.mjs module-app-call-smoke module-catalog-smoke module-catalog-ui-smoke module-contract-smoke module-contributions-smoke module-executor-smoke module-extension-lifecycle-smoke module-file-identity-smoke module-grant-revoke-safety-smoke module-permissions-smoke module-phase2-e2e-smoke module-phase2-security-smoke module-platform-smoke module-protocol-integrity-smoke module-ui-smoke module-workflow-smoke extension-authoring-smoke`
  - 结果：17 个 suite 中 16 PASS / 1 FAIL；日志根目录：`apps/desktop/.tmp/smoke-runs/1792597183171-14268-pi0Ca9/`。下表为各日志中的 PASS/FAIL 断言计数，日志文件均位于该目录：

| Smoke | PASS / FAIL | 日志文件 |
|---|---:|---|
| `module-app-call-smoke` | 13 / 0 | `module-app-call-smoke.log` |
| `module-catalog-smoke` | 21 / 0 | `module-catalog-smoke.log` |
| `module-catalog-ui-smoke` | 26 / 0 | `module-catalog-ui-smoke.log` |
| `module-contract-smoke` | 118 / 0 | `module-contract-smoke.log` |
| `module-contributions-smoke` | 15 / 0（构建/契约 10 + UI 5） | `module-contributions-smoke.log` |
| `module-executor-smoke` | 30 / 0 | `module-executor-smoke.log` |
| `module-extension-lifecycle-smoke` | 160 / 0 | `module-extension-lifecycle-smoke.log` |
| `module-file-identity-smoke` | 9 / 0 | `module-file-identity-smoke.log` |
| `module-grant-revoke-safety-smoke` | 34 / 0 | `module-grant-revoke-safety-smoke.log` |
| `module-permissions-smoke` | 9 / 1 | `module-permissions-smoke.log` |
| `module-phase2-e2e-smoke` | 99 / 0 | `module-phase2-e2e-smoke.log` |
| `module-phase2-security-smoke` | 32 / 0 | `module-phase2-security-smoke.log` |
| `module-platform-smoke` | 33 / 0 | `module-platform-smoke.log` |
| `module-protocol-integrity-smoke` | 15 / 0 | `module-protocol-integrity-smoke.log` |
| `module-ui-smoke` | 10 / 0 | `module-ui-smoke.log` |
| `module-workflow-smoke` | 41 / 0（workflow 38 + shared save guard 3） | `module-workflow-smoke.log` |
| `extension-authoring-smoke` | 24 / 0 | `extension-authoring-smoke.log` |

- **两个重点回归最终原因**：
  - `module-contributions-smoke`：本轮当前版本 10/10 构建/契约断言通过，另 5/5 UI 断言通过；日志见上表，不再沿用旧失败记录。
  - `module-phase2-e2e-smoke`：当前 4 个 stage 全部 exit 0。native Electron 创建阶段 14/14、重新打开阶段 8/8，证据为 `apps/desktop/.tmp/p2-06-native-q6rLuv/result.json`、`create-checks.json`、`reopen-checks.json`；总阶段结果为 `apps/desktop/.tmp/p2-06-e2e-mLclQh/result.json`。当前 smoke 源码已没有旧的 `[role=button][title="File inspection"]` 定位器，现行原生 UI 路径实测通过；旧超时在当前版本不可复现，证据指向旧测试定位器/测试路径，而非 T49 RPC 回归或本轮 T50 UI 接线。未修改 T50 文件。

- **唯一未通过项及边界**：`module-permissions-smoke` 为 9 PASS / 1 FAIL，失败断言为 `All current RPC methods have a closed-world permission mapping`，具体是 `Unmapped RPC method: workflowEngine.load`。该方法已在 HEAD 的 API catalog 中，`policy.ts` 将其标为 DANGER，但未出现在干净的 T48 `packages/contracts/src/appPermission.ts` 映射中；本次 T49 改动没有触及该映射。由于任务边界明确禁止修改工作流相关代码，且擅自补授权限会改变危险方法的扩展可调用面，本轮不越界添加 grant。**验收判据 8（现有全部 module-* suite 全绿）仍未达成**；需要 T48/工作流权限映射所有者另行决策并修复。

- **类型检查**：`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` exit 0；`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` exit 0。两项均在最终 smoke 源码修改后重跑。
- **协议、安全与 AI 文档核对**：旧调用方不传 `onAppCall` 时仍走原 `spawnRun` 单次协议；`module-protocol-integrity-smoke` 15/15、`module-extension-lifecycle-smoke` 160/160 通过。双向路径仍用原 `NETWORK_GUARD`、`permissionArgs` 和 `permissionedEnv`，不放松 Node `--permission`；取消和超时的失败码断言通过。通用 RPC 的 `extensionStore.*` 仍走原 `runWithUnboundAgentExtensionScope`，没有新增跨扩展 storage 通道。T51 的 `extension-authoring-smoke` 实际调用 `app_guide({topic:"extensions"})` 并通过 24/24；本轮 AI 按该主题模式试写并运行了最小 file-summary 扩展，真实读取 fixture、调用假 `claude.sendTurn` 并返回摘要结果。此处验证的是文档模式 + 假 provider 的可运行性，没有调用外部真实模型。
- **附加检查**：提交前 `git diff --check` 通过；暂存区仅含上列 12 个 T49 实现/测试文件。


### 2026-10-21｜总控独立复核与收尾要求

- 总控复跑 16 个 `module-*` 套件：**15 PASS / 1 FAIL**；唯一失败仍是 `module-permissions-smoke` 的闭世界映射断言，缺少 `workflowEngine.load`。另行复跑 `module-app-call-smoke`、`module-contributions-smoke`、`module-phase2-e2e-smoke` 均 PASS；`packages/contracts` 与 `apps/desktop` TypeScript 检查均 PASS。
- 任务归属需要按历史台账统一：`tasks/T69-60-smoke-failure-triage.md` 的后续建议 #6 与 `tasks/T67-catalog-drift.md` 已明确将 `APP_METHOD_PERMISSIONS` 缺少 `workflowEngine.load` 归到 T49 收尾边界。该尾项是 **T48 既有权限映射生成/覆盖问题**，不是改 Node-RED 工作流实现；不要改 `apiCatalog.generated.ts`、`policy.ts` 或工作流运行器，也不要手工另造第二份权限表。
- 请原 T49 执行对话继续收尾：检查 `apps/desktop/scripts/gen-module-permission-map.mjs`、`policyFor("workflowEngine.load")` 和当前 API catalog 的 Git 状态；按既有 `policyFor`/域映射规则确定它应映射为 `workflow.write` 还是需要显式非委托 override，再用现有生成器更新 `packages/contracts/src/appPermission.ts`。生成前若 `apiCatalog.generated.ts` 仍有并行未提交修改，不得暂存/提交该文件；先确认其来源和快照稳定性。然后复跑 `module-permissions-smoke`、完整 17-suite 命令、双包 TypeScript 与相关变异验证，并追加最终回写及提交 SHA。
- **当前 T49 不可标记全部验收完成**：判据 8 仍未达成；保持同一个 T49 owner 收尾，不另派重复 owner，不以其它 16 套通过替代权限映射覆盖判据。


### 2026-10-22 T49 权限映射尾项收尾

- **代码提交 SHA**：`5861511b08bb707e8e36a500ce185e67fc3a3e53`（`fix(T49): preserve workflow load approval boundary in extension map`）。
- **本次提交文件（仅 3 个）**：
  - `apps/desktop/scripts/gen-module-permission-map.mjs`
  - `packages/contracts/src/appPermission.ts`
  - `apps/desktop/scripts/module-permissions-smoke/main.ts`
  没有修改或暂存 `apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`policy.ts`、工作流实现或其他任务文件。提交前暂存区只包含上述三个文件，`git diff --check` 通过。

- **策略判断与生成依据**：
  - 在干净的临时 worktree（基于提交 `77a8f7f4335f781332f4c21b32d6a7b6864697e0`）中运行现有生成器：`node --experimental-strip-types apps/desktop/scripts/gen-module-permission-map.mjs`。生成器报告 440 RPC methods、37 used permissions、41 total permissions、74 blocked。
  - 该快照中的 `policyFor("workflowEngine.load")` 实测为 `level: "danger"`，原因是“加载工作流会停止运行中的引擎并覆盖画布上的未部署草稿”；生成后的映射为 `"workflowEngine.load": null`。
  - `invokeExtensionAppCall` 通过可信扩展路径进入 `invokeAppTool`；此路径不会弹出普通的逐次 `gateAppAction` 审批。若映射为 `workflow.write`，扩展已获得该域 grant 后即可绕过此方法原有的每次人工确认。因此采用生成器中的显式 `nonDelegableOverrides`，并在生成时校验该方法仍存在于 catalog 且 `policyFor` 仍为 `danger`。这只拒绝扩展委托，不改 `policy.ts`，不把全局策略改为 `blocked`，也不改变普通 `app_api_call` 的 danger 审批语义。
  - 因主工作区的 `apiCatalog.generated.ts` 有其他任务的未提交修改，没有用该混合快照运行生成器。只把干净快照生成结果中 `workflowEngine.load: null` 这一项带入当前生成文件，保留了其余现有映射；共享 catalog 未暂存、未提交。

- **专项权限 Smoke**：`node apps/desktop/scripts/run-smokes.mjs module-permissions-smoke` → **1 suite PASS**；日志 `apps/desktop/.tmp/smoke-runs/1792599267211-39988-bH8QeB/module-permissions-smoke.log`，11 PASS / 0 FAIL。闭世界映射覆盖断言通过；新增断言验证 `workflowEngine.load` 仍为 danger、保留具体风险原因、扩展映射为 `null)，并且即使给出全部权限也会被拒绝。该日志中的 auth、blocked、upgrade 三组变异均触发预期红例。

- **权限映射变异验证**：临时移除 `packages/contracts/src/appPermission.ts` 中生成的 `workflowEngine.load` 条目后，执行同一 `module-permissions-smoke`，预期失败已复现：日志 `apps/desktop/.tmp/smoke-runs/1792599321500-33988-WgX7Ig/module-permissions-smoke.log`，退出码 1，9 PASS / 2 FAIL；其中闭世界断言明确报 `Unmapped RPC method: workflowEngine.load`，新加的危险方法非委托断言也失败。脚本在 `finally` 中恢复原始字节，并以 Buffer 逐字节比较确认 `appPermission.ts` 恢复一致；临时变异脚本已删除。

- **T49 app-call 专项及原有变异**：`node apps/desktop/scripts/run-smokes.mjs module-app-call-smoke` → 1 suite PASS；日志 `apps/desktop/.tmp/smoke-runs/1792599332555-36444-g8xU0n/module-app-call-smoke.log`，13 PASS / 0 FAIL。auth、blocked、cancel 三组变异均产生预期红例；真实 fixture 读取、假 AI provider、未授权拒绝、隔离、限额、超时、撤权取消及迟到响应检查均通过。

- **完整 17-suite 回归命令**：
  `node apps/desktop/scripts/run-smokes.mjs module-app-call-smoke module-catalog-smoke module-catalog-ui-smoke module-contract-smoke module-contributions-smoke module-executor-smoke module-extension-lifecycle-smoke module-file-identity-smoke module-grant-revoke-safety-smoke module-permissions-smoke module-phase2-e2e-smoke module-phase2-security-smoke module-platform-smoke module-protocol-integrity-smoke module-ui-smoke module-workflow-smoke extension-authoring-smoke`
  - 结果：**17 PASS / 0 FAIL**。日志根目录：`apps/desktop/.tmp/smoke-runs/1792599361870-24836-yVOVUq/`。

| Smoke | PASS / FAIL | 日志 |
|---|---:|---|
| `module-app-call-smoke` | 13 / 0 | `module-app-call-smoke.log` |
| `module-catalog-smoke` | 21 / 0 | `module-catalog-smoke.log` |
| `module-catalog-ui-smoke` | 26 / 0 | `module-catalog-ui-smoke.log` |
| `module-contract-smoke` | 118 / 0 | `module-contract-smoke.log` |
| `module-contributions-smoke` | 15 / 0 | `module-contributions-smoke.log` |
| `module-executor-smoke` | 30 / 0 | `module-executor-smoke.log` |
| `module-extension-lifecycle-smoke` | 160 / 0 | `module-extension-lifecycle-smoke.log` |
| `module-file-identity-smoke` | 9 / 0 | `module-file-identity-smoke.log` |
| `module-grant-revoke-safety-smoke` | 34 / 0 | `module-grant-revoke-safety-smoke.log` |
| `module-permissions-smoke` | 11 / 0 | `module-permissions-smoke.log` |
| `module-phase2-e2e-smoke` | 99 / 0 | `module-phase2-e2e-smoke.log` |
| `module-phase2-security-smoke` | 32 / 0 | `module-phase2-security-smoke.log` |
| `module-platform-smoke` | 33 / 0 | `module-platform-smoke.log` |
| `module-protocol-integrity-smoke` | 15 / 0 | `module-protocol-integrity-smoke.log` |
| `module-ui-smoke` | 10 / 0 | `module-ui-smoke.log` |
| `module-workflow-smoke` | 41 / 0 | `module-workflow-smoke.log` |
| `extension-authoring-smoke` | 24 / 0 | `extension-authoring-smoke.log` |

- **双包 TypeScript**：
  - `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`：exit 0。
  - `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`：exit 0。
- **验收判据状态**：本次前唯一未达成的判据 8（完整 module 回归全绿）现已通过；判据 3/4/6 的 auth、blocked、cancel 变异，以及本次映射缺项变异均证明断言能按预期变红。结合既有回写和本轮复验，T49 的 10 条验收判据均已满足。
- **并行工作区保护**：`apiCatalog.generated.ts` 以及 `.aoci/baseline.json`、T76 的 smoke/回写文件、`ipc/settingsTransfer.ts` 等其他未提交修改均保留在原处，没有纳入本次提交；本次只提交 T49 的生成器、映射条目和权限 Smoke。
