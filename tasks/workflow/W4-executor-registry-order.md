# W4｜自动化预检说「缺执行器」，而这条流其实能跑

- Status: **delivered（回写已追加；改动未提交，见 `## 结果回写`）**
- Category: **产品缺陷（Node-RED 工作流）**
- Priority: **P1 —— 假失败，把用户指向错误方向**
- Depends on: W0（缺口，探针 `.tmp/w0/executor-registry-order-probe.ts`）
- Exclusive writable files:
  - `apps/desktop/src/main/orchestration/executionEngine.ts`
  - 新建 `apps/desktop/scripts/workflow-executor-registry-order-smoke/`
  - **不改 `apps/desktop/src/main/index.ts`**（装配顺序的另一半，见下）

## Required Skills
- `mcode-smoke`：无头主进程套件。
- `diagnosing-bugs`：先证明因果，再改。

## 缺陷（W0 探针实测）

```
$ node .tmp/w0/executor-registry-order-probe.ts
module singleton kinds BEFORE port set: [ 'command', 'code', 'module-capability' ]
module singleton kinds AFTER port set:  [ 'command', 'code', 'module-capability' ]
a fresh engine created after port set:  [ 'command', 'code', 'module-capability', 'node-red' ]

verdict:
  module singleton registers node-red: false
  per-run engine registers node-red:   true
```

**模块级单例 `executionEngine` 永远不注册 `node-red` 执行器**，而运行期新建的引擎有。

## 根因（代码位置已核）

`executionEngine.ts:265`：

```ts
if (workflowEngineUsable(NODE_RED_ENGINE_ID)) { engine.register(nodeRedExecutor(...)); }
```

`:142-146`：

```ts
function workflowEngineUsable(engineId: string): boolean {
  if (workflowEngineStatusPort === null) return false;   // ← 装配期必然是 null
  ...
}
```

`:280`：

```ts
export const executionEngine = createBuiltinExecutionEngine();   // 模块加载时执行
```

而 `index.ts:46` 先 `import { setWorkflowEngineStatusPort }`，`:86` 才调用它注入端口。
**模块单例在 import 那一刻就构造完了，那时端口还是 null。**

## 后果

| 消费方 | 读到什么 | 用户看到什么 |
|---|---|---|
| `scenePreflight.ts:75` | `executorKinds` 里没有 `node-red` | 场景预检说「缺执行器」 |
| `ipc/orchestration.ts:396` | 同上 | 同样的假失败 |

**而那条 flow 实际能跑**（运行期新建的引擎有 `node-red`）。

**假失败的代价**：用户以为是配置错了，去查一个不存在的问题；或者放弃用 Node-RED。

## 任务

### 一、先证明因果（不要直接改）

**判据**：让单例在端口注入**之后**仍拿到正确的 `kinds()`。

建议先写一个**不依赖修法**的探针，证明「顺序是唯一原因」：

1. 构造一个引擎，**在 `setWorkflowEngineStatusPort` 之前**创建 → kinds 无 node-red；
2. 同一个进程里，**在之后**创建 → kinds 有 node-red；
3. **中间不改变任何其他东西**。

**如果第 1、2 条结果与 W0 的探针一致，因果成立。**

### 二、选一个修法（论证哪个对）

**候选 A：把单例改成惰性**

```ts
let singleton: ExecutionEngine | null = null;
export function executionEngineInstance(): ExecutionEngine {
  return (singleton ??= createBuiltinExecutionEngine());
}
```

- 优点：改动小、语义清楚；
- 缺点：**所有消费方都要改成调用函数**（`executionEngine.kinds()` → `executionEngineInstance().kinds()`），
  而且要看有没有人在**端口注入之前**就用它。

**候选 B：让 `register` 延迟到首次 `kinds()` / `execute()`**

- 优点：消费方不改；
- 缺点：引擎内部多一层惰性状态，可能引入「注册两次」的风险。

**候选 C：改 `index.ts` 的装配顺序**（端口先注入，再 import 引擎）

- 优点：最贴近根因；
- 缺点：**`index.ts` 是别人的边界（本卡不许改）**，而且 ESM import 是提升的，
  顺序不一定可控。

**你要论证选哪个，并说明为什么不选另外两个。** 写进回写。

### 三、加断言

新建 `workflow-executor-registry-order-smoke/`，**必须包含**：

1. **正控**：端口注入后，单例的 `kinds()` **包含** `node-red`；
2. **负控**：端口**未注入**时（模拟装配早期），`kinds()` **不含** `node-red`（fail-closed 仍然正确）；
3. **回归**：`kinds()` 里 `command` / `code` / `module-capability` 三个内置执行器**一直都在**。

**第 2 条很重要**：修法不能变成「无条件注册 node-red」——那会让「引擎没起来」时
也声称能跑，是另一个方向的错。

### 四、变异验证

- 把修法撤掉 → 第 1 条必须红；
- **第 2、3 条必须仍然绿**（它们验的是另外两件事，不该被这个变异影响）。

**如果第 2 或 3 条跟着红，说明它们和修法耦合了** —— 重新设计。

## 验收判据

1. **单例在端口注入后 `kinds()` 含 `node-red`**（探针 + 断言双证）；
2. **端口未注入时仍不含**（fail-closed 未被破坏）；
3. **三个内置执行器不受影响**；
4. **变异**：撤修法 → 第 1 条红、第 2/3 条绿；
5. **`workflow-engine-*` 既有套件不回归**（至少跑 `workflow-engine-selection-smoke` 与 `workflow-engine-runtime-smoke`）；
6. `tsc` EXIT=0；
7. 不跑全量。

## 边界

- 只改 `executionEngine.ts` + 新建套件；
- **不碰 `index.ts`**（别人边界）；
- **不碰** `apps/desktop/src/renderer/**`（UI 总控）、`tasks/T*.md`、`tasks/README.md`。

## 一个提醒

**W0 发现这条时，`scenePreflight` 与 `ipc/orchestration.ts` 两处都在读单例。**
你改完之后要确认**两处都拿到正确结果**，不是只改一处。
（这正是 CLAUDE.md 里「T40 有两处注入，只包一处等于没修」的同类。）

## 回写

`tasks/workflow/W4-executor-registry-order.md` 末尾追加 `## 结果回写`：
因果证明、选了什么修法、为什么不选另外两个、四条断言、变异结果、套件数字。

---

## 结果回写

**状态**：已交付（未提交 —— 本卡不许 `git commit`；改动留在工作区）。
**改动**：`apps/desktop/src/main/orchestration/executionEngine.ts`（唯一生产文件）
+ 新建 `apps/desktop/scripts/workflow-executor-registry-order-smoke/`（`main.ts` + `run.sh`）。
**没碰**：`main/index.ts`、`renderer/**`、`tasks/T*.md`、`tasks/README.md`。

### 1. 因果证明（先证明，再改）

自写探针 `.tmp/w4/probe.ts`（跑完已删；重建方法见下），复现 W0 的三行，并**再窄一格** ——
关键不是「单例 vs 新建引擎」，而是「**同一个**单例在端口注入前后都不变，而同一时刻
新建的引擎有」：

```
修复前：
  1. module singleton BEFORE port set: ["command","code","module-capability"] hasNodeRed= false
  2. SAME module singleton AFTER port set: ["command","code","module-capability"] hasNodeRed= false
  3. fresh engine right after injection:   ["command","code","module-capability","node-red"] hasNodeRed= true
修复后（同一探针）：
  2. SAME module singleton AFTER port set: [...,"node-red"] hasNodeRed= true
  3. fresh engine right after injection:   [...,"node-red"] hasNodeRed= true
```

**「同一个单例、同一时刻、只差构造时间」** —— 第 2 行与第 3 行的唯一差别是**构造发生在
端口注入之前还是之后**。因果成立，且原因就是卡上写的 `:280` 构造期执行。

探针重建（卡上 `.tmp/w0/run-executor-registry-order-probe.sh` 仍可用，跑它即可复现 W0 版本；
我的窄化版只是把 `executionEngine.kinds()` 在 `setWorkflowEngineStatusPort(...)` 前后各读一次）。

### 2. 选了哪个修法、为什么不选另外两个

**选了 B 的一个变体**（不是卡上原样的 B）：在 `ExecutionEngine` 上加
`registerWhenAvailable(create: () => NodeExecutor | null)`，把 node-red 的注册**延迟到观察
注册表时**（`kinds()` / `has()` / `execute()` 三处先 `settleDeferred()`）。与卡上 B 的差别：
不是「让 `register` 自己延迟」，而是**新增一条有名字的注册缝** —— 普通 `register` 的语义
一个字没改，延迟只发生在**明确声明「可用性晚于构造」**的那一个执行器上。

- **不选 A（惰性单例函数）**：卡上自己写了缺点 —— **所有消费方都要改**。实测消费方两处
  （`scenePreflight.ts:75`、`ipc/orchestration.ts:396`，另有 `module-workflow-smoke/main.ts`、
  `module-phase2-e2e-smoke/main.ts`、`baseline.ts` 直接 `executionEngine.has(...)`），
  改它们超出本卡写边界；而且「改成函数」只解决单例，**`createBuiltinExecutionEngine()` 的
  构造期判据依然是错的**（任何在端口注入前构造的引擎都会带着错误清单），只是眼下生产里
  只有一个这样的构造点。B 变体把判据本身修对，两种构造方式都受益。
- **不选 C（改 `index.ts` 装配顺序）**：卡上明确「不许改」，且 ESM import 提升让
  「先注入端口再 import 引擎」不可控 —— 即使改了 `index.ts` 的语句顺序，`import` 仍然先于
  所有顶层语句执行。**这条候选在 ESM 下根本不成立**，不是「不建议」而是「做不到」。
- **为什么也不是「无条件注册」**：卡上第 2 条断言要求的 fail-closed。`registerWhenAvailable`
  的 `create` 返回 `null` 时**不注册**，只在后续观察时重问 —— 端口没装 / 引擎没跑时
  `kinds()` 仍不含 node-red（§2 的变异 #2 实测）。

### 3. 四条（实际 17 条）断言的实际输出

`workflow-executor-registry-order-smoke:17/17 通过`（EXIT=0）。按卡上三条方向归组：

| 卡上要求 | 套件里的断言 | 结果 |
|---|---|---|
| **1. 正控**：端口注入后单例含 node-red | `★ 端口注入且 running 后，同一个单例的 kinds() 含 node-red` | ok |
| | `同一时刻新建的引擎也含 node-red（单例与按次引擎一致）` | ok |
| **2. 负控**：端口未注入时不含（fail-closed） | `★ 端口未注入时单例不含 node-red（fail-closed）` | ok |
| | `★ 引擎 stopped 时单例不含 node-red` | ok |
| | `★ running 但端口为 null 时不含 node-red` | ok |
| **3. 回归**：三个内置执行器一直在 | `★ 含内置执行器 command / code / module-capability`（三条）+「注册 node-red 后仍一个不少」 | ok ×4 |
| （补）注册后停引擎不撤 | `★ 注册后引擎停掉，单例仍保留 node-red` | ok |
| **消费方 automation.preflight** | `★ 引擎 running 时预检不报 node-red 缺执行器` / `预检把 executor:node-red 列为已满足能力` | ok ×2 |
| **消费方 scenePreflight** | `★ 清单装配从单例拿到 node-red（executor descriptor 在册）` / `preflightScene 真服务仍返回 ok` | ok ×2 |

### 4. 两个消费方都核过的证据

不是只「看一眼」，是**两个消费方各有一条端到端断言**（套件 §4/§5）：

1. **`ipc/orchestration.ts:396`（自动化预检）**：走**真的** `registerWorkflowHandlers`（fakeIpc
   记名，抄 `orchestration-ipc-smoke` §0）+ **真的** `automationPreflight`。夹具是一份含
   `mcode.node-red` 节点的工作流，引擎 running 时断言 `problems` 里**没有** `missing-executor`
   且 `capabilities.available` 含 `executor:node-red`；变异时（撤修法）这条**红**并打印
   `「引擎步骤」:缺少执行器「node-red」` —— 正是用户看到的假失败。
2. **`appServices/scenePreflight.ts:75`**：`preflightScene` 的契约 `SceneCapabilityRef.kind`
   **只有 plugin/skill/mcp/module**，它不探 executor —— 但它**装配**的 `executorKinds` 来自
   单例。套件断言的分两层：
   - 拿 `[...executionEngine.kinds()]`（**同一句装配**）喂**真的** `collectCapabilityInventory`，
     断言产出 `executor:node-red` 描述符 —— 这是场景预检清单里会被查到的那一条；
   - 走**真的** `preflightScene` 服务，断言装配链没被修法打断（`ok === true`）。

   **卡片上「scenePreflight 读到缺执行器」的说法需要修正**，见 §7。

### 5. 变异结果

**变异 #1（撤掉修法，恢复构造期 `if`）** —— 预期红 6 条，实际红 6 条：

```
  FAIL ★ 端口注入且 running 后，同一个单例的 kinds() 含 node-red
  FAIL ★ 注册后引擎停掉，单例仍保留 node-red
  FAIL ★ 引擎 running 时，自动化预检不报 node-red 缺执行器（problems 里就是「缺少执行器「node-red」」）
  FAIL 预检把 executor:node-red 列为已满足能力
  FAIL 预检本身仍然通过（同一句「缺少执行器「node-red」」）
  FAIL ★ 场景预检的清单装配从单例拿到 node-red
  → 11/17 通过（§1 四条负控 + §3 三条回归 + §2 两条非注册相关 + §5 两条 全绿）
```

**第 2、3 条（负控 / 回归）在变异下仍绿** —— 卡上要求的解耦成立：它们验的是另外两件事，
不依赖修法。**且这是有预期的**（变异前我写下的预测就是 6 红 11 绿，实际逐条对上）。

**变异 #2（反向：改成 `true || workflowEngineUsable(...)` 无条件注册）** —— 证明负控有牙：

```
  FAIL ★ 端口未注入时单例不含 node-red（fail-closed）
  FAIL ★ 引擎 stopped 时单例不含 node-red
  FAIL ★ running 但端口为 null 时不含 node-red
  → 14/17 通过（正控与消费方正控仍绿 —— 它们不区分「无条件」与「条件成立」）
```

**还原**：两次变异后都 `cp` 回 pristine + `sha256sum -c` + `cmp -s` → 均 `BYTE-IDENTICAL`。
变异后先 `git diff` 确认改动落盘（`grep` 到变异后的 `if (workflowEngineUsable(...))` /
`true || workflowEngineUsable(...)`）才跑套件。

### 6. 既有套件（不回归）

| 套件 | 结果 |
|---|---|
| `workflow-engine-selection-smoke` | **16/16 通过** |
| `workflow-engine-runtime-smoke` | **114/114 通过**（六段小计 24/37/44/83/94/114） |
| `execution-engine-smoke` | **63 checks PASS**（EXIT=0） |
| `module-workflow-smoke` | **38 passed, 0 failed (native-open)** + save-guard 3/3 |
| `orchestration-ipc-smoke` | **433/433 通过** |
| `scene-preflight-smoke` | **17/17 通过** |
| `workflow-extension-seams-smoke` | **12/12 通过**（它读 `executionEngine.ts` 源码文本，确认 `register` 缝与「无 `kind ===` 分支」判据没被修法破坏） |
| `capability-smoke` + `executor-registry-guard-smoke` | **2 pass, 0 fail** |
| `module-phase2-e2e-smoke` | **红 —— 与本卡无关**，见下 |

**`module-phase2-e2e-smoke` 红的归因（做了对照实验，不是猜的）**：

```bash
$ pnpm test:smoke module-phase2-e2e-smoke          → EXIT=1，红在 native-window
$ git stash push -u -- apps/desktop/src/main/orchestration/executionEngine.ts
$ pnpm test:smoke module-phase2-e2e-smoke          → EXIT=1，红在**同一条**断言（native-window）
$ git stash pop                                     → 逐字节还原
```

撤掉我的改动照样红。真因两条，都已落盘、与 W4 无关：
1. `901e58ee feat(F006)` 给 `window.api.modules` 加了 `installVsix`，而
   `native-main.ts:125` 的 `deepEqual` 白名单还是旧的 12 项 —— **F006 没更新这张清单**；
2. `native-window` 报 `No handler registered for 'workflowEngine:list'` —— 该套件
   `native-main.ts` 只 `registerModuleHandlers` + `registerWorkflowHandlers`，**从未注册**
   `registerWorkflowEngineHandlers`。

**该套件的白名单断言属 F006 的边界，不在本卡写边界内，我没有改**（见 §8）。

**tsc**：`packages/contracts` EXIT=0、`apps/desktop` EXIT=0（恢复态，2026-10-24 晚）。
**未跑全量**（卡上要求 + 另有三个总控并行）。

### 7. 卡上写错的地方

1. **「`scenePreflight.ts:75` → 预检说「缺执行器」」—— 这句不准确。** `SceneCapabilityRef.kind`
   只有 `plugin/skill/mcp/module`（`packages/contracts/src/sceneSpec.ts:46`），**场景预检
   根本不探执行器**。它受影响的只是**装配**的 `executorKinds` 清单（`scenePreflight.ts:75`
   那一行）：清单里少了 `executor:node-red`，但 `sceneCapabilityPreflight` 永远不按
   `executor` 查。**用户可见的假失败只在自动化预检**（`ipc/orchestration.ts:396` →
   `requirementsForNode(..., executorKinds)` → `checkNodeCapabilities`)。
   两处都改了是「同一份错误数据喂了两个消费方」，但只有一处会把它变成用户可见的一句话。
   我把两处都核了（§4），但断言强度不同 —— 自动化那边是端到端，场景那边是清单装配。
2. **「候选 C：改 `index.ts` 的装配顺序（端口先注入，再 import 引擎）」—— 这条候选在
   ESM 下不成立。** `import` 声明先于所有顶层语句执行（hoisted），`index.ts:46` 的
   `import { setWorkflowEngineStatusPort }` 必然触发 `executionEngine.ts` 模块体
   （含 `:280` 的构造），`index.ts:86` 的调用永远在构造之后。**即便 `index.ts` 可改，
   把 `:86` 挪到 `:46` 之前也没用** —— 这是「不是不建议，是做不到」。
3. **「`execution-engine-smoke` 会因修法变红」的隐含风险 —— 实测没有。** 该套件用
   `createBuiltinExecutionEngine()` 在每次 `setWorkflowEngineStatusPort(...)` 之后新建引擎
   来验条件注册，按次构造的引擎行为完全不变（构造时端口已就位，`settleDeferred` 第一次
   观察就注册）。63 checks 全过。
4. **套件名里的「registry-order」有点名过其实**：它验的是**判据时机**（构造 vs 观察），
   不是注册表的顺序。但卡名如此，保持可搜索。

### 8. 我觉得不对、但没改的

1. **`module-phase2-e2e-smoke/native-main.ts:125` 的白名单已经过期**（F006 加 `installVsix`
   没更新它）。不属本卡边界，但它现在是一条**恒红**的断言 —— 会让下一个人误以为是自己的
   改动坏了。建议 F006 或总控另开一条修。
2. **`module-phase2-e2e-smoke` 的 native 探针从不注册 `workflowEngine` handler** ——
   它在启动时会误打一条 `No handler registered for 'workflowEngine:list'`（来自
    AutomationRunner？或者渲染端某处）。同理不属本卡。
3. **`execution-engine-smoke/run.sh` 与 `orchestration-ipc-smoke/run.sh`、
   `scene-preflight-smoke/run.sh` 的 `source` 路径写法不一致**：前者的
   `source "$(dirname "$0")/../lib/esbuild-path.sh"` 只在 `cwd=apps/desktop` 时对
   （`dirname` 是相对路径），而后者用同样的写法 —— 从仓库根 `bash apps/desktop/scripts/x/run.sh`
   会报 `No such file or directory`。**这三个套件必须从 `apps/desktop` 或经
   `pnpm test:smoke` 调用**。我新建的套件用了 `source "scripts/lib/esbuild-path.sh"`
   （与 `workflow-engine-*-smoke` 一致，只支持 cwd=apps/desktop），**没有**去统一其它套件
   （超出写边界，且统一会动别人的文件）。
4. **`registerWhenAvailable` 的 `settleDeferred` 在每次 `kinds()` 都遍历队列** —— 当前只有
   一个延迟执行器，代价可忽略；若将来延迟注册变多，可加一个「已全部落定」的短路。**这是
   性能备注，不是缺陷**，`deferred.size === 0` 时直接 return 已有。
5. **W0 探针 `.tmp/w0/executor-registry-order-probe.ts` 里注释的 `runner.ts:2039`** ——
   实际 `runEngine` 在 `runner.ts:2039`（本卡阅读时是这一行），但旁边也有 `runner.ts:2428`
   的 `runEngine.kinds()`（能力清单）。两个都是真的，注释只提了一个，不算错。

