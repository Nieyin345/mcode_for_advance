# UI-MODULES-P2 / 任务 03：模块能力工作流执行器

## 状态

**READY_FOR_INTEGRATION**（本任务定向验证通过；**不代表**整个功能端到端通过）

- 承接对话标识：Arena / UI-MODULES-P2 / P2-03
- 开始 HEAD：`4e25a77fa0b95a97baf2f9423d399e442b98aab4`
- 当前核对 HEAD：`4e25a77fa0b95a97baf2f9423d399e442b98aab4`
- 使用的 interface-v2 冻结版本：**P2-01 / 1.0.0**（`docs/parallel-ui-modules/interface-v2.md`，状态 FROZEN）
- 本轮**未使用冻结快照**，在共享工作区的活动树上作业。

## 实际改动文件

| 文件 | 新增/修改 | 用途 |
|---|---|---|
| `apps/desktop/src/main/orchestration/moduleCapabilityExecutor.ts` | 新增 | `ModuleCapabilityExecutor` 与注入端口 `WorkflowModuleHostPort` |
| `apps/desktop/scripts/module-executor-smoke/main.ts` | 新增 | 30 条定向断言（替身时序 + 真实宿主） |
| `apps/desktop/scripts/module-executor-smoke/build.mjs` | 新增 | esbuild 无头打包 + 4 个突变开关 |
| `apps/desktop/scripts/module-executor-smoke/run.sh` | 新增 | 入口，进入 `run-smokes.mjs` 动态发现集合 |
| `docs/parallel-ui-modules/task-03.md` | 修改 | 本报告 |

**没有修改任何其他文件。** `runner.ts` / `scheduler.ts` / `executionEngine.ts` / `executorRegistry.ts` / contracts / 宿主实现全部只读。

## 已完成

1. `ModuleCapabilityExecutor` 实现 `NodeExecutor`，`kind` 取自冻结常量 `MODULE_CAPABILITY_RUNNER_KIND`，声明 `supportsProgress` / `supportsCancellation`，`supportsArtifacts: false`。
2. 依赖注入：`host` 接受实例**或工厂**。生产侧传 `getModuleHost`，懒加载语义不被破坏（已有专项断言）。
3. 只读 `input.moduleCall`，并对其再跑一次冻结的 `ModuleWorkflowExecutionInputSchema`（fail-closed）。**不读 `WorkflowNode.params`，不生成 requestId。**
4. `resource.projectPath` 取自可信的 `ExecutionContext.cwd`；相对路径相对它解析；真实路径 / 已登记根 / symlink / 普通文件判定**全部留给宿主**，执行器不建第二套资源授权。
5. 按冻结稿第 6 节实现结果、错误与取消映射（下表全部有断言覆盖）。
6. **进度量纲显式换算**：宿主 `0～1` → `ExecutionProgress.percent` `0～100`，非有限值丢弃，重复值不重发。
7. 轮询有退避、有总上限，且上限（默认 45s）**大于宿主自身的 30s 任务超时**；计时器与 abort 监听器在同一处摘净。
8. 覆盖三种竞态：预取消（零宿主调用）、轮询中取消、**invoke 未返回时取消而句柄迟到**（立即收掉，不留孤儿任务）。
9. 任务丢失 / 淘汰 / 重启后找不到 → 显式失败，**不静默重跑**。
10. 调度器 `cancel(context)` 钩子按 `runId:nodeId` 找回本执行器登记的句柄，**只取消自己的任务**。

## 测试证据

### 绿灯

```
cd apps/desktop && node scripts/module-executor-smoke/build.mjs
→ exit 0，30 checks passed
```

```
node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
→ exit 0，0 error（desktop 包整包，含 scripts/**，即本套件也被类型检查）
```

```
cd apps/desktop && node scripts/run-smokes.mjs --all --list
→ exit 0；module-executor-smoke 出现在动态发现集合中（本次观测共 111 套；数量取实测值，不硬编码）
```

日志位置：本套件由 `build.mjs` 直接 spawn，产物在 `apps/desktop/.tmp/module-executor-*/`；经 `run-smokes.mjs` 运行时日志落 `apps/desktop/.tmp/smoke-runs/<运行目录>/`。

### 有效红灯（突变证明，**只改临时打包产物，不动生产源码**）

`MODULE_EXECUTOR_MUTATION=<name> node scripts/module-executor-smoke/build.mjs`

| 突变 | 改掉什么 | 结果 | 咬住它的断言 |
|---|---|---|---|
| `no-precancel` | 去掉「signal 已取消就不发宿主调用」 | **exit 1** `1 !== 0` | `already-cancelled node performs zero host calls` |
| `raw-progress` | 把 `task.progress * 100` 改成直传 | **exit 1** 实得 `[0,0.5,1]`、期望 `[0,50,100]` | `host progress 0..1 is converted to percent 0..100` |
| `no-late-cancel` | 去掉拿到迟到句柄后的立即收手 | **exit 1** 已取消的节点仍报了一次进度 | `late handle after cancellation is cleaned up…` |
| `no-cancel-on-abort` | 轮询中观察到取消时不再 `cancel(ref)` | **exit 1** `0 !== 1` | `cancelling while polling cancels only this task` |

> 第三个突变**第一版没红**：原断言只看结局状态，而轮询循环开头的取消检查与那个守卫等效，去掉守卫后结局仍是 `cancelled`。已改为断言「已取消的节点不得再报进度」，守卫因此具有可观测效果，突变随即转红。这一处按 `CLAUDE.md` 的规矩处理了——先撤掉修复看它真的红，再装回去。

### 真实实现 vs 替身

- **真实**：真 `ModuleHost` + 真 `fileCapabilities()` + 临时目录里的真文件。覆盖 query（`core.file.info` 返回真实 `bytes`/`modifiedAt`）、task（`core.file.inspect` 返回与 `createHash("sha256")` 逐字节一致的摘要）、`user.*` 经工作流入口被拒、伪造 `core.` 未登记被拒、未知贡献被拒、路径穿越被拒、未登记 cwd 被拒、**同一 requestId 只起一个宿主任务 / 新 requestId 真的重跑**。
- **替身**：只用于摆时序（取消竞态、任务丢失、执行器超时、非有限进度）。这些在真实宿主上无法稳定复现，且不涉及任何授权判断。
- 全程未调用真实模型、未触碰真实用户库、未启动 Electron 或 Python/Node 子进程；文件测试只用 `mkdtemp` 临时目录并在 `finally` 清理。

## 结果映射（已实现且有断言）

| 宿主/执行状态 | NodeOutcome |
|---|---|
| query 返回 result | `success`，`outputs` = 完整 `ModuleResult` |
| task completed 且有 result | `success`，`outputs` = 完整 result |
| task completed 但无 result | `failed`（不伪装成空成功） |
| task failed（含宿主 30s 超时） | `failed`，保留宿主原因，`summary` 为空 |
| task cancelled | `cancelled`，不发布 outputs |
| 调用/轮询抛错、任务已丢失 | `failed`，写明原因，**不自动重做 invoke** |
| 调用前已取消 | `cancelled`，零宿主调用 |
| 等待中取消 / 句柄迟到 | `cancelled`，且本任务被收掉 |
| 执行器等待上限到期 | `failed`（`did not settle`），并收掉宿主任务 |

`summary` = `JSON.stringify(result).slice(0, 2000)`；**`outputs` 不因摘要截断而截断**。不虚构 `artifacts`；不填 `execution`（计时仍由现有 ExecutionEngine 负责）。

## 给任务 05 的接入说明

```ts
import { ModuleCapabilityExecutor } from "./moduleCapabilityExecutor.js";
import { getModuleHost } from "@main/modules/service.js";

// executionEngine.ts 与 runner.ts **两条**注册路径都要接；
// 传工厂而不是实例，保住 getModuleHost 的懒加载。
registry.register(new ModuleCapabilityExecutor({ host: () => getModuleHost() }));
```

- 构造参数：`{ host: WorkflowModuleHostPort | (() => WorkflowModuleHostPort), pollIntervalMs?, maxPollIntervalMs?, maxWaitMs? }`。后三项**只在测试里注入**，生产用默认值。
- `NodeExecutorRegistry.register` 对重复 kind 直接抛错：同一个注册表不要注册两次。
- 05 必须交来**已通过 `ModuleWorkflowExecutionInputSchema`** 的 `input.moduleCall`（含宿主产生的 `requestId`）。执行器会再校验一次并 fail-closed，但那是兜底，不是 05 可以省略校验的理由。
- 执行器**不**注册自己、**不**读节点参数、**不**生成 requestId。

## 跨任务请求 / 阻塞

- **→ 05（P2-01-REQ-01 的落地）**：冻结稿采用「每次新派发由宿主分配 nonce」，我已按此实现（执行器原样复用 `moduleCall.requestId`）。请在 `task-05.md` 回复 nonce 的**具体产生位置**，并测试四种情形：同次传输重试、明确重跑、循环下一轮、续跑重投。
  我先前报告的 `rounds` 缺陷（`scheduler.ts:975` 只在成功时 `appendStep`，失败路径不自增）已被 01 复核采纳；**请勿**退回用 `runId+nodeId+rounds` 拼身份——真实宿主测试已证明同 requestId 不会重跑（`the same attempt never starts a second task`）。
- **→ 05 / 01（P2-01-REQ-02）**：`module-capability` 仍不在 `IMPLEMENTED_RUNNER_KINDS` 中（`nodeType.ts:1263`）。在 05 证明两条注册路径「缺执行器必须失败、不得走模型 fallback」之前，生产派发仍是关的。本任务不碰该门禁。
- **→ 02**：执行器的默认等待上限 `45_000ms` 是**按宿主 30s 任务超时设计的**（必须更大，否则执行器抢先报错、失败原因就是错的）。若宿主超时改动，请知会，我同步调整默认值。
- **→ 06**：4 个突变开关可直接用作安全/回归的红灯来源，用法见上表；它们只改临时 bundle，不动生产源码。

## 未实现 / 未验证

- **没有任何生产接线。** 执行器没有被任何注册表注册，新节点类型不存在，工作流里现在**跑不到**这一步——那是 05 的范围。
- `IMPLEMENTED_RUNNER_KINDS` 未放开，故 `isNodeRunnable()` 对该 kind 仍为 false。
- **没有端到端结论。** 本报告的绿灯只覆盖「执行器 ↔ 宿主」这一段。
- 未跑 `packages/contracts` 的类型检查（01 的范围）、未跑全量 smoke（07 统一跑）、未做 Electron 实机验收。
- 未验证多节点并发触及宿主 4 个并发名额时的排队表现（宿主抛 `Too many active tasks`，执行器会映射成 `failed`；这是否是期望的产品行为需 05/06/07 定）。

## Git

- **未提交、未推送、未 `git add`。** 本轮新增 3 个文件、修改 1 个（均为本任务所有）。
- 未运行 reset / checkout / stash / 全库格式化。
- 未覆盖、删除或回滚其他对话的成果；工作树中他人的未提交修改原样保留。
