# T58｜T45 删画布后的三处遗留：两个套件红 + 一条功能缺失

| 项目 | 值 |
|---|---|
| 编号 | T58 |
| 类型 | **回归修复 + 功能补齐**（T45 留下的） |
| 优先级 | **最高** —— 工作流 UI 现在是半残状态 |
| 建议并发 | 改 `renderer/components/settings/workflows/` + `scripts/`；**与 T57 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **T45 已完成**：`351e4d9b`，删了 `WorkflowCanvas.tsx`（685 行）
- **T50 已完成**：`7eb548c9`
- **无其它前置**

---

## 背景：T45 删了画布，但新入口没接完

T45 的回写区自己列了三条未闭环：

> ① 原厂入口可打开但**不能保证选中库文档在原厂编辑器内拖拽/保存**
> ② **原厂保存回写工作流库缺失**
> ⑥ 旧 `workflow-ui-smoke` 浏览器夹具仍以已删除的自绘画布 DOM 为前提而失败

**但 T45 漏报了一条**：`module-phase2-e2e-smoke` 也依赖那个画布。

---

## 三条要做的事

### A. `workflow-ui-smoke`（T45 自己承认）

浏览器夹具以已删除的 `WorkflowCanvas` DOM 为前提。

**要做的**：夹具改成针对**新入口**（`WorkflowNativeEditorEntry`）。
如果新入口没有可断言的 DOM（它就是个按钮 + 打开原厂编辑器），
那这个套件的价值就变了 —— **要么改断言目标，要么这个套件该退场**。

**判断依据**：`workflow-view-smoke` 在 T45 里是 763/763 全绿的，
说明已经有一套覆盖了工作流 UI。那 `workflow-ui-smoke` 还剩什么独有的？

### B. `module-phase2-e2e-smoke`（T45 漏报）

失败点：

```ts
// native-main.ts:54
await wait("document.querySelector('[role=button][title=\"File inspection\"]')");
```

它在**工作流画布的节点卡片**里找这个按钮。测试自己造了一张图：

```ts
{ id: "inspect", type: "mcode.module-capability", title: "File inspection", ... }
```

新入口打开的是 **Node-RED 原厂编辑器**，节点是 SVG/canvas 画的，
**不存在 `[role=button][title=...]` 这种 DOM**。

**要做的**：这个 e2e 的「原生窗口 + 真实调度 + 工作流 UI」这一段，
在新架构下没法用原来的选择器验。

两条路：

- **A1**：改成验 **Node-RED 里的节点**（查 `GET /flows` 或编辑器 DOM 的 `data-testid`）
- **A2**：如果这段的工作流 UI 验证意义已经不大（因为编辑器换成了原厂的），
  **把这段从 e2e 里摘掉**，在回写区说明它被哪个套件取代

**建议 A2**：`module-phase2-e2e-smoke` 的核心价值是「宿主 + 真实调度 + 隔离」，
不是「工作流画布长什么样」。那个画布已经被删了，验它没有意义。

**但摘掉之前必须确认**：那段里有没有别的断言（不依赖画布的）会被一起删掉。
有就保留。

### C. 保存回写工作流库缺失（**功能缺失，不是测试问题**）

T45 说的：

> ② 原厂保存回写工作流库缺失

意思是：用户在 Node-RED 编辑器里改了工作流、点了「保存」，
**Mcode 自己的工作流库（`workflow` 表）不会更新**。

**这是功能缺口。** 用户看到的是：编辑器里改好了，回到库列表还是旧的。

**要做的**：Node-RED 保存（`POST /flows`）成功后，把 flow 反向转回
`WorkflowDoc`，写回 `workflow` 表。

- 已有的 `flowToWorkflowDoc(flow)` 就是干这个的
- 已有的 `POST /flows` 握手（`registry.ts` 的 `BOOTSTRAP`）里有 `mcode-deploy-final`
  回包 —— 在那里接
- **注意**：T45 说的是「原厂保存」，要走的是**用户在编辑器里点 deploy** 那条路

**判据**：在编辑器里改一个节点标题 → 保存 → 回到 Mcode 工作流列表 → 看到新标题。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `tasks/T45-workflow-canvas-to-node-red.md` 的**回写区全文**。
3. `apps/desktop/src/renderer/components/settings/workflows/WorkflowNativeEditorEntry.tsx`
   —— T45 新建的入口（15 行）。
4. `apps/desktop/scripts/module-phase2-e2e-smoke/native-main.ts:54-90` —— 要摘的那段。
5. `apps/desktop/scripts/workflow-ui-smoke/` —— 旧夹具。
6. `apps/desktop/src/main/workflowEngines/registry.ts` 的 `BOOTSTRAP` ——
   `mcode-deploy-final` 握手的位置。
7. `apps/desktop/src/main/workflowEngines/flowMigration.ts` 的 `flowToWorkflowDoc`。

---

## 边界（不要碰）

- **不改 Node-RED 上游**。
- 不改 T50 的贡献点 schema。
- 不改 T57 的 `slidesExecutor`。
- 不改 `packages/contracts/`。

---

## 验收判据

1. `workflow-ui-smoke` 要么全绿，要么**明确退场**并在回写区说明被谁取代。
2. `module-phase2-e2e-smoke` 全绿（摘掉画布那段后，其余断言仍然有效）。
3. **在 Node-RED 编辑器里改一个节点标题 → 保存 → Mcode 工作流列表能看到新标题**（有断言）。
4. `workflow-view-smoke` / `flow-migration-smoke` / `workflow-engine-runtime-smoke` 不回归。
5. 双包 tsc 干净。
6. **变异验证**：撤掉保存回写 → 判据 3 红。

---

## 回写区要回答

- `workflow-ui-smoke` 和 `workflow-view-smoke` 的覆盖重叠多少？前者还有什么独有的？
- `module-phase2-e2e-smoke` 那段里，除画布外的断言有哪些？摘掉安全吗？
- 保存回写的触发点是 `mcode-deploy-final` 还是别的地方？
- `flowToWorkflowDoc` 能把用户在原厂编辑器里做的改动完整转回来吗？
- 「不能保证选中库文档在原厂编辑器内拖拽/保存」（T45 的①）本卡有没有解决？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->


### 2026-10-21 T58 执行回写

- **A / 旧画布冒烟**：`workflow-ui-smoke` 改验原厂入口、可访问性、跳转、显式保存/草稿、英文本地化/自动化入口和原生部署广播刷新（含不覆盖脏草稿），**20/20、0 个夹具错误**。与 `workflow-view-smoke` 的重叠是原厂入口/列表基本行为；后者主要是无头组件/状态/逻辑断言，前者独有真 Chromium 渲染、Tab/ARIA、导航切换、跨页草稿及广播后渲染，故保留，不退役。
- **B / 原生 Electron E2E**：仅摘掉依赖已删除画布 DOM 的「选节点卡 → 检查器改贡献点/路径」操作；初始化即采用受校验的合法模块贡献点参数（`inspect` + `{{trigger.kind}}.txt`），并以原厂编辑器入口和**真实 IPC/SQLite** 读回替代。保留恶意保存/导入拒绝、SQLite 重启持久化、自动化运行/重复运行、信任审核/审批/版本、宿主文件哈希/下游路径、权限授予撤销、菜单、取消和零模型调用等非画布断言。复跑 `module-phase2-e2e-smoke` **10/10 composite**（独立 Electron 子进程 create/reopen 的完整凭据、真实调度链均通过），不是以删除断言冒充变绿。
- **C / 保存回写**：在 `OwnedNodeRedRuntime` 已有认证 `mcode-deploy-prepare` / `mcode-deploy-final success=true` 路径，部署前保留候选原生 nodes、成功后调用 `nativeLibrarySync.ts`；按 tab 的 `x-mcode.docId` + `z` 还原为 `WorkflowDoc`，仅更新已存在的 Mcode 文档；复用 `saveWorkflow`（校验、CAS、重新要求审核）持久化并广播 `node-red:deploy:<id>`。失败、结果不明及原厂独立 tab 均不写库；重载当前未脏的库文档，防止回到库仍看到旧标题，脏草稿不被广播覆盖。覆盖：`executor-gate-d-smoke` **85/85**（真正 deploy prepare/final 路径，模拟原厂改名后新标题进入库、广播、失败不写）；`module-phase2-e2e-smoke` 的新增断言在**隔离真实 SQLite** 上验证反向映射、落库、公开 workflow.get、外部改动审核闸门/明确批准以及新 Electron 进程重启后的标题。
- **反向映射边界**：`flowToWorkflowDoc` 对迁移器生成且保留 `x-mcode` 的节点，能从原生 `name` 读回标题，基于真实 `wires` 还原连线并保留对应侧车元数据；不承诺无侧车的任意第三方原生节点/全局配置或改变底层节点 type 后的全部语义可无损反向迁移。同步错误显式日志，不谎报已存入库。
- **T45 的①**：**未解决**。本卡解决已有 Mcode 标记/已在原厂内的 flow 经 Deploy 回写；点击工作流库中某份文档目前仅跳到原厂编辑器页，**没有把选中的该份文档自动装入 Node-RED 画布**。本任务没有扩成独立导入/双向自动加载方案。
- **回归命令**：`node apps/desktop/scripts/run-smokes.mjs workflow-ui-smoke workflow-view-smoke executor-gate-d-smoke flow-migration-smoke workflow-engine-runtime-smoke` → 5/5 PASS；`node apps/desktop/scripts/run-smokes.mjs module-phase2-e2e-smoke` → PASS。日志 `apps/desktop/.tmp/smoke-runs/1792574752232-38588-TiunoC/` 和 `1792574586598-20320-kaynQi/`。
- **变异（验收 6）**：临时把 `registry.ts` 内的 `this.syncLibrary(pending.flows)` 替换为一个成功但不回写的 Promise，复跑 `executor-gate-d-smoke` → **81/85、退出 1**，其中「Native editor title saves back into Mcode workflow library」正确变红（旧标题未变；广播和调用计数也变红）。日志 `apps/desktop/.tmp/smoke-runs/1792574787053-43440-ZxbOQG/`。已恢复原代码并确认正例回归通过。
- **双包 tsc（验收 5）**：`node node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json` **PASS**；`node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json` **FAIL**，仅两条：`src/main/document/genofficeNativeVendor.ts:49,55` 向未声明 `mcodePaneGuard` 的 GenOffice 参数类型传值（并行 T52/ARC-007 的未完成工作区修改，非本卡）。按「不扩范围、不动别的任务代码」不修此处。**验收 5 未达成**。

### 2026-10-21 执行复核（当前工作树，未宣告整卡完成）

- 基线 HEAD `0a2065962098106425e5ef0f8b4b5c360900a10e`；检查时 T58 关联的 `workflow-ui-smoke`、`module-phase2-e2e-smoke`、`registry.ts`、`flowMigration.ts`、工作流库及新建 `nativeLibrarySync.ts` 已有未提交修改。本轮未覆盖这些并行修改。
- `node apps/desktop/scripts/run-smokes.mjs workflow-ui-smoke`：PASS（1/1）。
- `node apps/desktop/scripts/run-smokes.mjs module-phase2-e2e-smoke workflow-view-smoke flow-migration-smoke workflow-engine-runtime-smoke`：PASS（4/4）。
- `pnpm --filter @mcode/contracts typecheck && pnpm --filter @mcode/desktop typecheck`：PASS。
- 静态链路：`OwnedNodeRedRuntime` 接 `mcode-deploy-final` 成功后调用 `syncDeployedNativeWorkflows`，其通过 `flowToWorkflowDoc` 与 `saveWorkflow(..., untrustedOrigin: 'import')` 回写。`module-phase2-e2e-smoke` 含标题改动→同步→SQLite/IPC 展示→重启后保留的 E1 断言；旧画布断言已替换。`workflow-ui-smoke` 保留入口跳转、选中态、草稿/保存/通知刷新独有 UI 断言，旧画布交互由 `workflow-view-smoke` 等现存测试覆盖。
- **仍未达成完整验收**：判据 6 尚无撤掉保存回写的实际红例；判据 3 的真实 Node-RED 编辑器点击 Deploy→回写全链路尚无 U1/完整 E2E 证据（当前只证实同步函数及宿主界面回读）。T45 的①（选中库文档在原厂编辑器内可拖拽保存）也尚未获得 U1 保证；`flowToWorkflowDoc` 对任意上游原生节点的完整无损回转不可承诺，未知/不可映射语义仍应走迁移报告。
