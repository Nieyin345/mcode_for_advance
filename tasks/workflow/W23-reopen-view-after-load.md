# W23｜U1 旅程装载后没重新打开视图 —— 它停在死端口上测部署

- Status: ready-for-agent
- Category: **测试环境保真度（不是产品缺陷）**
- Priority: **P1 —— 它让「部署」这条断言测的是一个连不上的页面**
- Depends on: W5（发现者）
- 来源：W5 的第五节

## 事实（W5 实测，根因链完整）

`production-load-entry` 调 `loadWorkflowIntoNative`，它会**停掉旧引擎、换端口重启**：

```
实测日志：ready 9029 → stopped → ready 8477
```

**而旅程的编辑器视图停在 9029（已关闭）。** 于是：

```
POST flows → xhr.status = 0, responseText = ""
  ↓
node-red/.../ui/deploy.js:684
  } else {
      RED.notify(RED._("deploy.deployFailed", { message: RED._("deploy.errors.noResponse") }), "error");
  }
  ↓
「部署失败: 服务器没有响应」
```

**产品路径没有这个问题**：`EngineRuntimePanel.tsx:197-303` 有那层 effect ——
`status.editorUrl` 变了就 `api.documentView.open` 重新导航。

**所以这是「测试环境的模拟不完整」，不是产品缺陷。** W5 没有改产品代码，是对的。

## 为什么这值得修

**因为「部署」这条断言现在测的是一个连不上的页面。**

W5 已经把 `baseline-deploy` 改成如实红，这是对的。**但一条永远红的断言，和一条永远绿的断言，问题是一样的** —— 都是「它不告诉你今天能不能部署」。

真机上用户点部署**是能成功的**（W2 已经证明了：`click-inject-button` 那步拿到
「部署成功」通知，`successCount: 2`）。**而 U1 套件里部署永远是红的。**

## 任务

### 一、在旅程里补上「装载后重新打开视图」

**照 `EngineRuntimePanel` 那层 effect 的行为做**（只读它，不改它）：

```
apps/desktop/src/renderer/components/settings/workflows/EngineRuntimePanel.tsx:197-303
  status.editorUrl 变了 → api.documentView.open({ docId, url, bounds, visible: true, ... })
```

**要求**：

1. 装载（`production-load-entry`）之后、点部署之前，**重新 open 一次视图**；
2. **新 URL 从哪来**：`workflowEngine.status()` 拿 `editorUrl`（W5 说生产就是这么做的）；
3. **不许硬编码端口** —— 端口是每次启动随机分配的；
4. 如果 `open` 失败，**明确报错**，不要静默继续（否则又变成「测一个连不上的页面」）。

### 二、改完之后 `baseline-deploy` 必须变绿

**这是本卡的验收判据，也是最容易搞错的地方。**

W5 的断言是「三层信号齐全」：

| 层 | 要求 |
|---|---|
| 网络 | `POST */flows` 2xx |
| 事件 | `deploy` 事件出现 |
| DOM | **没有新出现**的失败通知 |

**三层都要绿。** 如果改完之后只绿了一层（比如网络 200 但通知还是失败），
说明还有别的问题，**照实写进回写，不要为了让断言变绿去改断言**。

### 三、W5 留下的一个未解疑点

W5 报：

> P1 下 `library-mirror-reconciliation` 变红（`payloadHasMcodeTabs=true`），
> 加「重开视图」卡前需先弄清。

**先查清它。** 如果它是「装载 → 重开视图 → 再部署」这条新路径引入的新问题，
**在本卡里一起处理**，或者明确说清「它是独立问题，需要另一张卡」。

**不要绕过它。**

## 验收判据

1. **装载后视图真的重开了**（有断言：新 URL ≠ 旧 URL，且 `open` 返回 `ok: true`）；
2. **`baseline-deploy` 三层信号全绿**（网络 2xx + 事件 + 无新失败通知）；
3. **`library-mirror-reconciliation` 的疑点有结论**（解决 / 独立问题 / 为什么不是问题）；
4. **变异验证**：
   - 把「重新打开视图」那一步删掉 → `baseline-deploy` **必须回到红**，且红的原因和 W5 记录的一致（`status 0`）；
   - **这条变异是本卡的核心** —— 它证明「重开视图」真的是让部署成功的原因，不是巧合；
5. **W5 的其它断言不回归**（`rename-node-via-tray` 那条旧红不算）；
6. `tsc` EXIT=0；
7. **不跑全量**；
8. **不改 `apps/desktop/src/**`**。

## 边界

**可以改：**

- `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`
- `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`（只追加）
- `apps/desktop/scripts/t8-node-red-u1/` 下其它辅助文件

**不许碰：**

- `apps/desktop/scripts/t8-node-red-u1/run.mjs` / `build.mjs`（**W22 正在改**）
- `apps/desktop/src/**`
- `apps/desktop/scripts/mcode-node-pack-smoke/`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

**⚠️ 与 W22 的冲突**：W22 改 `run.mjs`，你改 `journeys/`。**不冲突，但如果它先交付，
你跑套件时会用到它改过的包装器 —— 那时候退出码可能不是 1 了，看清输出再判断。**

## 回写

`tasks/workflow/W23-reopen-view-after-load.md` 末尾追加 `## 结果回写`：

1. 重开视图怎么做的（贴关键代码）；
2. `baseline-deploy` 三层信号的实际值；
3. `library-mirror-reconciliation` 的结论；
4. **核心变异的实测**（删掉重开 → 红在哪、`status` 是多少）；
5. **你没能验证的东西**；
6. **W5 / 这张卡上写错的地方**。

## 一条判断标准

**「测试里永远红」和「测试里永远绿」是同一件事：它不再告诉你任何东西。**

W5 让这条断言从「永远绿」变成「永远红」，那是对的一步 —— **但它还不是终点**。
终点是：**真机能部署时它是绿的，真机不能部署时它是红的。**

## 总控补充（2026-10-24）：`library-mirror-reconciliation` 这个疑点，我先查了一半

W5 报「P1 下它变红（`payloadHasMcodeTabs=true`）」。我读了那条断言
（`journeys/node-red-canvas-load-edit-deploy-reopen.ts:443-458`），它的 `ok` 是四个条件的合取：

```ts
ok: ledger.pending.length === 0
  && ledger.lastError === undefined
  && (mirrorState?.pending ?? 0) === 0
  && owners.every((r) => r.owner === "node-red")
  && payloadHasMcodeTabs === false        // ← 这一项
```

`payloadHasMcodeTabs` = 「部署出去的 payload 里，tab 节点带不带 `x-mcode`」。
这一步自己的 `observed.note` 写着：

> 导入手势剥掉 `x-mcode`（上游编辑器只导出 `_def.defaults` 里的键），载荷因此没有
> Mcode 自有 tab —— 账本必须如实为空，库文档不被改写

**所以 W5 那个观察意味着「重开视图 → 部署成功后，payload 里反而带上了 `x-mcode`」。**

### 我的判断：**先别管它**

| 现象 | 属于 |
|---|---|
| `POST flows` 拿到 `status 0`（连死端口） | **本卡** |
| `payloadHasMcodeTabs=true` | **另一件事** —— 跟「视图开没开」无关，是**部署/导出手势**的问题 |

**做法**：先把「重开视图」做好、`POST flows` 拿到 200，**然后再看它红不红**。

- **变绿了** → 说明原来的红是「部署根本没发生」的副产物（payload 是从更早的装载里读的），
  **什么都不用做**；
- **还是红** → 那才是独立问题。**在回写里写清「它是独立问题」，不要在本卡修** ——
  修它要动导出手势，不在你的边界里。

**这条判断我没有实跑验证，是读代码推的。你按你的实测为准。**

---

## 总控补充（2026-10-24 23:30）：`workflow-ui-smoke` 现在红着，**不是你的**

**Office 主线在做 O5（OnlyOffice 全部删掉，走 GenOffice），分三批。**
批一已提交（`bd7c8cd5`，删了 `packages/contracts/src/ipc/onlyoffice.ts` -244 行），
批二/批三还在途 —— **所以 `FileEditor.tsx` 还在 import 已经删掉的契约导出。**
`workflow-ui-smoke` 要打包整个渲染端，因此**构建期就失败**。

**时间预期：2–4 小时**（Office 总控会主动通知批三完成）。

### 判别命令（我实测过，成立）

```bash
cd apps/desktop
node scripts/run-smokes.mjs workflow-ui-smoke > /tmp/o 2>&1; grep -c "isOnlyOffice\|onlyoffice" /tmp/o
```

- **> 0** → 是 Office 的（O5 在途），**别查了，别去做回滚对照**
- **= 0** → 是我们的，正常排查

**我实测：EXIT=1 且命中 2。**

> **⚠️ 取退出码时别用管道。** 官方给的原命令带 `|`，那会让 `$?` 变成 `grep` 的退出码
> （CLAUDE.md 第二十二条）。上面这版先重定向，安全。

**如果 `workflow-ui-smoke` 在你的必跑清单里：**照常跑，红了先用上面的命令判别，
在回写里注明「红在 O5 批一，已按判别命令确认」，**不要花时间做单文件回滚对照。**

---

## 结果回写（W23，2026-10-24）

### 一、重开视图怎么做的

新增旅程步骤 `reopen-view-after-load`，插在 `step.screenshot("canvas-loaded")` 之后、
`baseline-deploy` 之前。**只改了一个文件**（本旅程）；`editor-flow.ts` 没动 —— 复用了
已有的 `js` / `waitFor` / `waitEditorReady` / `dismissFirstRunOverlays` / `switchToTab`。

关键代码（`apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`）：

```ts
const beforeUrl = await js<string>(wc, `window.location.href`);
const beforePort = portOf(beforeUrl);
const enginePort = rt.harness.enginePort();            // ← 引擎此刻的监听端口（宿主状态，不硬编码）
const portChanged = enginePort !== null && beforePort !== null && beforePort !== enginePort;

if (portChanged) {
  // deploy.js:118 的 beforeunload 在 dirty 时 preventDefault，会取消 loadURL（W5 证据 12-41-15-384Z）
  await js(wc, `(RED.nodes.dirty(false), true)`);
  open = await rt.harness.openEngineEditor();          // ← 与生产渲染端同一个宿主 open（带 workflowEngineId 凭据）
  if (!open.ok) return { ok: false, detail: `装载后重新打开编辑器视图失败：${open.reason}…` };
  navigated = await waitFor(async () =>
    (await js<string>(wc, `window.location.href`)) !== beforeUrl, 45_000);   // 宿主导航是异步的，必须等真的离开
  if (!navigated) return { ok: false, detail: "open 返回 ok，但页面 45s 内没有离开旧 URL …" };
}
const ready = await waitEditorReady(wc, 60_000);
const overlays = await dismissFirstRunOverlays(wc);
const switched = await waitFor(async () => await switchToTab(wc, TAB_LABEL), 30_000);  // 新页面的 flows 是异步载入的
const rendered = await waitFor(async () => (await js<number>(wc, `...node-group...length`)) >= 3, 20_000);
if (portChanged) { await js(wc, `(RED.nodes.dirty(true), true)`); /* 断言部署按钮已启用 */ }
const live = afterPort !== null && enginePort !== null && afterPort === enginePort;
```

设计点（每条都对着卡上的要求）：

1. **不硬编码端口**：新 URL 来自 `harness.openEngineEditor()`，它读的是
   `registry.statusOf("node-red")` 的**当前** `port` —— 与生产 `toStatusView`
   （`ipc/workflowEngine.ts:96`：`editorUrl = http://127.0.0.1:${status.port}/`）同一来源。
2. **open 失败显式红**：不是「记一笔继续」—— 返回 `ok:false` 并点名原因。
   「open 返回 ok 但 URL 没变」也是一种失败（宿主 `navigate` 不等待 `loadURL`，
   `documentViewHost.ts:611/1929`）。
3. **dirty 的两处处理**（W5 的 P1 用 `dirty(false)` → 导航 → `dirty(true)`，本步照做）：
   导航前 `dirty(false)`，否则 `deploy.js:118` 的 `beforeunload` 取消 `loadURL`；
   之后 `dirty(true)`，因为重载后的页面是干净的（`workspace:dirty` 把部署按钮置灰，
   `save()` 第一行就 `return`）。**新增断言**：置 dirty 后部署按钮必须不再是 `disabled`
   （`deployButtonEnabled`），否则下一步会以「没有观察到 POST /flows 请求」的红出现 —— 离真因远。
4. **断言新 URL ≠ 旧 URL 且页面端口 == 引擎端口**（判据 1）：
   `beforePort=5627 → enginePort=12320 → afterPort=12320`，`urlChanged=true`，`open.ok=true`。

### 二、`baseline-deploy` 三层信号的实际值（证据 `2026-10-24T15-34-54-122Z`）

```
entry:   pageUrl http://127.0.0.1:12320/…  pagePort 12320  enginePort 12320  entryLive true
network: deployRequestCount 1  last {POST flows, status 200, responseText {"rev":"ccba3948…"}}  responseOk true
events:  deployEventSeen true  deployEvents 1
dom:     failureNotices []   successNoticeCount 1      ← 「部署成功」
payload: ok true  names [入口, 检查 README, 汇总]  hasBaseline true
disk:    beforeSha b4e4fb65… → afterSha ccba3948…      baselineName 检查 README
```

**三层全绿**（网络 2xx + `deploy` 事件 + 无新失败通知），且内容层/磁盘层也成立。
`ok=true`，本步 PASS。

### 三、`library-mirror-reconciliation` 的结论：**独立问题，不是重开视图引入的；根因是 T28**

**它仍然红，且只红在这一项**：`payloadHasMcodeTabs=true`。其余条件全绿：
`ledger.pending=[]`、`lastError` 缺省、`mirrorState.pending=0`、
`owners` 全是 `node-red`，镜像报告 `ok:true, docs[0].status="mirrored"`。

证据链（不是推测）：

1. **同一套件在 T28 之前是绿的，而导入手势没变。** 2026-10-23 UTC `05:03`/`05:06`
   两次 PASS 的 `library-mirror-reconciliation` 都是 `payloadHasMcodeTabs=false`。
   那时上游编辑器**丢弃** `x-mcode`（只导出 `_def.defaults` 声明过的键）。
2. **T28（`7ba94777`，2026-10-23 19:19 +0800）把这些键补进了 `_def.defaults`。**
   `mcodeNodePack.ts:121-166` 的 `tabMetaDefaultsScript()` 就地在
   `RED.nodes.getType("tab").defaults`（以及 inject/watch/switch/exec/function）
   上加 `"x-mcode": { value: undefined }`。
3. **上游的两条序列化路径都按 `_def.defaults` 抄键**
   （`nodes.js:1253 convertWorkspace` / `:1293 convertNode`：
   `for (var d in n._def.defaults) node[d] = n[d];`）。所以 T28 之后，
   编辑器 `createCompleteNodeSet()` 导出的 tab 上**必然**带着 `x-mcode` ——
   这正是 `POST flows` 请求体里的内容。
4. **本卡实测的部署产物**（run A 的 engine `flows.json`）：
   `tab x-mcode={docId, name, engine, trigger, builtin, updatedAt}`，
   三个节点也都带着 `x-mcode`。而 `payloadHasMcodeTabs` 的定义正是
   `type==="tab" && x-mcode !== undefined`。

**为什么 W5 的 P1 是第一个看到它的运行**：W5 的基线（`12:30`/`12:47`）部署根本没成功，
`deployRequests` 为空 → `payload` 无法产生 → 那一步最先死在别的条件上；P1 是
**第一次部署真的成功**，于是它成为第一个「payload 存在、且带 x-mcode」的样本。
**所以它是 T28 留下的、被 P1 首次照出来的问题，与「视图开没开」无关。**

**为什么不是「重开视图引入的」**：重开只改变**页面停在哪台引擎**；`x-mcode` 在 payload
里，是编辑器导出函数（`createCompleteNodeSet` → `convertWorkspace`）按 `_def.defaults`
产生的。这条路径与 URL 无关。本次实测的 run A（没有 P1 那层手工补丁、只有本卡新增的
重开步骤）与 P1 的形态逐项一致（payload 都带 `x-mcode` tab、镜像都 `mirrored`），
证明这不是某一次运行的偶发。

**这一步的 `observed.note` 现在是一句过期断言**（它说「导入手势剥掉 x-mcode」）——
T28 之后这不成立了。**我没有改它**：它属于这一步的断言/注释，而修它要么改断言、
要么改夹具/导入手势，都不在本卡边界内（卡：「修它要动导出手势，不在你的边界里」）。
**建议另开一张卡**处理：
- 判断「T28 之后 payload 带 x-mcode」是否本来就是**期望行为**（若是，断言应反过来，
  或改为断言 `x-mcode.docId` 与库文档一致）；
- 同一步里 `mirrorState` 报 `expectedRevision ≠ observedRevision` 但 `status: "mirrored"` ——
  这两个值的语义（镜像前 / 镜像后的 SQL 修订）需要确认，本卡没追。

### 四、核心变异的实测（本卡验收核心）

**变异**：把 `reopen-view-after-load` 那一步**整块删掉**（脚本按行边界删除 100 行；
备份路径保留目录结构 `apps__desktop__scripts__t8-node-red-u1__journeys/`；
先 `git diff` 确认该名字出现 0 次，再跑）。证据 `2026-10-24T15-39-27-549Z`。

**预测（写在跑之前，`.tmp/w23/prediction.txt`）**：只红 1 条且是同一条 —— `baseline-deploy`；
红因是 `status 0` / `responseText ""` / 无 deploy 事件 / 「服务器没有响应」；步骤列表少一项。

**实测（逐条对上）**：

```
steps: engine-running … canvas-renders-fixture, step-06-screenshot, baseline-deploy(FAIL)
       ← reopen-view-after-load 不存在（只剩 7 步 = 正式旅程 21 步的前 7 步）
entry:   pagePort 7144  ≠ enginePort 9802  entryLive false
network: POST flows status 0  responseText ""      ← W5 记录的同一形态
events:  deployEventSeen false  deployEvents 0
dom:     failureNotices [「部署失败: 服务器没有响应」(red-ui-notification-error)]
detail:  「部署请求未成功：HTTP 0（无响应体 …）（根因线索：编辑器页端口 7144 ≠ 引擎监听端口 9802 …）」
```

红在 `baseline-deploy`，`status` 是 **0**，红因与 W5 第五节**逐项一致**。
旅程在第一个 FAIL 停（`runner.ts:975`），所以 `deploy-wrote-native-flows` 不会跑 ——
这与预测的「只红 1 条」一致。**「重开视图」就是让部署成功的原因，不是巧合。**

**还原**：`sha256sum -c` 逐字节 OK（核心变异 1 次 + 观察探针 1 次，各核对一次）。

**观察探针（不是变异、不是修复，只为看后半段是否回归）**：把
`payloadHasMcodeTabs === false` 临时放行（只改这一处、标 `// W23 PROBE`），
跑一次得到 **`literal=PASS`，2 个 OS 进程（relaunch 真的跑到了）**，
**21 步全绿**（= 正式旅程全部步骤，含本卡新增的重开步骤），包括 `rename-node-via-tray`、
`deploy-wrote-native-flows`、`relaunch-after-deploy`、`reopen-canvas-shows-rename`、
`reopen-dom-label`、`reopen-flows-bytes-unchanged`、`reopen-ownership-and-ledger`。
**结论：重开视图这条新路径没有让任何 W5 时代的步骤回归**（判据 5）。
跑完立刻还原并 `sha256sum -c` 核对。

### 五、我没能验证的东西（如实）

- **没在真实产品 UI（打包后的应用窗口）里点过部署**。全部证据来自 t8 U1 探针装配
  （生产主进程代码 + 真 Electron + 真 Node-RED 5.0.8），不是产品窗口。
  `EngineRuntimePanel` 的 `status.editorUrl` effect 我读的是源码，
  **没有在运行中的应用里观察到它重新导航**。
- **没修 `library-mirror-reconciliation`**（不在边界内），只把它证明成独立问题。
  它现在仍红，因此 **`--only` 跑这条旅程的 `literalStatus` 仍是 FAIL**（红在那一步），
  包装器退 2（= 意外失败）。**这不是本卡引入的回归**：改前它也是红的、且红在同一步。
- **没验宿主 423 握手超时**（`registry.ts` 那段 `Host ownership response timed out`）——
  需要构造「请求到了但父进程 5 秒不回」，本卡没做。
- **没跑全量**（按卡要求）。只用了 `--only=node-red-canvas-load-edit-deploy-reopen`：
  3 次有效运行（改后基线 A `15-34-54`、核心变异 MUT `15-39-27`、观察探针 PROBE `15-40-38`），
  另有 1 次 tsc 被另一会话写了一半的 `genofficeNativeVendor.ts` 打断（那次套件未跑，
  75 秒后重跑 EXIT=0）。
- **没跑 `workflow-ui-smoke`**：本卡边界只碰 `t8-node-red-u1/`；按总控 23:30 的补充
  它红在 O5 批一（与本卡无关），也不在本卡必跑清单里。
- **`rename-node-via-tray` 的旧随机红**：本卡三次运行里 A 与 PROBE 都绿、
  MUT 没跑到它（停在前一步）。**不能说它被修好了** —— 它是已知的随机面，本卡没碰。

### 六、W5 / 这张卡上写错的地方

1. **W5 第五节把 `library-mirror-reconciliation` 的疑点归因到「重载后」**（「重载后导入的
   tab 可能带了 `x-mcode`」）。**真正的原因是 T28 的 `_def.defaults` 补丁，不是重载。**
   证据：T28 之前同一条导入路径 `payloadHasMcodeTabs=false`（2026-10-23 `05:03`/`05:06` 两次 PASS）；
   T28 之后上游导出必然带 `x-mcode`（`nodes.js:1253/1293` 只抄 `_def.defaults`）。
   P1 只是**第一个让部署成功的运行**，不是第一个触发这条差异的路径。
2. **W5 说「P1 那次红在它上面」**——对；但**没写 P1 是唯一一次部署成功**，
   容易被读成「正常绿的情况下它也会红」。实际是：**T28 之后任何一次成功的部署**都会让它红，
   与是否重开视图无关。本卡 run A 复现了同样的红，可以佐证。
3. **本卡「事实」节说装载会「停掉旧引擎、换端口重启」**——对，但没提
   **`production-load-entry` 现在返回 `ok: true`（真实装载成功）**，而不是头注释里
   仍描述的「所有可保存的图都会被拒绝（known-lossy-refusal）」。`editor-flow.ts` 的文件头
   和本旅程第 3 步的注释都与现状不符（T27 `5348bcbb` 之后装载不再拒绝可保存图；
   本卡实测 `decision: "loaded"`，`beforeNodes=0` → `afterNodes=3`）。
   **注释是过期断言，读起来却像事实** —— 建议下一张卡顺手更正（不在本卡边界：
   `editor-flow.ts` 只许追加）。
4. **本卡的「三层信号」表把「没有新出现的失败通知」列为第三层**——口径是对的
   （`resetDeployProbe` 会把点击前已存在的通知算作「旧」）；但要补一句：
   **重开视图会重新加载页面，旧通知随旧页面一起消失**，因此这一步的 DOM 层判的是
   **新页面**的通知 —— 这正是想要的，但值得写清。
5. **卡上没有写「重载后页面是干净的、部署按钮禁用」**。这是 W5 P1 用 `dirty(true)` 绕过、
   但没在卡上说明的一步。本卡把它做成了**显式断言**（`deployButtonEnabled`）并写进
   `observed`，下次谁再改这条路径时，红会点在「按钮没启用」而不是「没有请求」。
6. **本卡说「正常跑时子进程退 1、包装器退 0 并打印 T8: PASS；`--only` 时包装器仍退 1」**——
   与 W22 后的 `run.mjs` 现状不符：`--only` 跑单条时，若这条旅程 `literal=FAIL`，
   `build.mjs` 汇总为 `unexpected-failure` → 子进程退 **2** → 包装器透传 **2** 并打印
   `T8: FAIL（…2 = 意外失败）`，不是 PASS 也不退 1。本卡三次运行都是退 2（前两次）。
   只有观察探针那次（literal=PASS）子进程退 0、包装器退 1、打印 `T8: FAIL（期望 1…）`。
   **「看 `journey-result.json` 的 `literalStatus`」这条方法是本卡最可靠的一句**，
   执行时请以它为准。

### 七、改了哪些文件

- `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`
  —— 新增 `reopen-view-after-load` 步骤（约 100 行，含断言与证据）。
- **未改** `editor-flow.ts`（没有需要追加的 helper）、`run.mjs`、`build.mjs`、
  `apps/desktop/src/**`、其它套件。
- **未提交**，留工作区（按卡要求）。双包 `tsc --noEmit` **EXIT=0**（desktop 与 contracts 各一次）。

---

## 总控验收（2026-10-25 00:50）

**结论：通过。而且它和我修的一条过期断言合起来，让整个 U1 套件第一次全绿。**

### 我复现了什么

**W23 的核心变异它自己做了，我复现了结果**：

```
删掉 reopen-view-after-load 那 100 行
  → 只红 1 条 = baseline-deploy
  → status 0、responseText ""、deployEvents 0
  → 「部署失败: 服务器没有响应」
  → detail 点名端口 7144 ≠ 9802
```

**与 W5 记录逐项一致。** 这就是我要的：**红的原因是「视图停在死端口」，不是别的**。

### `library-mirror-reconciliation`：它查对了，我改了

W23 说这是「独立的 T28 问题，建议另开卡」。**我核实了它的证据链，成立**：

- T28（`7ba94777`，10-23 19:19）的提交信息原文：「Node-RED's editor serialises only
  keys declared in a type's `_def.defaults`, so Mcode's `x-mcode` sidecar vanished on
  export ... **declare `x-mcode` in the generated editor defaults**」
- `mcodeNodePack.ts:121-166` 确实把 `x-mcode` 加进了 defaults
- 上游 `nodes.js:1263` `for (var d in n._def.defaults)` —— **确实只抄 defaults**

**所以那条断言要求 `payloadHasMcodeTabs === false`，而 T28 的目的正是让它 `true`。**
**两条直接冲突，T28 赢了，于是那条断言从 10-23 起对任何一次成功部署恒假。**

**但它不是「独立的问题」，是一条死断言** —— 和「永远绿」一样不再告诉你任何东西。

**我改了它**（这条改动在我的权限内，它改的是套件不是产品代码）：

```ts
ok: ... && payloadHasMcodeTabs === true && sidecarDocId === FIXTURE_WORKFLOW_ID
```

**从「payload 不许有 x-mcode」改成「必须有，且 docId 指回本夹具那份库文档」。**
这样它同时守住两件事：① T28 的导出没有被上游剥掉（回归网）；② 关联回去的是**正确的那一份**。

### 改完之后：全量 U1 第一次全绿

```
node-red-canvas-load-edit-deploy-reopen: literal=PASS expectation=all-pass   ← 21 步
node-red-canvas-build-from-scratch:      literal=PASS expectation=all-pass
node-red-run-and-see-result:             literal=PASS expectation=all-pass
node-red-deliberate-failure:             literal=FAIL expectation=expected-failure

T8: 正常跑退出码 1（期望 1）
T8: PASS                     包装器 EXIT=0
```

### 你今天解决的这条链，回头看是一条完整的因果

| 卡 | 它发现/修好了什么 |
|---|---|
| W0 | 「部署失败：服务器没有响应是真的，但没人查根因」 |
| W5 | 断言测的不是部署（只验文件里有名字）；查清三个信号层 |
| W22 | 包装器把构建失败读成 PASS —— **所以之前没人看见这些红** |
| W23 | 真因：旅程停在死端口（装载换端口后没重开视图） |
| 我 | `library-mirror-reconciliation` 是 T28 之后的死断言 |

**四个环节缺一个都到不了「全绿」：**
- 没有 W22，构建失败会被读成 PASS，你会以为一直是绿的；
- 没有 W5，断言测的是别的东西，删掉重开那一步也不会红；
- 没有 W23，那条红永远在，而没人知道它指什么；
- 没有上面那条修正，`library-mirror-reconciliation` 永远红，而它是**误报**。

### 它没做的，我接受

- **没在产品窗口里验** —— 那是 W26 的事（真点设置页进画布）；
- **没跑全量** —— 我跑了，全绿。
