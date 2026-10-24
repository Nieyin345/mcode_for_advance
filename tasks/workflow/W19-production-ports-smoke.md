# W19｜六个节点的「生产实现」没有任何套件覆盖 —— 393 条验的是桩

- Status: **delivered（回写已追加；改动未提交，见 `## 结果回写`）**
- Category: **验收缺陷（覆盖假象）**
- Priority: **P1 —— 它是 W16「六个节点都能跑」这个结论的最大漏洞**
- Depends on: W8（§6 第 1 条）
- 来源：W8 主动报告

## Required Skills
- `mcode-smoke`：无头主进程套件。
- `codebase-design`：判断哪些行为「能在无头环境里验」，哪些必须换桩。

## 缺陷（W8 发现，我核实过）

`mcode-node-pack-smoke` 有 **393 条断言全绿**，其中「真引擎段」确实起了真 Node-RED。
但它在 `scripts/mcode-node-pack-smoke/productionPortsStub.ts` 里**替换掉了生产端口**：

```ts
/* The existing node-pack smoke supplies fake ports in Node-RED; never
 * initialize real Mcode SDKs/ModuleHost in a headless test host. */
export function productionNodePackServices(): NodePackHostServices {
  return {
    execute: async () => { throw new Error("Node-pack smoke has no real Mcode approval session"); },
    subscribe: () => { throw new Error("Node-pack smoke has no real Mcode event source"); },
  };
}
```

**所以这 393 条证明的是「节点的外壳与 Node-RED 的接线」，不是「生产端口的行为」。**

### 这意味着什么

`nodePackProductionPorts.ts`（201 行）里这些**从来没被任何套件执行过**：

| 生产逻辑 | 行号 | 风险 |
|---|---|---|
| `chooseBranch` 的**真人弹窗** | `:110-124` | 弹窗按钮文案、`cancelId`、返回码映射全没验过 |
| `chooseBranch` 的**模型选路** | `:98-108` | 「非数字抛错」「越界抛错」这两条 fail-closed 没验过 |
| `node-red-call` 的**路径围栏** | `:155-162` | `..` / `?` / `#` / 超长 —— **这是安全边界** |
| `node-red-call` 的**部署审批** | `:165-177` | 非 GET 只许 `POST /flows` + 弹窗，没验过 |
| `module-capability` 的 **`projectPath` 强制** | `:137-139` | 缺了就抛，没验过 |
| `runSelectedSession` 的 **`sessionId` 强制** | `:35-40` | （W18 在修它，但同样没测试） |
| `trigger.subscribe` 的 **`triggerKind !== "event"` 拒绝** | `:188-190` | 没验过 |

**其中三条是安全边界**（路径围栏、部署审批、`projectPath` 授权）。
**「改坏了没人发现」的地方，恰好是「出错时拒绝」的地方** —— CLAUDE.md 第十五条。

## 任务

### 一、先分清：哪些能在无头环境里验，哪些不能

**不要一上来就写套件。** 先分类：

| 类别 | 例子 | 怎么验 |
|---|---|---|
| **纯函数/可注入** | 路径围栏（`startsWith("/") && !includes("..")`）、端口越界 | **直接调，最好把判据抽成导出函数** |
| **依赖 `electron.dialog`** | `chooseBranch` 的弹窗、部署审批 | **注入假 dialog**（`nodePackProductionPorts.ts` 里是 `await import("electron")`，看能不能换桩） |
| **依赖真 SDK / ModuleHost** | `runSelectedSession`、`module-capability` | **换桩**,但要断言「桩被调用时收到的 payload」 |
| **依赖真引擎进程** | `node-red-call` 的 `fetch` | **起真引擎**（`mcode-node-pack-smoke` 已经有这个能力）或注入假 `fetch` |

**把你分出来的表写进回写。** 如果某一类**确实验不了**，明说「验不了」+ 为什么 ——
**「验不了」比「验了个假的」好**（CLAUDE.md 第十二条：不冒充）。

### 二、优先验三条安全边界

**按这个顺序，三条都是 fail-closed 的拒绝分支：**

1. **`node-red-call` 的路径围栏**（`:155-162`）——
   `..`、`//`、`?`、`#`、超 256 字符、不以 `/` 开头，**六种都要有一条拒绝断言**；
2. **`node-red-call` 的部署审批**（`:165-177`）——
   非 `POST /flows` 的变更一律拒；`POST /flows` 时用户点 Deny 要抛；
3. **`module-capability` 的 `projectPath` 强制**（`:137-139`）——
   缺了抛，不能回退成默认目录。

**每条都要有正控**（合法的输入**通过**），否则判据退化成恒拒时全绿。

### 三、`chooseBranch` 的两条 fail-closed

```ts
if (!/^(0|[1-9][0-9]*)$/.test(choice)) throw Error("Model branch did not return a single numeric port");
if (port >= portCount) throw Error("Model branch port out of range");
```

**这两条是「模型输出不可信」的防线。** 要验：
- 模型返回 `"abc"` → 抛；
- 模型返回 `"5"` 而 `portCount = 3` → 抛；
- 模型返回 `"2"` 而 `portCount = 3` → **通过**（正控）。

## 验收判据

1. **「哪些能验、哪些不能」的分类表**（带理由）；
2. **三条安全边界各有拒绝 + 通过断言**；
3. **`chooseBranch` 的两条 fail-closed 有断言**；
4. **每一条拒绝断言都配一个正控** —— 否则「永远拒绝」也全绿；
5. **变异验证**：
   - 把路径围栏那段**删掉** → 拒绝断言必须红；
   - 把 `if (port >= portCount)` 改成 `if (false)` → 越界断言必须红；
   - **把某条拒绝改成恒 `true`** → 对应正控必须红（证明正控在验东西）；
6. `tsc` EXIT=0；
7. **不跑全量**；
8. **不改 `mcode-node-pack-smoke`**（新建独立套件）。

## 边界

**可以改：**

- 新建 `apps/desktop/scripts/mcode-node-pack-ports-smoke/`
- `apps/desktop/src/main/workflowEngines/nodePackProductionPorts.ts`
  （**仅在为了让判据可测而抽函数时**；行为不许变，抽完要能说清「抽出前后的行为等价」）

**不许碰：**

- `apps/desktop/scripts/mcode-node-pack-smoke/`（393 条，别人维护）
- `apps/desktop/src/main/workflowEngines/flowMigration.ts`（**W17 / W18 正在改**）
- `apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts`（同上）
- `apps/desktop/src/renderer/**`
- `tasks/T*.md`、`tasks/README.md`

**⚠️ 开工第一步**：`git status --porcelain apps/desktop/src/main/workflowEngines/`。
**如果 `flowMigration.ts` 或 `mcodeNodeTypes.ts` 有未提交改动，说明 W17/W18 在跑 ——
那只改 `nodePackProductionPorts.ts` 和新建套件目录，别碰那两个文件。**

## 回写

`tasks/workflow/W19-production-ports-smoke.md` 末尾追加 `## 结果回写`：

1. 分类表（能验 / 不能验 / 为什么）；
2. 三条安全边界的实测（每种拒绝 + 正控）；
3. `chooseBranch` fail-closed 的实测；
4. 三个变异各红在哪一条；
5. **你抽出来的函数，前后行为等价的依据**；
6. **你没能验证的东西**；
7. **W8 / 这张卡上写错的地方**。

## 一条判断标准

**这条缺陷的本质不是「没测」，是「393 条绿着的断言让人以为测了」。**

改完之后如果新套件只有 30 条，而 `mcode-node-pack-smoke` 是 393 条 —— **那是对的**，
因为它们验的是**两个不同的东西**：一个验节点外壳，一个验生产端口。
**在回写里把这条分界写清楚**，否则下一个人看到「393 vs 30」会以为新套件不够。

## 结果回写

**交付状态**：`mcode-node-pack-ports-smoke` 新建，**170/170 通过**；`mcode-node-pack-smoke`
未改动，复跑仍 **393/393**；双包 `tsc` EXIT=0。**`nodePackProductionPorts.ts` 零改动**
（无需抽函数——判据全部经公开的三条入口 `execute` / `subscribe` 可测）。
未 commit（按派活要求）。

### 1. 分类表：能验 / 不能验 / 为什么

| 生产逻辑 | 类别 | 能验？ | 怎么验 / 为什么不能 |
|---|---|---|---|
| `node-red.call` 路径围栏（`:155-162`） | 纯函数 | **能** | 经 `execute("node-red.call")` 直接驱动；假 `fetch` 记录调用，另断言「拒绝时 fetch 零次」 |
| `node-red.call` 部署审批（`:165-177`） | 依赖 `electron.dialog` | **能** | 记录型 `electron` 桩 + 可摆状态的 `@main/window.js` 桩；喂 response、逐条验按钮/cancelId/defaultId |
| `module-capability` 的 `projectPath` 强制（`:137-139`） | 依赖 ModuleHost | **能（验端口层）** | `@main/modules/service.js` 记录桩；断言「缺 projectPath 时桩零调用」+「带上时 `resource.projectPath` 原样到达」 |
| `chooseBranch` 模型选路（`:98-108`） | 依赖 SDK | **能（验端口层）** | RuntimeManager 桩可摆「正常/报错/中断/没有 turn.done/忙」五种演出；断言交给引擎的 prompt 原文 |
| `chooseBranch` 真人弹窗（`:110-124`） | 依赖 `electron.dialog` | **能** | 同部署审批；`response` 越界/-1/`portCount` 都按取消处理已验证 |
| `runSelectedSession` 的 `sessionId` 强制（`:35-40`） | 依赖真库 | **能** | **真** `SessionRepo`（sql.js + mktemp 数据根）；「不存在 / side / automation / provider 不支持」靠真查库拒绝 |
| `trigger.subscribe` 的 `triggerKind` 拒绝（`:188-190`） | 纯函数 + 事件源 | **能** | RuntimeManager 桩的 `emitEvent` 喂事件，验匹配过滤与退订 |
| 真人弹窗的**视觉/焦点/键盘** | 起真 Electron | **验不了** | 无头环境没有窗口系统；断言打到「弹给谁、按钮是什么、返回码怎么映射」为止 |
| 真三引擎 turn 生命周期 | 真 SDK | **验不了** | 换的是桩；验的是「端口交给引擎什么」，不是引擎本身（那几家各有自己的套件） |
| 真 Node-RED HTTP 往返与部署副作用 | 真引擎进程 | **验不了（本套）** | `fetch` 是注入的假实现；真往返在 `mcode-node-pack-smoke` / `node-red-e2e-smoke` 的真引擎段 |
| `Mcode Host project not found`（`:41-42`） | 依赖真库 | **验不了** | `sessions.project_id` 有外键 `REFERENCES projects(id) ON DELETE CASCADE`（`sessionSchema.ts:74`），构造不出「会话在、项目没了」的行；除非先删项目，但级联会连会话一起删 |

### 2. 三条安全边界的实测（每条拒绝都配正控）

**#1 路径围栏**（6 种拒绝 + 3 种边界正控）：
- 拒绝：不以 `/` 开头、`//` 开头、含 `..`、含 `?`、含 `#`、超 256 字符 —— 各一条断言，
  且每条都另断言「一次 fetch 都没发」（证明拒绝发生在围栏、不是下游）；
- 正控：合法 `GET /flows` 通过（URL / method 大写 / Bearer / 无 Content-Type / 无 body 各一条）、
  路径**恰好 256** 字符通过、`GET /settings` 不需要审批。

**#2 部署审批**（5 种拒绝 + 1 条放行正控 + 5 条弹窗形状）：
- 拒绝：`POST /flow`（少 s）、`PUT`/`PATCH`/`DELETE /flows`、`POST /settings` ——
  每种都断言「不弹框 + fetch 零次」；`POST /flows` 点 Deny 则「抛 + fetch 零次」；
- 无窗口 / 窗口已销毁 → fail-closed（连框都不弹）；
- 正控：`Allow once` 后请求真的发出，且弹窗按钮 `["Deny","Allow once"]`、`defaultId=0`、
  `cancelId=0`（**默认落在 Deny 上** —— 默认放行会是真缺陷）、`type=warning`、挂在主窗口。

**#3 `projectPath` 强制**（3 种拒绝 + 1 组透传正控）：
- 拒绝：缺失、空串、非字符串 —— 三种都断言「ModuleHost 一次都没被调」；
- 正控：带上时 `resource.projectPath` / `moduleId` / `contributionId` / `resource.path`
  原样到达，结果 JSON 成 text，两次调用的 `requestId` 互不相同。

### 3. `chooseBranch` 两条 fail-closed 的实测

- 非数字：`"abc"` / `"2.5"` / `"-1"` / `"03"` 四例全拒（`"03"` 被拒证明正则不是
  `parseInt` 式的宽松解析）；
- 越界：`"5"`（portCount=3）拒；**边界** `"3"`（portCount=3）也拒 —— 钉住 `>=` 而不是 `>`；
- 正控：`"2"`（带换行）→ port=2；`"0"`（portCount=1）→ port=0（下界合法）；
- 附带：portCount 0/13/2.5/字符串各拒；`decider` 缺省走真人、`"robot"` 拒；
  模型 prompt 里确实写了范围 `0..2` 和节点上下文/备注。

### 4. 三个变异各红在哪一条

**预期先写、正控负控分开列，实测与预期一致：**

| 变异 | 预期红 | 实测红 | 红的落在 |
|---|---|---|---|
| M1 删掉路径围栏 `if` 整段 | 12（6 拒绝 + 6 次「fetch 零次」） | **12**，精确同集 | 全是负控；正控和其余 158 条保持绿 |
| M2 `if (port >= portCount)` → `if (false)` | 2（`"5"` 与边界 `"3"`） | **2**，精确同集 | 全是负控 |
| M3 `if (!projectPath)` → `if (true)`（恒拒） | 正控侧红、3 条拒绝断言保持绿 | **9 红**：C 节 5 条正控 + requestId + 「ModuleHost 抛错」+ 两次合法 invoke；**3 条拒绝断言全绿** | 恒拒变异只有正控抓得住 —— 这就是正控在验东西的证明 |

M3 的附带发现：「ModuleHost 抛错 → 原样上抛」也红了，因为恒拒让桩的失败注入根本没走到。
**红得对**（它依赖正控路径先跑通），但也说明该断言自己不是恒拒的判据 —— 记账时不要把它
算进「拒绝断言」那一栏。

**变异方法**：`.tmp/w19-mutate.py`，从 pristine 备份重写后精确 `str.replace`，
`count != 1` 时**显式 exit 3**（不是 assert 静默退出）。M2 第一次就因缩进写成 8 空格而
`count=0` 退出 3 —— 这个形态被显性化了，没有误读成「跑了 0 红」。每次变异后先 `git diff`
确认改动在文件里再跑；还原后用 `sha256sum -c` 逐字节核对（三次全 OK）。
备份路径保留目录结构（`.tmp/w19-mutation/apps__desktop__src__main__workflowEngines__...bak`），
没用 basename。

### 5. 抽出来的函数，前后行为等价的依据

**没有抽函数。** 三条安全边界和 `chooseBranch` 两条 fail-closed 全部经生产入口
`productionNodePackServices(...).execute(...)` / `.subscribe(...)` 可测 —— 换的是
被调用的宿主依赖，不是被测代码。`nodePackProductionPorts.ts` 的 `git diff` 为空
（sha256 前后同为 `630827f4…`）。所以不需要论证「抽出前后等价」——**没抽**。

### 6. 我没能验证的东西

- **真人弹窗的视觉/焦点/键盘**（见分类表）；
- **真三引擎 turn 与真 ModuleHost 内部**——本套验到「端口交给它们什么」为止；
- **真 Node-RED HTTP 往返**——本套的 `fetch` 是假的；
- **`Mcode Host project not found`**——外键让它构造不出来（见分类表最后一行）；
- **`workflow.node.result` 事件带 `workflowId` 时真的送达渲染端**——本套只验到
  `emitExternal` 收到的事件对象；fan-out 是 RuntimeManager 的事，那有它自己的套件。

### 7. W8 / 这张卡上写错的地方

1. **行号漂移**：卡上 `chooseBranch` 模型选路写 `:98-108`，实际是 `:98-108` 附近的
   `:103-107` 两条 throw；`module-capability` 的 `projectPath` 写 `:137-139`，实际
   `:137-138`；`runSelectedSession` 写 `:35-40`，实际 `:35-36` 就一条。**内容全对，行号偏几行。**
2. **卡漏了一类**：`runSelectedSession` 的守卫远不止 `sessionId`——还有「kind 必须是 chat」、
   「provider 必须是三个原生引擎之一」、「prompt 空/超 30k」、「turn.done 必须是 end_turn」、
   「会话忙」、「输出超 256k」。这些**都没在卡的表里**，但都是 fail-closed 的拒绝分支，
   本套一并验了（B 节 16 条）。建议以后写卡时用「函数的每个出口」而不是「举几个例子」列。
3. **卡说「`nodePackProductionPorts.ts` 201 行」**：实测 201 行，对。
4. **卡第一节表格里「`node-red-call` 的 `fetch`——起真引擎或注入假 fetch」**：本套选注假
   fetch，因为真引擎往返归 `mcode-node-pack-smoke` 的真引擎段。这符合卡给的二选一。

### 8. 「393 vs 170」的分界（卡最后那条判断标准）

| | `mcode-node-pack-smoke`（393） | `mcode-node-pack-ports-smoke`（170） |
|---|---|---|
| 被测对象 | 节点外壳：节点注册、HTML、参数归一、`msg` 形状、Node-RED 接线、真引擎部署/执行 | **生产端口**：`productionNodePackServices` 的 6 个 operation |
| 生产端口 | **被替换成抛错的桩**（`productionPortsStub.ts`） | **保留真身** |
| 宿主依赖 | 真 Node-RED（装了才跑）；Mcode 侧全假 | 假 electron/window/RuntimeManager/ModuleHost；**真 SessionRepo/ProjectRepo** |
| 数量 | 393（真引擎段一条断言能带很多步骤） | 170（每条都是「某个出口拒绝/通过」的独立判据） |
| 三条安全边界 | **一条都没执行**（端口是桩） | **全部执行**，各配拒绝 + 正控 |

**两个数不一样是对的。** 393 不是「比 170 更全面」，是「验了另一个东西」。
下一个人看到这组数字，请先看这张表的两行「被测对象」，而不是比条数。
CARD_EOF
echo done