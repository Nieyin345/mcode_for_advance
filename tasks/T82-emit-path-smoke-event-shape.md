# T82｜T69 确认的 emit-path-smoke 事件扫描器误判修复

| 项目 | 值 |
|---|---|
| 编号 | T82 |
| 类型 | ARC-006/T60 测试断言回归（非 Node-RED 运行逻辑改造） |
| 优先级 | P2（原全量一套有明确旧断言差异） |
| 复用路线 | L1 现有 `workflowLive`、`emitExternal` 统一事件通路，不增第二事件源 |
| 可派 | **立即**；只改单个既有测试文件，源码只读 |
| 独占可写 | `apps/desktop/scripts/emit-path-smoke/main.ts`、如必需专属最小 fixture、本任务卡 |
| 禁写 | `main/workflowEngines/*`、`main/orchestration/*`、`packages/contracts/*`、所有 Node-RED 原厂源码及其它 smoke |


## 证据及任务性质
T69 把 `emit-path-smoke` 归 B 类，历史 `main.ts` 的 event sink 静态扫描对 `nodePackProductionPorts.ts:18,57` 的动态 `emitExternal(event)` 报假阳性，旧日志在 `apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/emit-path-smoke.log`；T69 建议原 **34/36** → **36/36**。这只能证明历史断言与当前源码形状不一致，**不能随便删掉动态事件的未知类型报警**。

## 开工前必读
1. `audit-ledgers/README.md`、T69 第 15 条与建议 5、T60 已提交事件分发记录。
2. `apps/desktop/scripts/emit-path-smoke/main.ts` 全文及其运行入口，`apps/desktop/src/main/workflowEngines/nodePackProductionPorts.ts` 的事件产出与 `workflowLive` 统一事件模型（只读）。

## 执行步骤
1. 在隔离环境首先重跑真实旧 34/36 红例，定位扫描器为什么把受约束动态事件类型当作未知。
2. 修**测试如何识别真实 producer/emitExternal 路径**，不让未知事件直接绕开检查。保留所有旧事件类型/路径/安全断言；新增至少一个合法动态来源正例和未知来源负例。
3. 运行原 Smoke 全部断言和有代表性的 T60 相关事件回归，不修改生产 event 底座。
4. 变异：将合法 sink 改为无法追踪的 broadcast 或引入非法事件类型，扫描器必红；恢复后原字节一致。

## 验收判据
1. 原 2 个假阳性在合法 production 事件形状下转绿，完整 36 条原断言不减少；不能变成无条件放行。
2. 新增未知事件/丢事件 sink 的负控确实红，正例原事件传递 E1/E2 与提交 SHA 完整。
3. 双包 TypeScript 与原 Smoke 在可复现、无争用环境运行；其它并行源码造成的错误注明不越权修。
4. 仅提交本测试与独立 fixture、任务卡；不改变 T79 节点 HTML/locale 生产源码。

## 不做
不重写 Node-RED 运行态事件，不修改 T69/70 已签的历史审计记录。

## 结果回写区

<!-- 执行对话仅追加证据、提交 SHA、实际命令/计数、原红→新绿、变异/恢复、未验风险。 -->


### 2026-10-21｜T82 执行结果（Mcode 执行对话）

- **原红例（E1）**：修改前 `apps/desktop/scripts/emit-path-smoke/main.ts` SHA256 `8996492fc75b62a9d7543bba7ea78d6fc99627500a0a551ed2e4770d038826e1`。使用仓库的 esbuild 0.25.1 将 `scripts/emit-path-smoke/main.ts` 打包到 `.tmp/emit-path-smoke-baseline.mjs` 后运行，得到 **34/36**；仅两条断言红，分别定位到 `workflowEngines/nodePackProductionPorts.ts:18` 的 `emitExternal(event: RuntimeEvent)` 与 `:57` 的 `{ ...event, ... } as Parameters<typeof runtimeManager.emitExternal>[0]`。原因是旧扫描器把合法动态事件来源一律当成未知；没有删掉未知事件报警，也没有改生产源码。
- **修复范围**：仅 `apps/desktop/scripts/emit-path-smoke/main.ts`。扫描器通过 AST 只接受两类可证明动态来源：①参数显式导入并标注为 `RuntimeEvent`；②元数据展开包装的类型可从同文件 const producer 的全部直接调用点穷尽追踪到事件名字面量。producer 调用逃逸、非字面量、未知属性覆盖、普通 `unknown`/cast、非法事件名仍 fail-closed。原有事件类型、路径、接线出口、安全哨兵断言均保留；新增合法来源、错误路径、未知 cast、非法 producer 类型等自检，**原 36 条断言未减少，当前共 41 条**。
- **原 Smoke 红→绿**：`node apps/desktop/scripts/run-smokes.mjs emit-path-smoke` → **41/41 PASS**（日志目录 `apps/desktop/.tmp/smoke-runs/1792594464292-35432-nHVDri`）。原两处假阳性消失，生产源码 27 个发出点仍在扫描范围内；动态 producer 的事件类型纳入契约表检查，hookable 动态来源也继续受禁止走 broadcast 的路径判据约束。
- **T60 事件回归（E1）**：`node apps/desktop/scripts/run-smokes.mjs mcode-node-pack-smoke node-red-e2e-smoke workflow-engine-runtime-smoke` → **3/3 PASS**（日志目录 `apps/desktop/.tmp/smoke-runs/1792594466143-30516-urF5VU`）。
- **变异 / 恢复**：仅把自检中的合法 `RuntimeEvent` 动态来源 sink 从 `runtimeManager.emitExternal(event)` 临时改成 `broadcastRuntimeEvent(event)`，Smoke 变为 **40/41，exit 1**，明确命中“合法 RuntimeEvent 参数的动态来源可被识别”负例。恢复后文件 SHA256 与变异前逐字节一致：`2d666d78e85b572ae2e351a653a8afc0058f0663ff857031f3562a99061a3f08`；临时备份已删除。非法 producer 类型和未约束 cast 也有独立负控。
- **TypeScript**：`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` → **0 errors**。当前工作树执行 `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` 时，报错来自并行文件 `apps/desktop/scripts/file-viewer-basedir-smoke/main.ts:137:79`：`TS18046: 'node.type' is of type 'unknown'`；该文件不属于 T82，未越权修改。此前有一次桌面包 typecheck 在并行任务落入工作树前通过，但当前最终状态的桌面包 typecheck 判据仍未达成。
- **提交与边界**：代码提交 SHA `143e13a5b38c9f34951170df3fbb845fb257df07`（`test(smoke): trace constrained dynamic event producers`）。本任务没有改 `nodePackProductionPorts.ts`、`main/workflowEngines/*`、`main/orchestration/*`、`packages/contracts/*` 或 T79 生产源码；其它并行工作树变更未暂存。
- **验收结论**：判据 1、2、4 达成；判据 3 **未完全达成**，原因仅为当前并行文件 `file-viewer-basedir-smoke/main.ts:137:79` 的桌面包 TypeScript 错误。T82 自身 Smoke 及 T60 三套回归通过，contracts typecheck 通过；不将并行错误误报为本任务修复，也不越权处理。
