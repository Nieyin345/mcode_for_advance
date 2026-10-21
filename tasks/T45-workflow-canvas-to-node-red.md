# T45｜工作流 UI：删掉手写画布，用 Node-RED 原厂编辑器

| 项目 | 值 |
|---|---|
| 编号 | T45 |
| 类型 | **ARC-006 主线**（用户：手写的不要了，改一改 node red 的就行，风格要调整） |
| 优先级 | **高** |
| 建议并发 | 改 `settings/workflows/` + `workflowEngines/`；**先完成 T42**（判据 5 依赖它） |
| 预计规模 | 中 |

---

## 用户决策（2026-10-21）

> 「之前手写的不要了，改一改node red的就行，node red 的风格可能不对，需要调整」

即：
1. **删除** `WorkflowCanvas.tsx`（685 行手写画布）
2. **用** Node-RED 原厂编辑器
3. **改它的风格**让它与 Mcode 一致

---

## 关键发现：Node-RED 官方就支持定制主题

`node-red/scripts/build-custom-theme.js` 的头部注释就是官方说明：

```
1. Create a copy of packages/node_modules/@node-red/editor-client/src/sass/colors.scss
   and change the values to the desired colours.
2. Run this script, providing the path to the custom file using the --in option
3. Save the output of the script to a file - either redirect its output,
   or use the --out option.
4. Edit your settings file to set the theme:
      editorTheme: {
          page: {
              css: '/path/to/file/generated/by/this/script'
          }
      }
5. Restart Node-RED
```

**这意味着：改风格不需要动上游任何一行。** 只要：
1. 复制 `colors.scss` → 改成 Mcode 的 token
2. 跑 `build-custom-theme.js --in <改过的> --out <产物>`
3. 在 `registry.ts` 的 `BOOTSTRAP` 里给 `RED.init()` 加 `editorTheme.page.css`

**工作量从「改 41 个 SCSS 文件」降到「改一个变量文件 + 跑一次构建 + 加一行配置」。**

---

## 现状

| 项 | 位置 | 状态 |
|---|---|---|
| 手写画布 | `renderer/components/settings/workflows/WorkflowCanvas.tsx` | **685 行，要删** |
| 原厂编辑器 | `editor-client` 的 `red.min.js` | 已作为 `WebContentsView` 嵌进 Pane（`EngineRuntimePanel.tsx:232`） |
| 迁移器 | `workflowEngines/flowMigration.ts` | 1,473 行，已有双向 API |
| 主题机制 | `node-red/scripts/build-custom-theme.js` | **官方支持，未使用** |
| 运行看板 | `renderer/components/chat/WorkflowBoardPanel.tsx` | 657 行，**保留**（是观察不是编辑） |

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `node-red/scripts/build-custom-theme.js` **全文**（约 100 行）—— 它怎么合并 SCSS。
3. `node-red/packages/node_modules/@node-red/editor-client/src/sass/colors.scss`
   **全文**（325 行里的颜色段）—— 这是要复制的模板。
4. `node-red/packages/node_modules/@node-red/editor-client/src/sass/sizes.scss`
   —— 尺寸变量。
5. `apps/desktop/src/main/workflowEngines/registry.ts:85-260` 的 `BOOTSTRAP` ——
   要加 `editorTheme`。
6. `apps/desktop/src/renderer/styles.css` 的 token 段 —— Mcode 自己的颜色。
7. `apps/desktop/src/renderer/components/settings/workflows/WorkflowCanvas.tsx`
   —— 删之前看一眼它做了什么（见第 2 步）。
8. `apps/desktop/src/main/workflowEngines/flowMigration.ts` 的三个导出
   （`migrateWorkflowDoc` / `flowToWorkflowDoc` / `roundTripMismatchPaths`）。

---

## 执行内容

### 第 1 步：量清楚迁移能力（**删之前必须先做**）

调 `roundTripMismatchPaths(migrateWorkflowDoc(doc), doc)` 对**现有所有工作流**跑一遍。

产出一份统计：
- 多少张图能完整往返？
- 不能的，丢的是什么（参数？条件？端口？）

**如果发现大量丢数据，先停下来在回写区报告，不要继续删画布。**
这时候正确做法是先把迁移器补强（另开卡），不是硬删。

### 第 2 步：把绘制入口切到原厂编辑器

- `WorkflowLibraryView.tsx:1169` 现在渲染 `<WorkflowCanvas>`，改成打开编辑器。
- 编辑器已经在 Pane 里了（`EngineRuntimePanel` 那条路），这里只是换入口。
- **保留 `WorkflowCanvas` 的只读预览能力**？—— 不需要。用户说不要了。
  如果会话流里需要小图，用 `WorkflowBoardPanel`（它有自己的渲染）。

### 第 3 步：删除 `WorkflowCanvas.tsx`

删之前检查所有引用：

```
grep -rn "WorkflowCanvas\|workflowLayout\|workflowEdit" apps/desktop/src/
```

**已实测的引用关系（2026-10-21）**：

| 文件 | 被谁用 | 能不能删 |
|---|---|---|
| `WorkflowCanvas.tsx`（685） | 只有 `WorkflowLibraryView.tsx:80` | ✅ **删** |
| `workflowLayout.ts`（304） | `WorkflowCanvas`、`WorkflowNodeCard`（`NODE_H`/`NODE_W`）、`workflowEdgeLabels`（`Box` 类型） | ❌ **不能整体删** —— 至少 `NODE_H`/`NODE_W`/`Box` 还有人用 |
| `workflowEdit.ts`（453） | `WorkflowCanvas`、**`NodeInspector.tsx:71`**、**`NodeInspectorParts.tsx:53`**（都用 `wouldCycle`）、`WorkflowLibraryView.tsx:77` | ❌ **不能删** —— `wouldCycle` 有其它调用方 |

**所以本卡只删 `WorkflowCanvas.tsx`。** 另两个文件里会留下无人使用的函数，
**不要在本卡里清理** —— 先让删除稳定一版，另开卡评估（`workflowLayout` 的
布局计算、`workflowEdit` 的编辑操作，在编辑器换成 Node-RED 后大概率都成了死代码）。

### 第 4 步：主题（**已拆成 T47，本卡不做**）

主题定制有独立的工作量（238 个变量映射、深浅两份、构建产物入库、BOOTSTRAP 改动），
已拆成 **T47**。本卡的判据 4/5（视觉一致）由 T47 承担。

本卡只负责**删手写画布 + 切入口**。

---

## 边界（不要碰）

- **不改 `node-red/` 上游源码**。主题是外挂的 CSS，不是改 SCSS 源。
- 不改 `WorkflowBoardPanel`（运行看板，保留）。
- 不改 `orchestration/` 的执行逻辑。
- 不改 `document/`（T28/T29）。
- 不删 `flowMigration.ts`（它是迁移的基础）。

---

## 验收判据

1. 工作流列表点「编辑」→ 打开 Node-RED 原厂编辑器，能拖节点、连线、保存。
2. 保存后回到列表，内容与编辑器一致（往返一次不丢数据）。
3. `WorkflowCanvas.tsx` 已删除，`grep -rn "WorkflowCanvas" apps/desktop/src/` 无结果。
   `workflowLayout.ts` / `workflowEdit.ts` **保留**（还有其它调用方）。
4. 编辑器使用 Mcode 主题：背景、文字、边线、语义色与 Mcode 其它面板一致
   （有截图或 CSS 变量断言）。
5. 深色模式正确。
6. 现有工作流相关套件全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉 `editorTheme.page.css` → 判据 4 红（回到 Node-RED 默认色）。

---

## 回写区要回答

- 现有工作流里有多少张能完整往返？丢数据的有多少？
- `colors.scss` 有多少个变量对不上 Mcode 的 token？取了什么近似值？
- 主题切换要不要重启引擎？如果必须，用户切换深浅色时怎么办？
- `workflowLayout.ts` / `workflowEdit.ts` 还有没有别人在用？
- 删完 `WorkflowCanvas` 后，仓库少了多少行？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜T45 执行结果

- **迁移前核对**：对仓库可见的 5 份内置、7 份可选预设、1 份示例工作流逐一运行 `roundTripMismatchPaths(doc, flowToWorkflowDoc(migrateWorkflowDoc(doc).flow))`：**13/13 已知字段完整往返，0 份丢失**。此项不是用户数据库全量审计；未提供 `types` 时节点会列作 `unmapped`，不等于原生部署已具备相同执行语义。
- **入口改动**：库详情改为 `<WorkflowNativeEditorEntry>`，按钮切到已有 `EngineRuntimePanel` / 宿主认证的 Node-RED 原厂编辑器；自动化共用此引擎入口。界面明确提示编辑器使用独立 `flows.json`，**没有把当前库中选中的文档自动装入，也没有原厂部署结果回写到 workflow 库的通道**。未假称此链路已经闭环。
- **移除规模**：删除 `WorkflowCanvas.tsx` **685 行**；`apps/desktop/src/` 中 `WorkflowCanvas` 命中为 0。`workflowLayout.ts` 仍由 `WorkflowNodeCard`、`workflowEdgeLabels`、`workflowEdit` 使用；`workflowEdit.ts` 仍由 `WorkflowLibraryView`、`NodeInspector` / `NodeInspectorParts` 使用，因此两文件按要求保留。
- **主题分工**：主题源码和发布资产来自独立 T47，本卡未触碰 `node-red/`、`registry.ts` 或样式资产。Node-RED 上游颜色快照 238 个 SCSS 变量；T47 测试锁定 **19 项关键色彩/字号映射**（其余按上游保留）。`mcode-theme-auto.css` 用 `prefers-color-scheme: dark` 即时切换，不必为明暗切换重启运行引擎；现有 `node-red-theme-smoke`、`theme-ipc-smoke` 均绿。单独把 `editorTheme.page.css` 注入从测试用 registry 文本移除后，**主题冒烟按预期变红**；真实源码未被改变。
- **测试**：`workflow-view-smoke`、`flow-migration-smoke`、`flow-editor-authority-smoke`、`settings-form-lifecycle-smoke`、`workflow-engine-bridge-smoke`、`workflow-engine-runtime-smoke`、`node-red-theme-smoke`、`theme-ipc-smoke` 通过。把入口导航改回 library 时 `workflow-view-smoke` 由 763/763 变为 762/763（红）；还原后全绿。
- **未闭环验收**：①原厂入口可打开但**不能保证选中库文档在原厂编辑器内拖拽/保存**；②**原厂保存回写工作流库缺失**；⑥旧 `workflow-ui-smoke` 浏览器夹具仍以已删除的自绘画布 DOM 为前提而失败；相关 `settings-panels-electron-smoke` 在并行修改的 ModuleViewDock `contributionsOf(...).flatMap` 抛错；⑦ `packages/contracts` tsc 通过、`apps/desktop` tsc 因并行扩展模块 `packages/contracts/src/modules.ts` 的 `extensions` 等类型报错未全绿。涉及工作流 UI/桥接新增源码的类型错误已清理。真实运行中的 Node-RED 拖拽/保存效果没有虚报成已验收。
