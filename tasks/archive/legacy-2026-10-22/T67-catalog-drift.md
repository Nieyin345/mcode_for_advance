# T67｜T59 加了新 RPC 但没更新 apiCatalog

| 项目 | 值 |
|---|---|
| 编号 | T67 |
| 类型 | **回归**（T59 的遗漏） |
| 优先级 | **高** —— 新 RPC 对 Agent 不可见 |
| 建议并发 | 改 `appControl/` 的生成脚本；**与 T61 不冲突** |
| 预计规模 | 小 |

---

## 前置条件

- **T59 已完成**：`d3517719`
- **T61 已完成**：它跑 116 套时发现这条

---

## 现象

`app-control-smoke` 570 条断言里：

```
catalog 缺 workflowEngine.load（569/570）
```

## 实测确认

**契约里有**：

```
packages/contracts/src/ipc/workflowEngine.ts:30
export const WORKFLOW_ENGINE_LOAD_CHANNEL = "workflowEngine:load";
```

**处理逻辑也有**（`main/ipc/workflowEngine.ts` 加了 16 行）。

**但 catalog 里没有**：

```bash
$ grep -c "workflowEngine.load" apps/desktop/src/main/appControl/apiCatalog.generated.ts
0
```

而其它六个 `workflowEngine.*` 都在（`list` / `nodeInstall` / `nodesList` /
`respondNodeInstallApproval` / `start` / `status`）。

---

## 为什么这是真问题

`apiCatalog.generated.ts` 是 **Agent 经 `app_api_list` / `app_api_call` 看到的清单**。

**catalog 里没有 = Agent 永远调不到 `workflowEngine.load`。**

而 T59 做这个 RPC 的目的就是「让 UI 装载工作流进画布」。
Agent 调不到不一定是设计意图，但**至少这是漏了**。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/appControl/apiCatalog.generated.ts` ——
   **注意文件名里的 `generated`**，它是生成的，不是手写的。
3. **找到生成脚本** —— 这是本卡的第一件事。

```bash
grep -rn "apiCatalog" apps/desktop/scripts/ apps/desktop/package.json package.json | head -10
find . -name "*catalog*" -not -path "*/node_modules/*" | head -10
```

4. `apps/desktop/src/main/appControl/policy.ts` —— 新方法要归到哪一档。
5. `packages/contracts/src/ipc/workflowEngine.ts` —— `WorkflowEngineLoadInput` 的形状。

---

## 执行内容

### 第 1 步：先搞清 catalog 是怎么生成的

**不要手写那个文件。** 它是 generated，一定有生成脚本或运行时扫描。

三种可能：

- **A. 有显式生成脚本**（`scripts/gen-api-catalog.mjs` 之类）→ 跑一遍就行
- **B. 启动时扫描 RpcMap** → 需要重启才会更新
- **C. 手写维护的**（那就不是 generated，起错名了）

**如果是 A**，跑完检查 diff，确认只多了 `workflowEngine.load` 一条（或几条）。

**如果是 B**，找到扫描逻辑，看它为什么漏了这个方法。

**如果是 C**，那要改的是维护流程，在回写区说明。

### 第 2 步：给新方法分档

`policy.ts` 的 `AppPolicyLevel`：

```ts
read | ui | write | danger | blocked
```

`workflowEngine.load` 会**改写引擎的 flows.json** —— 这算 `write` 还是 `danger`？

**判断依据**：

- 它会停引擎（如果正在跑）
- 它会覆盖用户还没部署的草稿

**倾向 `danger`**，但要看 `workflowEngine.start` / `stop` 现在是什么档，
保持同一组内一致。

### 第 3 步：确认 catalog 与 RpcMap 不再漂移

**这是本卡最有价值的一步。**

现在的问题是「加了 RPC 忘了更新 catalog」。要防止下次再犯：

- 如果 catalog 是生成的 → **加一条 smoke 断言**：`RpcMap` 里每个方法都在 catalog 里
- 如果 catalog 是手写的 → 至少加一条同样的断言

**判据**：新加一个 RPC 不同步 catalog → 测试红。

---

## 边界（不要碰）

- **不手写 `apiCatalog.generated.ts`**（它是生成物）。
- 不改 `workflowEngine.load` 的实现（T59 做的）。
- 不改其它六个 `workflowEngine.*` 的档位。
- 不改 `policy.ts` 的既有分档规则。

---

## 验收判据

1. `apiCatalog.generated.ts` 里出现 `workflowEngine.load`（有断言）。
2. `app-control-smoke` **570/570**。
3. **新增一条漂移检测断言**：`RpcMap` 的所有方法都在 catalog 里（有断言）。
4. 变异验证：手动从 catalog 删一条 → 漂移检测断言红。
5. 现有 `app-control-smoke` / `api-catalog-*` 全绿。
6. 双包 tsc 干净。

---

## 回写区要回答

- catalog 是怎么生成的？脚本在哪？
- 为什么 T59 加 RPC 时没有触发重新生成？
- `workflowEngine.load` 最后归到哪一档？为什么？
- 漂移检测断言加在哪？
- 还有别的 RPC 也不在 catalog 里吗？（跑一次全量对比）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 开发执行记录（E1 动态 / E2 源码）

- **根因 / 生成方式（E2）**：存在显式生成器 `apps/desktop/scripts/gen-app-api-catalog.mjs`，从 `packages/contracts/src/ipc/rpcMap.ts` 取方法与类型、从 `apps/desktop/src/preload/index.ts` 解析通道，输出 `apps/desktop/src/main/appControl/apiCatalog.generated.ts`。生成器不是运行时扫描，也不会在编辑 RpcMap/preload 时自动执行。T59 新加了 RPC 与 preload，但当时未重跑这个手工生成步骤，也未在提交前通过 `app-control-smoke` 的已有集合对齐断言，导致生成产物漏项。
- **修复（E2）**：在 `apps/desktop` 执行 `node scripts/gen-app-api-catalog.mjs`，生成目录共 **443** 项，其中 `workflowEngine.load` 的 channel 为 `workflowEngine:load`，入参说明含 `workflowId`、`confirmReplace`。**没有手改生成物**。只将这一条新增项的 hunk 计入 T67 提交，其余原有、并行任务的 catalog 差异保持未暂存。
- **权限档（E2）**：`policy.ts` 为 `workflowEngine.load` 显式归 **danger**（用户每次亲自审批；不因完全访问绕过）。它会停正在运行的引擎、覆盖 `flows.json` / 画布未部署草稿，风险大于 `start` / `stop`；其它六个 `workflowEngine.*` 原有分档与策略规则未动。
- **防漂移断言（E1）**：`apps/desktop/scripts/app-control-smoke/main.ts` 原有“catalog 与 RpcMap 集合逐条对齐”断言保留；将漏匹配数字/下划线的方法名正则升级为 **TypeScript AST 读取 RpcMap 全部属性签名**，补 `members.length` 和方法数的防空过断言，并增加 `workflowEngine.load` 通道/输入描述、`danger` 两条回归断言。为了在 ESM 无头 smoke 中加载 TypeScript 编译器，`app-control-smoke/run.sh` 将 `typescript` 标记 external（由仓库依赖解析）。
- **全量对比（E1）**：AST 遍历 RpcMap 与 catalog 两个集合，`missing=[]`、`extra=[]`；没有发现别的 RpcMap 方法缺目录。无名称为 `api-catalog-*` 的独立 smoke 套件（目录搜索确认），目录同步检验由 `app-control-smoke` 承担。
- **旧红 → 新绿（E1）**：`node apps/desktop/scripts/run-smokes.mjs app-control-smoke` 修复前 **569/570**，`missing=["workflowEngine.load"]`；修复后含新增断言 **572/572 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792584518173-11380-HRq5gj/app-control-smoke.log`。
- **变异验证（E1）**：仅在受控脚本内临时从生成产物删除 **整个 `workflowEngine.load` entry**，同一 `app-control-smoke` 实测 **570/572 FAIL**，失败为“catalog 与 RpcMap 对齐”及“load 生成通道/入参说明”；日志 `apps/desktop/.tmp/smoke-runs/1792584505743-35248-cQo9Dq/app-control-smoke.log`。脚本 `finally` 还原原文件，原文逐字一致 `T67_RESTORED=True`；还原后再次复跑 **572/572 PASS**。
- **类型检查（E1）**：`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` exit 0；`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` exit 0。
- **补充观察（非本卡验收项）**：`agent-guide-smoke` PASS；并行开发中的 `module-permissions-smoke` 在 T48 的封闭式权限映射测试报 `Unmapped RPC method: workflowEngine.load`，该映射属于独立的 T49 模块权限施工范围，T67 未越界修改。需对应任务自行跟进，不能把它当作 T67 已验绿的套件。
- **本卡六项验收**：全部达成（第 2 项的原有 570 条全部通过，另有 2 条新增断言，故现为 572/572）。未做真实 Electron 用户旅程测试；该测试不在本卡判据中。
