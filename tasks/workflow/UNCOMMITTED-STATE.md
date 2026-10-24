# 工作流主线：未提交状态（2026-10-24 23:00）

> **这张文件存在的原因**：工作流主线今天交付了 15 张卡（W0/W1/W2/W3/W4/W5/W15/W17/W19/W21/W22），
> 全部改动**未提交**，而工作区同时有另外三条主线的在途改动。

## 一、为什么没提交

**`tsc` 门禁当前是红的，而红的原因不在工作流主线。**

```
$ npx tsc --noEmit -p apps/desktop/tsconfig.json
EXIT=2，19 个报错文件
```

**按文件归类，全部是 OnlyOffice / Office 主线：**

| 文件 | 错误数 |
|---|---|
| `src/preload/index.ts` | 21 |
| `src/main/onlyoffice/localInstall.ts` | 21 |
| `src/renderer/components/ide/OnlyOfficeEditorPane.tsx` | 12 |
| `src/main/ipc/onlyoffice.ts` | 11 |
| `src/main/onlyoffice/OnlyOfficeBridge.ts` | 10 |
| 其余 14 个 Office 相关文件 | 共 23 |

**`src/main/workflowEngines/` 与 `settings/workflows/` 零报错。**

根因：`packages/contracts/src/ipc/onlyoffice.ts` 现在是 `D`（已删除，**-244 行**）状态，
而 `webApi.ts` / `preload/index.ts` 仍在引用 `OnlyOfficeOpenResult` —— **Office 主线在途的中间态**。

**我核过「我的改动有没有碰这些文件」**：

```bash
$ git status --porcelain | grep -iE "onlyoffice|preload"
 D packages/contracts/src/ipc/onlyoffice.ts        ← 唯一命中，是删除，不是我做的
```

**工作流主线的改动一个都没碰 `onlyoffice*` / `preload`。** 所以这 19 个报错与这条线无关。

## 二、工作流主线的改动清单（可独立提交）

### 产品代码

```
M  src/main/orchestration/executionEngine.ts                    ← W4
M  src/main/workflowEngines/flowMigration.ts                    ← W17
M  src/main/workflowEngines/mcodeNodePack.ts                    ← W17
M  src/main/workflowEngines/mcodeNodeTypes.ts                   ← W17
M  src/main/workflowEngines/nodePackBundle.generated.ts         ← W17（重新生成）
M  src/main/workflowEngines/nodePackChildRuntime.ts             ← W17
M  src/main/workflowEngines/nodePackHost.ts                     ← W17
M  src/main/workflowEngines/nodePackManifest.ts                 ← W17（+ locale）
M  src/main/workflowEngines/nodePackProductionPorts.ts          ← W21
M  src/main/workflowEngines/registry.ts                         ← W17
M  src/renderer/components/settings/workflows/EngineRuntimePanel.tsx   ← W15
M  src/renderer/components/settings/workflows/NodeInspector.tsx        ← W3
M  src/renderer/components/settings/workflows/WorkflowLibraryView.tsx  ← W3
M  src/renderer/components/settings/workflows/WorkflowsPanel.tsx       ← W15
M  src/renderer/lib/i18n/zh/settings.ts                         ← W3 + W15
M  src/renderer/lib/i18n/en/settings.ts                         ← W3 + W15
?? src/main/workflowEngines/conditionHost.ts                    ← W17
?? src/main/workflowEngines/conditionHostPorts.ts               ← W17
?? packages/contracts/src/conditionBridge.ts                    ← W17（新建，不碰别人的删除）
```

### 套件

```
M  scripts/t42-node-pack-smoke/main.ts                ← W17（改成按类型表推导，未放宽）
M  scripts/x-mcode-roundtrip-smoke/main.ts            ← W17（同上）
M  scripts/t8-node-red-u1/README.md                   ← W22 + 总控
M  scripts/t8-node-red-u1/run.mjs                     ← W22
M  scripts/t8-node-red-u1/editor-flow.ts              ← W5
M  scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts  ← W5
?? scripts/t8-node-red-u1/child-completion-probe.mjs  ← W22
?? scripts/t8-node-red-u1/wrapper-verdict.mjs         ← W22
M  scripts/workflow-ui-smoke/verify.mjs               ← W15
M  scripts/workflow-view-smoke/main.ts                ← 总控（修过期断言）
?? scripts/workflow-node-select-smoke/                ← W3
?? scripts/workflow-engine-view-owner-smoke/          ← W15
?? scripts/mcode-node-pack-ports-smoke/               ← W19
?? scripts/mcode-agent-capability-smoke/              ← W21
?? scripts/mcode-condition-bridge-smoke/              ← W17
```

### 卡片

```
M  tasks/workflow/README.md
M  tasks/workflow/{W3,W4,W5,W6}-*.md          ← 回写
?? tasks/workflow/{W7,W8,W12,W15,W16,W17,W18,W19,W20,W21,W22,W23,W24,W25}-*.md
?? tasks/workflow/HANDOFF-module-phase2-red-assertion.md
```

## 三、提交时要注意的三件事

1. **`nodePackBundle.generated.ts` 现在吸收了两份东西**：别人 18:28 的路径前缀差异
   （`// src/main/` vs `// apps/desktop/src/main/`）+ W17 的 63 行功能改动。
   **我逐行比对过，功能部分只有 W17 的**。提交时这是正常的一行变更。
2. **`packages/contracts/src/conditionBridge.ts` 是新建文件**，与 `onlyoffice.ts` 的删除无关。
   但**如果整包提交 `packages/contracts/`，会卷进别人的删除** —— 必须按路径点名。
3. **`journeys/node-red-canvas-load-edit-deploy-reopen.ts` 与 `editor-flow.ts` 是 W5 的改动**，
   **W23 马上要改同样的两个文件** —— 等它交付后一起提交更安全。

## 四、我的建议

**等两件事同时满足再提交：**
1. Office 主线的 `tsc` 转绿（那是它们的事，不是我们的）；
2. W23 交付（它改 `journeys/` 与 `editor-flow.ts`）。

**在那之前，改动留在工作区是对的** —— 提交一个 `tsc` 红的树，会让下一个人
以为「是工作流主线弄红的」（CLAUDE.md 第二十四条：报告前先问「提交了吗、编译得过吗」）。

---

# 提交记录（2026-10-24 23:20）

**提交：`032a6882`** — `feat(workflow): the canvas is the default, and the migration stops lying`
**73 个文件，10399 行新增 / 158 行删除。**

## 提交内容

| 类别 | 文件数 |
|---|---|
| 产品代码（main） | 13（含 2 个新建：`conditionHost.ts` / `conditionHostPorts.ts`） |
| 产品代码（renderer） | 6 |
| 契约 | 1（新建 `conditionBridge.ts`） |
| 套件 | 33（含 5 个新建套件目录） |
| 卡片 | 21 |

## 提交后核对（CLAUDE.md 要求）

```bash
$ git show --name-only --format="" HEAD | grep -iE "onlyoffice|preload|aoci|appControl|settingsTransfer|pnpm-lock|document-view-host|maint-m35|release-readiness|o2-conflict|o6-reshell"
✓ 一个都没有
```

**提交后工作区剩下的 18 个已跟踪改动全部是别人的**（Office / 扩展 / aoci 线）。

## 提交后跑的套件

| 套件 | 结果 |
|---|---|
| `workflow-node-select-smoke`（W3 新建） | **EXIT=0** |
| `workflow-engine-view-owner-smoke`（W15 新建） | **EXIT=0** |
| `mcode-node-pack-ports-smoke`（W19 新建） | **EXIT=0** |
| `mcode-agent-capability-smoke`（W21 新建） | **EXIT=0** |
| `mcode-condition-bridge-smoke`（W17 新建） | **EXIT=0** |
| `workflow-view-smoke`（我改过） | **EXIT=0** |
| `t42-node-pack-smoke`（W17 改过） | **EXIT=0** |
| `x-mcode-roundtrip-smoke`（W17 改过） | **EXIT=0** |
| `workflow-ui-smoke`（W15 改过） | **EXIT=1 ← 不是我们的，见下** |

### `workflow-ui-smoke` 的红：**既有问题，与本次提交无关**

```
Error: Build failed with 2 errors:
src/renderer/components/ide/FileEditor.tsx:13:9: ERROR: No matching export in
"../../packages/contracts/src/ipc.ts" for import "isOnlyOfficeSupportedPath"
```

**我核过三件事：**

1. `FileEditor.tsx` **不是我改的** —— `git status` 对它零输出，最后改动是 `426c326d`；
2. `packages/contracts/src/ipc.ts` **没有未提交改动**（已在 HEAD）；
3. **在我提交之前的 `d31f065e` 上，`grep isOnlyOfficeSupportedPath` 就是 0**。

**所以这个红在我动手之前就存在。** 根因与 tsc 那 19 个报错同源 —— Office 主线
删了 `packages/contracts/src/ipc/onlyoffice.ts`（-244 行）并改了 `ipc.ts` 的导出，
但 `FileEditor.tsx` 仍在导入。

**这属于 Office 主线，我没有修它，也不该修。**
