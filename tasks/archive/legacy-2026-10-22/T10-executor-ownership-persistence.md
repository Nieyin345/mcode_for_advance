# T10｜executor owner 注册表落盘（T03 的未完成部分）

| 项目 | 值 |
|---|---|
| 编号 | T10 |
| 类型 | ARC-006 Gate D 续篇（补 T03 未达成的两条判据） |
| 优先级 | 高 —— 不落盘的话，"同一 cron 响两遍"的防线在重启窗口里不存在 |
| 建议并发 | 不要与任何改 `workflowEngines/` 的任务并行 |
| 预计规模 | 中 |

---

## 为什么做这个任务

T03（提交 `14880aeff`）已经把 owner 判据接进了四条真实生产路径（手动运行、
自动化触发、引擎启动、原生 Deploy），27/27 关联套件通过。**但它的两条核心判据没达成**：

有问题的两个场景是这样的：

1. 用户开着 Mcode，某条 flow 归 Node-RED 所有。**进程重启**。
   注册表是内存的 → 重启后 `executorOwnerOf()` 对每条 flow 都返回 `null`
   → 旧 runner 的定时器认为"没人拥有，我可以跑" → 同一条 cron 在 Node-RED 仍然
   持有它的同时**被 Mcode 再跑一遍**。这正是 MERGE-3 验收门要防的事。
2. 即使不重启，owner 文件与 `flows.json` 是两份状态。部署成功后如果只更新了其中
   一份就崩溃，重启后两边的说法不一致，而**没有任何机制去发现这一点**。

`executorOwnership.ts` 的文件头注释自己写着：

> 生产装配将来把 `ExecutorOwnershipStore` 换成落盘的版本（与 flows.json 同一事务
> 边界）—— 届时本模块的判据原样复用。

`ExecutorOwnershipStore` 接口（`get` / `insert` / `remove` / `list`）已经为此设计好：
`insert` 在已存在时**必须失败**而不是覆盖。本任务就是写这个落盘实现并装配进去。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `apps/desktop/src/main/workflowEngines/executorOwnership.ts` **全文** ——
   特别是 `ExecutorOwnershipStore` 接口的注释与 `decideClaim` 的三条规则。
3. `apps/desktop/src/main/workflowEngines/nodeRedOwnership.ts` ——
   `nativeFlowIds()` 如何从 `flows.json` 推导归属；这是"损坏后重建"的依据。
4. `apps/desktop/src/main/workflowEngines/nodeRedStorage.ts` 与 `projectFlowDir.ts`
   —— flows.json 实际写在哪、用什么原子写。
5. `apps/desktop/src/main/lib/atomicFile.ts` —— **唯一的原子写出口**，必须复用。
6. `apps/desktop/scripts/executor-gate-d-smoke/main.ts` —— T03 建的回归网，
   你要在它基础上加，不要另建一套。

---

## 执行内容

### 1. 落盘实现

新增 `FileExecutorOwnershipStore implementing ExecutorOwnershipStore`：

- 文件位置：与 `flows.json` 同目录（先读 `projectFlowDir.ts` 确认），文件名
  `executor-ownership.json`。
- **原子写**：复用 `@main/lib/atomicFile.js`。禁止直接 `writeFileSync`。
- **insert 语义**：已存在（无论 owner）→ 返回 `false`，内存与磁盘都**不改动**。
  接口注释已经写死了这条，落盘实现必须遵守同样的合同。
- **读取时机**：构造时一次性读入内存（与内存实现同形态），但**每次写都落盘**。
  不要做成"每次读都读文件"—— 那会让 `executorOwnerOf` 出现在热路径上的 IO。
- **文件损坏**（JSON 解析失败 / 结构非法）：
  1. **保留原档**（改名 `<name>.corrupt-<timestamp>`，不要覆盖）；
  2. 调 `nodeRedOwnership.nativeFlowIds()` 从 `flows.json` 重新推导；
  3. 推导结果**显式记录**（日志 + 可诊断状态），不要静默接受；
  4. 不要在损坏时"默认成 mcode"或"默认成 node-red"—— 那正是 fail-open。
  5. 如果 `flows.json` 也读不了 → 空注册表 + 明确告警，**并且拒绝让旧 runner
     自动接管**（宁可拒绝执行，不要双跑）。

### 2. 与 flows.json 的一致性

设计并实现「部署时两份状态怎么保持一致」：

- 推荐顺序：**先写 owner（claim），再部署 flows.json；部署失败则回滚 owner**。
  这样最坏情况是"owner 说有、flows 里没有"（安全方向：拒绝第二次执行），
  而不是"flows 里有、owner 说没有"（危险方向：允许第二执行器接管）。
- 若部署成功但写 owner 失败 → 必须让**这次部署整体失败**（回滚 flows.json），
  不能留下两边不一致。
- 启动时的交叉检查：owner 文件里有、但 `flows.json` 里没有该 flow →
  记录告警并释放（stale owner），同时写诊断；反向（flows 里有、owner 没有）→
  按 `nativeFlowIds()` 重新 claim。

### 3. 装配

把 `sharedExecutorOwnership` 从 `createInMemoryExecutorOwnership()` 换成落盘版。
**注意**：测试里大量使用内存版（`setExecutorOwnership(new ...InMemory...)`），
装配点要允许注入，不要在模块顶层无条件创建文件。

### 4. 测试（加在 `executor-gate-d-smoke` 里，不新建套件）

- 写一条 owner → **重建 registry** → `executorOwnerOf` 仍返回同一 owner（真落盘）。
- insert 已存在 → `false` 且原记录不变（磁盘上也未变）。
- 文件损坏 → 原档被保留（改名后的文件存在）+ 从 flows.json 重建 + 有告警。
- flows.json 也坏 → 空注册表 + 拒绝旧 runner 接管。
- 部署失败 → owner 回滚，磁盘与内存一致。
- stale owner（owner 有、flows 无）→ 启动时释放并有诊断。

---

## 边界（不要碰）

- 不要改 `executorOwnership.ts` 的**判据**（`decideClaim` / `claim` / `release` 的语义）。
  只加 store 实现与装配。
- 不要改 `runner.ts` / `automationRunner.ts` 的调用形态（T03 刚接好）。
- 不要碰 renderer、document、mobile、modules。
- 不要改 `flows.json` 的写入实现（`nodeRedStorage.ts`），只在它前后加一致性协调。
- 不要 push。

---

## 验收判据

1. 「写 owner → 重建 registry → 仍是同一 owner」这条断言在**真文件**上通过。
2. 损坏文件 → 保留原档（断言改名后的文件存在且内容等于损坏前字节）。
3. 两个 fail-open 场景各有断言：文件损坏不默认落端；flows.json 也坏时拒绝接管。
4. 部署失败回滚后有断言：磁盘上的 owner 文件与内存一致。
5. `executor-gate-d-smoke` 原有 62 条**全部仍然通过**。
6. 双包 tsc 干净；`automation-smoke` / `node-red-e2e-smoke` 仍全绿。
7. **变异验证**：把落盘改回纯内存 → 「重建 registry 后仍生效」必须变红；
   把损坏分支改成"默认 mcode" → 对应断言必须变红。

---

## 你要在回写区回答的问题

- owner 文件与 flows.json 的实际写入顺序是什么？中间崩溃各会留下什么状态？
- 启动时交叉检查发现不一致，用户能看到什么？（日志 / 设置页 / 静默）
- 有没有仍然存在的 fail-open 路径？（例如 owner 文件权限问题导致写入失败）
- `list()` 在文件很大时有没有性能问题？（评估即可，不必优化）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜T10 执行回写

- **源码提交**：`cb1d2ba9e4d143f7dae348376ac5477136586609`（仅 T10 所属 5 个源码/测试文件；未 push）。证据等级：E1（隔离磁盘与 fake Node-RED child）+ E2（生产装配）。
- **修改文件**：`fileExecutorOwnershipStore.ts`（新增）、`executorOwnership.ts`（懒加载生产持久化、损坏时拒绝 legacy）、`nodeRedOwnership.ts`（重启时原生 owner 领回）、`atomicFile.ts`（原子同步写供同步 store 使用）、`executor-gate-d-smoke/main.ts`（仅扩现有网）。
- **验收**：`node apps/desktop/scripts/run-smokes.mjs executor-gate-d-smoke automation-smoke node-red-e2e-smoke` → 三套 PASS（`executor-gate-d-smoke: 81/81`，原 62 个断言保留）；日志 `apps/desktop/.tmp/smoke-runs/1792532078133-30408-lAChii/`。双包 `tsc --noEmit -p apps/desktop/tsconfig.json` + `tsc --noEmit -p packages/contracts/tsconfig.json` 均退出 0。测试使用各自临时数据根，不触及用户真实库。
- **变异验证**：① 临时撤掉 `insert` 落盘 → 真实重建 registry 断言 **RED**（`actual:null, expected:mcode`）；② 损坏 owner 分支临时恢复 legacy fail-open → “corruption must not default to mcode” **RED**；两次均自动逐字节还原新模块；随后三套正式回归全绿。
- **写入顺序与崩溃后果**：新的原生 flow 先同步原子写入 owner 再让 Node-RED Deploy；失败时回滚新增 claim，成功后才释放被移除的 claim。中途崩溃的保守方向是「owner 多于 flows」，重启启动交叉检查按 `nativeFlowIds()` 补充缺失原生 owner、释放已消失的原生 owner；文件坏档保存为 `executor-ownership.json.corrupt-<timestamp>-<uuid>`，拒绝旧 runner 自动接管。
- **用户可见性**：主进程日志 `[executor-ownership]` 告警；`FileExecutorOwnershipStore.diagnostics()` 给出结构化 `legacyBlocked` 与事件，**尚未接入设置页**，因此 UI 目前没有专门提示。
- **剩余风险 / 完整原子性边界**：owner 持久写失败会在提交内存 claim 之前抛错（安全拒绝，不 fail-open）；但跨**两个独立 Mcode 主进程**的 owner 文件没有 OS 互斥/CAS，因此多进程抢占仍可能互相覆盖，尚无双 OS 进程 U1 证据。原生 Deploy 已返回成功而**释放旧 owner**落盘失败时，仍只能保留多余 owner 并日志告警，不能在当前父子消息协议里回滚已成功写入的 `flows.json`；这是剩余的严格双文件事务缺口（安全方向：不提前让第二端执行）。
- **大 `list()` 评估**：读的是内存 Map，热路径不做文件 IO；`list()` 是 O(n) 复制，owner 数巨大时有内存/CPU 成本，按任务边界未做分页优化。
