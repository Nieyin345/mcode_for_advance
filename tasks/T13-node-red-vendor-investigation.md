# T13｜Node-RED 源码集成调查（按 GenOffice 模式）

| 项目 | 值 |
|---|---|
| 编号 | T13 |
| 类型 | 调查卡（**不写产品代码**，产出结论与方案） |
| 优先级 | 高 —— 它决定能不能删掉 685 行手写画布 |
| 建议并发 | 纯只读 + 建 vendor 目录，可与其它任务并行 |
| 预计规模 | 中 |

---

## 背景

用户明确要求：**Node-RED 按 GenOffice 的模式集成源码，不是 npm 下载包。**

现状（已核实）：

```ts
// apps/desktop/src/main/workflowEngines/runtimeSupervisor.ts:737
const packageJson = join(options.dataDir, "node_modules", options.installPackage, "package.json");
if (!existsSync(packageJson)) throw new Error(`引擎 ${options.engineId} 未安装`);
```

即：要求 `<dataRoot>/workflow-engines/node-red/node_modules/node-red/` 里有一份从 npm 装的包。
**改不了它**，所以我们另写了 685 行的 `WorkflowCanvas.tsx` —— 两套画布并存。

用户拍板的路线是：像 `genoffice/` 一样把上游源码 vendor 进来，在上面二开。

---

## GenOffice 的模式（照抄这个）

参考 `docs/planning/arc007-genoffice-native-integration-map.md` 与仓库现状：

1. **独立 vendor Git**：`genoffice/` 是一个嵌套 Git 仓库，基线固定 commit `73ba918`，
   分支 `mcode/integration`。
2. **`.gitignore` 排除**：`/genoffice/` 不进主仓（Mcode 主仓的 HEAD 不等于 vendor 提交）。
3. **改动以少量带注释的提交落在上游源码上**，可 `rebase` 升级。
4. **补丁同时存主仓**：`patches/genoffice/0001-*.patch`，便于 review 与重放。
5. **只改边界文件**：GenOffice 那轮只改了 `apps/docs/src/preload/mcode-view.ts` 与
   `apps/docs/src/main/mcode-ipc.ts`，**不动业务内核**。

T13 要做的就是把这一套套到 Node-RED 上，并且**先查清楚可行性与代价**。

---

## 开工前必读

1. `docs/planning/arc007-genoffice-native-integration-map.md` **全文** —— 这是模板。
2. `apps/desktop/src/main/workflowEngines/runtimeSupervisor.ts` 的
   `createEngineLaunchSpec`（约 730–800 行）—— 要改的就是这里。
3. `apps/desktop/src/main/workflowEngines/registry.ts` 的 `BOOTSTRAP` 常量
   （约 83–250 行）—— `require("node-red")` 的解析点。
4. `apps/desktop/src/main/workflowEngines/engineNodeReadiness.ts` ——
   安装前校验，会受 vendor 化影响。
5. `apps/desktop/src/main/workflowEngines/mcodeNodePack.ts` —— Mcode 自己的节点包，
   它会需要 vendor 里的 API。

---

## 执行内容（**只调查与产出方案，不改产品代码**）

### 1. 取证：Node-RED 的构建链

克隆 Node-RED 到一个**临时目录**（不要直接放进仓库），回答：

- 上游仓库地址与最新稳定 tag；**固定一个 commit**（不要用 `main`）。
- 许可证（预期 Apache-2.0，要核实），以及 `ee/` 之类企业条款目录是否存在。
- **编辑器怎么构建**：`packages/node_modules/@node-red/editor-client` 需要
  webpack 构建吗？一条命令还是多条？大概耗时？
- **运行时的入口**：`require("node-red")` 解析到哪个文件？它依赖哪些
  上游 workspace 包？这些包在源码树里是 symlink 还是真目录？
- **Node 版本要求**（`engines.node`），与我们内嵌的 Electron Node 是否兼容。
- 仓库体积（`du -sh`），以及构建产物体积。

把结论写进一个表，**每条都带证据**（文件路径 / 命令输出），不要写"应该"。

### 2. 改动面：vendor 化要动我们哪几处

逐个列出并评估：

| 位置 | 现在 | vendor 后要变成 | 风险 |
|---|---|---|---|
| `runtimeSupervisor.createEngineLaunchSpec` | 查 `dataDir/node_modules/node-red` | 查 vendor 目录 | 打包时路径要跟着变 |
| `registry.BOOTSTRAP` 的 `require("node-red")` | 由 Node 从 `dataDir` 解析 | 要能解析到 vendor | Electron-as-Node 的 `NODE_PATH` 怎么设 |
| `engineNodeReadiness` | 校验已安装包 | 校验 vendor 快照 | 升级时怎么判断 |
| 打包（`electron-builder.yml` / `electron.vite.config.ts`） | 运行时按需下载 | vendor 要不要一起打包 | 体积影响 |
| `.gitignore` | 无 | 加 `/node-red/` | — |

**每一条都要写清「改几个文件、几行、会不会影响现有 smoke」**。

### 3. 二开边界：我们要改 Node-RED 的什么

用户的目标是「用它现成的编辑器画布，不做第二套」。所以要查：

- 编辑器的**节点面板（palette）**怎么注册自定义节点？我们要把 Mcode 的
  节点类型（`BUILTIN_NODE_TYPES`）加进去。
- 编辑器的**画布**能不能加自定义装饰（审批标记、运行状态、执行 owner）？
  找它的 `RED.view` / `RED.nodes` 扩展点。
- 有没有**多租户/嵌入式**的官方支持（`httpAdminRoot` 已用，还有别的吗）。
- 它的 **Admin API** 能不能被 Mcode 宿主加钩子（部署前审批已有一条私有 IPC，
  看能不能复用而不是再开一条）。

**产出**：一张「Mcode 能力 ↔ Node-RED 扩展点」对照表。找不到扩展点的能力，
明确写「做不到，需要 fork 改源码」并给出改哪个文件。

### 4. 升级策略

- vendor 的基线 commit 怎么选（tag 还是 commit）。
- `mcode/integration` 分支怎么维护（rebase 还是 merge）。
- 上游升级时，我们的补丁怎么重放（`patches/node-red/*.patch`）。
- **失败回退**：vendor 目录缺失时，是否保留 `npm install` 作为 fallback？
  （建议保留，且要有断言）

### 5. 与手写画布的退场关系

**不要在本次调查里做删除**。只写清：

- `WorkflowCanvas.tsx` 现在被哪些入口引用（`grep -rn` 列全）。
- 它背后连着哪些能力（工作流库、自动化、Agent 的 `app_api_call`…）。
- 要让它退场，**必须先满足什么**（例如 flow 迁移无损、MERGE-1 单存储过门）。
- 给出一条**分阶段退场路线**（先并存 → 只读 → 移除）。

---

## 边界（不要碰）

- **不要改任何产品源码**（`apps/desktop/src/**`）。
- **不要**把 Node-RED 克隆进仓库主目录 —— 只在临时目录里调查。
- 如果决定要 vendor，**只在任务文件里写方案**，不要真的 `git clone` 进仓库
  （那需要用户确认体积与许可）。
- 不要碰 `genoffice/`。
- 不要改 `WorkflowCanvas.tsx`。

---

## 验收判据

1. 第 1 节的每条结论都有**证据**（路径 / 命令 / 输出），没有"应该"。
2. 第 2 节的改动面表格里，**每一行都写了改几个文件、几行**。
3. 第 3 节的对照表里，**找不到扩展点的能力逐条列出**，并注明要 fork 哪个文件。
4. 第 5 节给出**分阶段退场路线**，且每一步有前置条件。
5. 明确回答：**vendor 化后打包体积增加多少？构建时间增加多少？**
6. 明确回答：**许可证允许二开吗？**
7. 产出一份 `docs/planning/node-red-vendor-integration-map.md`（结构与
   `arc007-genoffice-native-integration-map.md` 对齐）。

---

## 你要在回写区回答的问题

- Node-RED 的许可证是什么？能二开吗？
- 编辑器构建要多久？能不能跳过（用预构建产物）？
- 我们要加的能力里，有多少能通过扩展点做、多少必须 fork？
- vendor 化后，打包体积与构建时间各增加多少？
- `WorkflowCanvas.tsx` 退场的前置条件是什么？现在满足了吗？
- 有没有必要保留 `npm install` 作为 fallback？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
