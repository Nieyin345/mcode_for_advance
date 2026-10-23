# T81｜Node-RED 线到底卡在哪一步：施工地图 vs 现状的逐项核对

- Status: done（2026-10-23 执行回写，见文末）
- Category: **产品主线状态核实**
- Priority: **P0** —— 四条主线之一，但没人知道它现在到哪了
- Depends on: `docs/planning/node-red-vendor-integration-map.md`（T13）、`tasks/T13-node-red-vendor-investigation.md`
- Exclusive writable files: **只读 + `.tmp/` 探针**。不改任何产品文件、不改任何卡。

## Required Skills
- `code-review`：判断「文档说做了」和「代码真的做了」。
- `mcode-smoke`：跑已有套件确认状态。

## 背景：一份很详细的施工地图，和一份没人核过的现状

`docs/planning/node-red-vendor-integration-map.md` 有 160+ 行，逐项列了：

- 上游 vendor 已完成（`node-red/` 独立 Git checkout，`935b8d3e`，Apache-2.0）；
- 6 个 Mcode 改动面的**预计**文件数与行数；
- 每条的风险与既有回归套件。

**但它自己写着**：

> 这是一份**调查方案，不是 ARC-006 完成声明**。

而实际代码里：

```
apps/desktop/src/main/orchestration/nodeRedExecutor.ts        441 行
apps/desktop/src/main/workflowEngines/nodeRedOwnership.ts      84 行
apps/desktop/src/main/workflowEngines/nodeRedStorage.ts       609 行
```

**渲染端没有 Node-RED 画布** —— `WorkflowCanvas` 是自研图模型的面板。

## 任务：逐项核对「地图上写的」和「代码里有的」

### 第一步：读施工地图的 6 个改动面

它列了这 6 项（第二节的表格）：

1. `runtimeSupervisor.createEngineLaunchSpec`
2. `registry.BOOTSTRAP` + production `launchSpec`
3. `engineNodeReadiness`
4. 打包 `electron-builder.yml` / `electron.vite.config.ts`
5. `.gitignore`
6. Host/原厂 Editor 会话接线（**地图说这是「后续」**）

**逐项去代码里查**：

- **这项改了吗？**（`grep` 关键符号 + `git log --oneline -- <文件>`）
- **如果改了，改得和地图一致吗？**
- **如果没改，地图上说的「最小施工预算」现在准不准？**

### 第二步：跑现有的 Node-RED 套件

```bash
ls apps/desktop/scripts/ | grep -i "node-red\|nodered"
```

**每套跑一遍，记录实际数字。**

**特别注意**：如果某套写着「e2e」但实际只测了存储层，那它名不副实——**这是今天反复出现的模式**（套件名说 A，实际测 B）。

### 第三步：回答一个具体问题

**用户现在能不能：打开 Mcode → 看到 Node-RED 画布 → 拖一个节点 → 部署 → 它真的跑起来？**

**逐个环节确认**：

| 环节 | 有没有 | 证据 |
|---|---|---|
| 画布 UI（原厂 `editor-client`） | ? | 渲染端有没有加载它 |
| 引擎启动（runtime supervisor） | ? | 有没有 launch spec |
| 部署（`POST /flows`） | ? | registry / ownership |
| 执行 | ? | executor |
| **端到端连起来** | ? | 有没有一套 e2e 真的走完这四步 |

### 第四步：给出「下一步该做什么」的判断

基于前三步：

- **离「能用」差几步？**
- **哪一步是真正的瓶颈？**
- **地图上的估算还准吗？**（如果不准，给出新的估算与理由）

## 验收判据

1. **6 个改动面逐项核对表**（改了 / 没改 / 改得不一样），每项有 `grep` 或 `git log` 证据。
2. **现有 Node-RED 套件的实际运行数字**（不是「应该有」）。
3. **「用户能不能拖节点部署执行」的明确答案**（逐环节 + 证据）。
4. **下一步判断**：差几步、瓶颈在哪、估算准不准。
5. **不改产品代码、不改卡**。

## 边界

- **只读 + `.tmp/` 探针**；
- **不改任何产品文件、不改任何卡**；
- 不跑全量、不起 Electron；
- 如果某套件需要 Electron，**跳过并注明**（用户规定不起 Electron）。

## 遇到问题先检索

**地图上的行号可能已经漂了**（今天已经证实过好几次）。以代码为准，差异写进回写。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T81-node-red-actual-state.md` 末尾追加 `## 结果回写（2026-10-23）`：
6 项核对表、套件实际数字、逐环节表、「能不能用」的答案、下一步判断、提交 SHA。

## 结果回写（2026-10-23）

### 核心答案：**卡的前提有一半是错的 —— 画布是有的**

卡面写「**渲染端没有 Node-RED 画布** —— `WorkflowCanvas` 是自研图模型的面板」。**前半句不成立。**

实际：

- `EngineRuntimePanel.tsx:407` 有 `data-engine-view-stage` 占位区，注释写明「**running 时主进程把 WebContentsView 摆到它的窗口矩形上**」；
- `WorkflowsPanel.tsx:256`：「**One authenticated WebContentsView, shared by the two libraries.**」；
- 主进程 `ipc/index.ts:190-204`：`documentViewHost.setEditorCredentials(...)` —— **引擎编辑器页的凭据注入**，令牌经 `session.webRequest.onBeforeSendHeaders` 按 webContentsId + 回环 origin 注入，**不进 URL / 快照 / 日志**；
- `documentViewHost.ts` 支持 `workflowEngineId`（`:172-173`、`:317-318`、`:467`）。

**原厂 editor 是通过 `WebContentsView` 加载的**，复用了 GenOffice 那条受控视图宿主。**不是**自研画布。

> 「渲染端没有原厂画布」这个说法在**自研 `WorkflowCanvas` 面板**的语境下是对的（那个面板还在，用于 `engine=mcode` 的图），但它**不代表整条线没有画布**。

---

### 6 个改动面逐项核对

| # | 地图上的项 | 现状 | 证据 |
|---|---|---|---|
| 1 | `runtimeSupervisor.createEngineLaunchSpec` | ✅ **已改** | `NODE_RED_VENDOR_VERSION = "5.0.8"`（`:721`）、`source: "vendor" \| "npm"`（`:723`）、`:797` 按 `installPackage === "node-red"` 分支。提交 `be854381` |
| 2 | `registry.BOOTSTRAP` + production `launchSpec` | ✅ **已改** | 文件头 `:14-15`「首选固定 5.0.8 vendor / vendor 不可用时显式记录并回退 npm」；`launchSpec` 相关 9 处。提交 `4fc72d22` |
| 3 | `engineNodeReadiness` | ✅ **已改** | 文件存在，`4d951dfa`「fail closed on changing node approval ledger」 |
| 4 | 打包 `electron-builder.yml` / `electron.vite.config.ts` | ✅ **已改** | `electron-builder.yml:121-128`：`from: .tmp/node-red-release → to: node-red` + `resources/node-red → node-red/mcode-theme`；`stage-node-red-resources.cjs` 存在（含 license 材料，`782b08fc`） |
| 5 | `.gitignore` | ✅ **已改** | `.gitignore:72` `/node-red/` |
| 6 | Host/原厂 Editor 会话接线 | ✅ **已接（地图自己标为「后续」）** | 见上「画布是有的」——`WebContentsView` + 凭据注入 + `documentViewHost` 的 `workflowEngineId` 通路 |

**6/6 全部已改。** 地图是**施工预算**，不是现状；实际施工已完成。

---

### 现有 Node-RED 套件实际运行数字（不是「应该有」）

| 套件 | 结果 |
|---|---|
| `node-red-deploy-reconciliation-smoke` | **75/75 通过** |
| `node-red-e2e-smoke` | **`node-red-vendor runtime/editor verification: PASS`** |
| `node-red-theme-smoke` | **`MUTATION PASS: removing editorTheme.page.css makes editor theme check red`** |
| `t10-node-red-pause-license-smoke` | 绿（pause@0.0.1 MIT 文本 + 无 release-blocker） |
| `t88-node-red-license-closure-smoke` | 绿（manifest 绑定精确版本/SPDX/revision/SHA-256） |
| `t8-node-red-u1/` | **未跑 —— 需要真 Electron，按卡面边界跳过** |

**`node-red-e2e-smoke` 名实相符** —— 它确实走完了：真 spawn 引擎 → 真 HTTP 探活 → 编辑器 `GET /` 返回 200 且是 Node-RED 页（`:411`）→ 未带凭据全部 401（`:455-458`）→ **带凭据部署成功（200 且带 rev）**（`:512`）→ **部署后 HTTP-in 真的注册并应答 200**（`:523`）→ **`nodeRedExecutor` 经真 HTTP-in 执行成功**（`:777`，`out.status === "success"`）→ 重启后 trusted 自动执行（`:603`）→ 可信标记损坏按 untrusted（`:612`）。

**不是「名字说 e2e 实际测存储」**。今天那个模式**没有**出现在这里。

---

### 逐环节：用户能不能「打开 → 拖节点 → 部署 → 跑起来」

| 环节 | 有没有 | 证据 |
|---|---|---|
| **画布 UI（原厂 editor-client）** | ✅ **有** | `WebContentsView` 加载原厂 editor 页（`EngineRuntimePanel:407` + `documentViewHost` 的 `workflowEngineId`）；e2e `:411` 断言「编辑器 GET / 真响应 200 且是 Node-RED 编辑器页」 |
| **引擎启动** | ✅ **有** | `createEngineLaunchSpec` + vendor/npm 双源；e2e 真 spawn、真探活 |
| **部署（`POST /flows`）** | ✅ **有** | 带宿主凭据部署 200 + rev（`:512`）；无凭据 401（`:457`）；`node-red-deploy-reconciliation-smoke` 75/75 |
| **执行** | ✅ **有** | `nodeRedExecutor` 经真 HTTP-in 成功（`:777`）；`out.summary === "Node-RED 200"`（`:778`）；function 节点回显的 body 与发送一致（`:779`） |
| **端到端连起来** | ✅ **有，但是 U1 级** | `t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`：`canvas-editor-ready` → `production-load-entry` → 双击节点开编辑托盘（`RED.editor.edit`）→ 部署 → 重开比字节。**未跑（需 Electron）** |

**结论：四步全都通，且有 e2e 证据（无头部分）。** 但——

---

### ⚠️ 三个必须说清的限定

**1. 「拖一个新节点进画布」没有被验过。**

T8 的 journey 里「编辑」是**双击已有节点打开编辑托盘**（`node-red-canvas-load-edit-deploy-reopen.ts:10`），**不是从 palette 拖新节点**。

- **能做的**：改已有节点的参数 → 部署 → 跑；
- **没验的**：从 palette 拖一个**新**节点 → 连线 → 部署。

这是「能不能用」和「能不能**从零搭**」的差别。**卡问的是前者，答案是有；后者无证据。**

**2. T27 已修，但 journey 里那段注释是陈旧的。**

`node-red-canvas-load-edit-deploy-reopen.ts:159-160` 写「生产 T59 装载入口的**真实行为**：对任何有节点的可保存图都拒绝」，并把「已知拒绝」和「成功」都当合法结局。

**但代码里「无法无损装载」这个字符串已经不存在了**（`grep -rn "无法无损装载" apps/desktop/src/main/` → 零命中），T27 已修。

**后果**：那步断言现在**接受两种结局**，其中一种已经不会发生——**这是一条会掩盖回归的断言**（如果装载入口坏回原样，它仍会绿）。**建议另开卡收紧。**

**3. 地图的估算严重低估了「画布接线」这一项。**

地图说第 6 项「至少 2–4 文件、约 120–300 行」。实际：
- `EngineRuntimePanel.tsx` **743 行**；
- `documentViewHost.ts` **2013 行**（复用了 GenOffice 的宿主，这是聪明的做法——省掉了重写，但**地图没把这个复用算进去**）。

**估算准不准**：前 5 项基本准（地图说 1 文件 25-55 行，实际改动量级相当）；**第 6 项差一个数量级**，但差的方向是「实际更省」——**因为复用了已有的 `documentViewHost`，而不是新写**。

---

### 下一步判断

**离「能用」差几步：**

**差 1 步，而且是「验证」不是「实现」。**

四步链路在代码里全通，e2e 也证明了引擎/部署/执行。**缺的是「用户从零搭一个新工作流」的 U1 证据**——而那需要真 Electron（卡不让起）。

**瓶颈在哪：**

**不是技术，是「U1 窗口」这个环境约束。** `t8-node-red-u1` 已经写好了完整 journey（load-edit-deploy-reopen），只要有人能在真 Electron 里跑一次，这条线就能从「代码上通了」变成「验证过能用」。

**地图估算准不准：**

- **前 5 项准**（量级对）；
- **第 6 项低估一个数量级**，但**因为复用而实际更省**；
- **地图整体已过期**：它所有「拟修改」现在都是「已修改」。

---

### 未做

- **没跑 `t8-node-red-u1`**（需真 Electron，按卡面边界跳过）。
- 没核实 vendor 的 `mcode/integration` 分支相对 `935b8d3e` 有哪些补丁（`patches/node-red/` 目录不存在，需另行确认补丁怎么存的）。
- 没验证安装包形态下 vendor 能否启动（E3）。
