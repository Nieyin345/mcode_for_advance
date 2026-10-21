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
