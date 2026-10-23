# T81｜Node-RED 线到底卡在哪一步：施工地图 vs 现状的逐项核对

- Status: ready-for-agent
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
