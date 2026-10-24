# W5｜`baseline-deploy` 测的不是部署

- Status: ready-for-agent
- Category: **验收缺陷（Node-RED U1）**
- Priority: **P1 —— 一条绿着的断言掩盖了一个真的「部署失败」**
- Depends on: W0（G4）
- Exclusive writable files:
  - `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`
  - `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`（若需辅助函数）

## Required Skills
- `mcode-smoke`：U1 套件的判据写法。
- `diagnosing-bugs`：区分「步骤成功」和「系统正确」。

## 缺陷

旅程里 `baseline-deploy` 这一步的判据是：

```ts
ok: deploy.clicked && baselineSha !== null && agent?.["name"] === "检查 README"
```

**它验的三件事**：
1. `deploy.clicked` —— 按钮**点到了**（不是部署成功）；
2. `baselineSha !== null` —— `flows.json` **存在**；
3. `agent.name === "检查 README"` —— 文件里**有那个节点名**。

**没有一件能证明「部署成功」。**

W0 实测到一个关键事实：

> 截图里 **「部署失败：服务器没有响应」是真的**，而 `baseline-deploy` 仍然 PASS——
> 它只断言 `flows.json` 里有那个节点名，**而那份文件是更早的 load 写进去的**，
> 点部署成不成功完全不影响这步。

**所以有一条绿着的断言，掩盖了一个真实的部署失败。**

## 任务

### 一、先确认「部署成功」到底该看什么

**不要凭猜。** 查 Node-RED 部署的完成信号：

1. **网络层**：部署是一次 `POST /flows`（或 `/flow`）。**响应是 200 还是超时？**
2. **事件层**：编辑器有没有 `RED.events` 的部署成功/失败事件？
3. **DOM 层**：部署按钮的成功/失败状态是什么（`#red-ui-notifications` 里的那条通知？）

**三个都要查，写进回写。** 至少要知道：
- **「服务器没有响应」这条通知，在什么条件下出现**；
- **它出现时，`flows.json` 是否仍然被写**（如果是，那正说明当前断言测错了）。

### 二、把断言改成真的验「部署成功」

**必须区分两种情况**：

| 情况 | 断言该是什么 |
|---|---|
| **部署真的成功** | 有成功信号（网络 200 / 事件 / 没有失败通知）**且** `flows.json` 内容正确 |
| **部署失败** | 断言**必须红**，并把失败原因写进 `detail` |

**关键**：现在的断言在「失败」时也绿。改完之后，**失败必须红**。

### 三、如果部署确实是坏的，那是另一张卡

**你这一步只负责「让断言能看见失败」**，不负责修部署。

- 如果查下来部署**确实失败**（服务器没响应）：
  - **把断言改对**（让它红）；
  - **在回写里写清根因线索**（哪个端口、哪个进程、什么日志）；
  - **不要修产品代码** —— 那是另一张卡，我会开。
- 如果部署**其实成功**，只是有误导性通知：
  - 那就在回写里写清「那条通知是什么条件下出现的」，并让断言**同时覆盖这两种**。

### 四、变异验证

**把断言改成恒真** → 必须能说清它能抓什么。
**更重要的变异**：模拟一次部署失败（如果可能），确认断言**会红**。

## 验收判据

1. **断言不再只看 `flows.json` 有没有内容**；
2. **部署失败时断言会红**（有证据：要么模拟失败，要么指出真实失败并让它红）；
3. **部署成功时仍然绿**（不能矫枉过正变成恒红）；
4. **`rename-node-via-tray` 那条旧红不动**（那是另一件事）；
5. 不改产品代码；
6. 不跑全量。

## 边界

- 只改 `t8-node-red-u1/` 下的旅程与辅助函数；
- **不碰 `apps/desktop/src/**`**。

## 一个提醒

**这条缺陷最坏的地方不是「部署坏了」，是「没人知道它坏了」**——
一条绿着的断言让一个真失败看起来像成功。**改完之后，如果它开始红，那是对的产出，不是回归。**

## 补充（派活时由总控追加）：工作区里有一个**别人未提交的生成产物**，先读这段

`apps/desktop/src/main/workflowEngines/nodePackBundle.generated.ts` 现在是 `M` 状态
（`git status` 里），**改动来自另一个会话，不是你的**。我逐字节核过：

```
head bytes: 23667   work bytes: 23615   identical: false
first diff at 803
HEAD ... "// apps/desktop/src/main/workflowEngines/nodePackChildRuntime.ts"
WORK ... "// src/main/workflowEngines/nodePackChildRuntime.ts"
把 work 的 "// src/main/" 还原成 "// apps/desktop/src/main/" 之后：
normalized-identical: true
```

**结论：差异只有 4 处 esbuild 注释里的路径前缀，功能代码逐字节相同。**
成因是有人在 `apps/desktop/` 目录里跑了 `build/build-node-pack.cjs`（cwd 不同 → source 根不同）。

**这对你的影响**：`t8-node-red-u1` 装的是这个 bundle 里的 `mcode-agent` 节点。
如果套件红在 `mcode-agent` 相关的地方，**先确认是不是这个未提交产物造成的**，
用单文件回滚对照（`git stash push -u -- <该文件>` → 跑 → `git stash pop`）排除，
**不要顺手去改它，也不要提交它**。

## 一条取证细节（派活时由总控追加）

`baseline-deploy` 里有一段：

```ts
const wroteBaseline = await waitFor(async () => { ... }, 45_000);
...
void wroteBaseline;                 // ← 算完之后被丢了
ok: deploy.clicked && baselineSha !== null && agent?.["name"] === "检查 README"
```

**`wroteBaseline` 那个「等到文件里出现节点名」的结果根本没进 `ok`。**
所以即使 `waitFor` 超时拿到 `false`，这步照样绿。这是比卡面描述更硬的一条证据 ——
**你改断言时，`wroteBaseline` 必须真的参与判据**，或者删掉那段等待并说明为什么不需要。

## 回写

`tasks/workflow/W5-baseline-deploy-assertion.md` 末尾追加 `## 结果回写`：
三个信号层的查证、断言改成什么、部署到底是成功还是失败、变异结果。

---

## 结果回写（W5，2026-10-24）

### 一、结论先说

**部署在这条旅程里确实是失败的，而且失败原因是旅程自己的：** 装载入口
（`production-load-entry` → `loadWorkflowIntoNative`）会**停掉旧引擎、换一个端口重启**，
而编辑器视图不会自己换 URL —— 页面停在已关闭的旧端口上，点部署就是连一个死端口。
上游 `deploy.js:685` 对「连接被拒」（`xhr.status = 0` 且 `responseText` 为空）弹
`deploy.deployFailed` + `deploy.errors.noResponse`，也就是截图里那句
**「部署失败: 服务器没有响应」**。它就是真的。

**它出现时 `flows.json` 仍然「有那条节点名」** —— 因为那份文件是装载
（`nativeLibraryLoad.ts` 的 `replaceNativeCanvas`）写下的，跟这次点击没有任何因果关系。
这正是旧断言测错的地方。

**不是产品缺陷（至少这一条不是）：** 生产路径里「引擎换端口后重新打开视图」由渲染端
`EngineRuntimePanel` 的 `status.editorUrl` effect 负责（`apps/desktop/src/renderer/
components/settings/workflows/EngineRuntimePanel.tsx:197-303`：URL 变了就
`api.documentView.open` 重新导航）。旅程只在**装载之前**开过一次视图，之后没有那层。
所以本卡**没有改产品代码**；断言改成「如实红」，旅程要不要在装载后重新打开视图，
是另一张卡的事（见第五节）。

### 二、三个信号层的查证（全部来自 vendor 5.0.8 源码 + 本套件实跑证据）

| 层 | 上游事实 | 本套件实测（证据目录 `2026-10-24T12-47-24-761Z`） |
|---|---|---|
| **网络** | `@node-red/editor-client/src/js/ui/deploy.js` `save()`：`$.ajax({url:"flows", type:"POST", data: JSON.stringify({flows, rev})})`。成功 2xx（`admin/flows.js:62-66` 回 204/JSON）；**连接被拒时 jQuery 给 `status=0`、`responseText=""`**，走 `.fail` 的最后一个 `else`。引擎侧另有宿主中间件（`registry.ts:236-298`）——`POST /flows` 先做 ownership 握手，5 秒不回就 **423**「Host ownership response timed out」（有响应体，走的是 `responseText` 分支，不是「没有响应」）。 | `POST flows` **1 次，status 0，responseText ""**。不是 423 —— 请求根本没到引擎（端口已死）。P1 正控里同一条路径得到 **200** + `{"rev":"…"}`。 |
| **事件** | `deploy.js:674` 只在 `.done`（成功）里 `RED.events.emit("deploy")`。失败路径**没有任何事件**。 | 失败：`deployEvents: 0`；P1 成功：`deployEvents: 1`。 |
| **DOM** | `notifications.js` 的 `notify()` 生成 `#red-ui-notification-<n>`，class 带 `-success` / `-error`；**默认 5 秒后 `close()`**（`timeout||5000`，`notifications.js:284`），所以轮询会漏，必须 `MutationObserver` 在出现那一刻记下。成功文案 `deploy.successfulDeploy`＝「部署成功」；失败 `deploy.deployFailed`+`deploy.errors.noResponse`＝「部署失败: 服务器没有响应」。 | 失败：`red-ui-notification-error`「部署失败: 服务器没有响应」（另有 safeMode 警告与导入通知，均非 error）。P1 成功：`red-ui-notification-success`「部署成功」。 |

**「服务器没有响应」出现的条件（回答卡上的问题）**：`POST flows` 的 fail 回调里，
`status ≠ 401/409` **且 `xhr.responseText` 为空**。实践中就是「连接层失败」——
本套件首跑是**端口已死**（页面 9029 vs 引擎 8477）；P2 变异用「停掉引擎但端口不变」
复现了同一句通知（证明它不只由端口不一致触发）。**宿主 423 握手超时不会触发它**
（有响应体）。

**它出现时 `flows.json` 是否仍被写**：**不写。** 失败路径在 `deploy.js` 里只
`RED.nodes.dirty(true)` + 弹通知；`flows.json` 保持点击前字节（P2/交付态
`beforeSha === afterSha`）。**但文件里依然有基线节点名** —— 那是更早的装载写的。
所以「文件里有名字」在失败时也成立，旧断言因此恒绿。

### 三、断言改成了什么

文件：`apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`
（`baseline-deploy` 步）+ `editor-flow.ts`（新增三个页面内探针函数
`installDeployProbe` / `resetDeployProbe` / `readDeployProbe` 与纯函数
`deployRequestNames`）。

判据（缺一即红，`detail` 逐条点名哪一层失败）：

```ts
ok = deploy.clicked                 // 按钮真点到
  && responseOk                     // 网络：POST */flows 响应 2xx（失败/无响应在这里红）
  && deployEventSeen                // 事件：RED.events "deploy"（上游只在成功路径发）
  && failureNotices.length === 0    // DOM ：没有新出现的 error /「部署失败」通知
  && payloadHasBaseline             // 内容：请求体里的 flows 带基线名字「检查 README」
  && afterSha !== null
  && baselineNameOnDisk === baselineName; // 磁盘：事后仍在（兜底）
```

配套设计点：

1. **探针在点击前装好**（`installDeployProbe`）：包 `XMLHttpRequest.open/send`（记录
   method/url/status/responseText/**请求体**）与 `window.fetch`（只记录）；挂
   `RED.events.on("deploy")`；`MutationObserver` 盯 `#red-ui-notifications`。
   部署请求的识别口径是**方法+路径**（POST 且路径以 `/flows` 结尾），不把
   `flows/state`（启停）与 `/flow/<id>` 算成部署。
2. **只算「点击后新出现」的通知**：`resetDeployProbe` 记下点击前已存在的通知 id，
   `record()` 跳过它们 —— 旧残留（例如上一轮 safeMode 提示）不会污染判据。
3. **入口端口写进证据但不当独立判据**：`entry = { pageUrl, pagePort, enginePort,
   entryLive }` 原样落盘；失败时端口不一致会作为**根因线索**拼进 `detail`。
   没有把它单独放进 `ok`，因为「端口不一致」只是「服务器没有响应」的一种成因，
   判据要抓的是**部署结果**而不是成因。
4. **`wroteBaseline` 删了**：它等「文件里出现节点名」，而那件事在失败时也成立
   （上面已证）。换成上面这组因果判据。**没有保留任何「等文件变成 X」的等待** ——
   那个等待本身就是本卡缺陷的形态。
5. **不再对 `flows.json` 做字节判据**：成功部署会重写文件（P1 实测
   `beforeSha 19bac… → afterSha 3137…`），失败不改 —— 字节变不变都不是成败信号。
   所以磁盘层只保留「事后仍在且名字是基线的」兜底（它防的是「别的组件把基线覆盖了」
   这种独立故障）。

### 四、变异验证（三种，跑前写了预期）

**基线（改后、未变异）预期**：`baseline-deploy` 红；它之前 6 步全绿；`failedStep=baseline-deploy`。
**实测**：完全一致（退出码 2 属预期 —— 见第六节「包装器退出码」）。
证据：`2026-10-24T12-30-44-393Z`、`2026-10-24T12-45-11-028Z`、`2026-10-24T12-47-24-761Z`（三次独立跑，形态一致）。

| # | 变异 | 预期 | 实测 | 证明什么 |
|---|---|---|---|---|
| **M1** | `ok = true`（断言恒真） | `baseline-deploy` 由红变绿；旅程继续前进 | **PASS**，随后红在 `deploy-wrote-native-flows`（它自己交叉印证了「部署没写盘」：`before=after`、`deployed=false`） | 红**由断言产生**，不是崩溃/异常。且原有下游断言独立佐证了真实失败。 |
| **P1**（正控） | 临时在旅程里补「装载后像生产渲染端那样把视图重开到新端口 + `dirty(true)`」 | `baseline-deploy` **绿** | **PASS**：`entryLive=true`、`POST flows → 200`（`{"rev":"…"}`）、`deployEvents=1`、新通知「部署成功」、`flows.json` 被重写 | 断言**不会恒红**；成功路径上它真的能绿。（顺带发现：导航前必须 `dirty(false)`，否则 `deploy.js` 的 `beforeunload` 会取消 loadURL —— 证据 `2026-10-24T12-41-15-384Z` 的运行日志 `document view navigation failed`。） |
| **P2**（真实失败） | 在**活页面**上先 `harness.stopEngine()` 再点部署（端口一致、服务器死） | `baseline-deploy` 红，且红在网络层 | **红**：`entryLive=true`、`POST flows status 0 / responseText ""`、`deployEvents=0`、新通知「部署失败: 服务器没有响应」、磁盘未变 | 「服务器没有响应」的另一条产生路径也被抓住；判据不依赖「端口不一致」这一种形态。 |

**变异后核对**：M1 第一次写坏（`const ok = true` 旁多留了一个 `failures` 声明导致
esbuild `X [ERROR] The symbol "failures" has already been declared`），**套件根本没跑**，
而 `run.mjs` 包装器把退出码 1 读成了「T8: PASS」—— 这是仓库里「打包期失败 ≠ 被测对象
失败」的又一个实例（见第六节）。修正后那次（`2026-10-24T12-37-59-512Z`）才有效。
每次还原都用 `sha256sum -c` 逐字节核对过（备份路径保留目录结构，避免仓库里
`modules.ts` 撞名的老坑）。

### 五、部署到底成功还是失败 / 根因线索

- **本套件这条旅程：失败。** 直接原因：编辑器页停在**已关闭的旧端口**。
  - 日志（`run-g1.log`，`2026-10-24T12-47-24-761Z`）：`ready on 127.0.0.1:9029` →
    （装载）`stopped` → `ready on 127.0.0.1:8477`；证据里 `pagePort: 9029`、
    `enginePort: 8477`。
  - 端口每次运行不同（随机回环端口：1352/4433、12347/4452、1326/7782、9029/8477…），
    所以这不是「某一次偶发」。
- **这次失败里没有宿主 423 握手参与**：`status=0` 说明请求没到引擎。宿主中间件
  （`registry.ts:236-298`）只在请求到达时才会做 ownership 握手（5 秒超时 → 423）。
  W0 记录里「T27 之后 `loadWorkflowIntoNative` 重启引擎导致的 ownership 恢复时序」
  是一条假设，**本卡没有验证它**；本卡验证到的是更前一步：请求根本没发到活着的引擎。
- **生产里同一操作是否也会失败？** 本卡**没在真实产品 UI 里验证**。代码对照：
  `EngineRuntimePanel` 的 effect 依赖 `status.editorUrl`，URL 变（端口变）就会
  `api.documentView.open`（宿主对同 docId 换 URL 会 `navigate`，
  `documentViewHost.ts:602-611`），所以生产里大概率会跟着换；但「装载完成 → 渲染端
  重读 status → 视图导航」这条链**没有端到端证据**。这是下一张卡的事，不是本卡结论。
- **旅程层面的处置建议（不在本卡范围）**：`production-load-entry` 之后加一步
  「像渲染端一样重开视图到新端口」，或在 setup 里先装载再开视图。P1 已经证明这条路
  **可行**（绿），但会改变后续步骤的语义（`library-mirror-reconciliation` 的
  `payloadHasMcodeTabs` 在重载后变 true —— P1 那次红在它上面），需要单独设计。

### 六、卡上写错 / 不完全对的地方

1. **「`flows.json` 是更早的 load 写进去的」——对，但卡没说 load 会重启引擎换端口。**
   这是「服务器没有响应」的直接成因，也是为什么这条失败**每次跑都出现**而不偶发。
2. **「`wroteBaseline` 超时拿到 `false`，这步照样绿」——字面不对。** 那段
   `waitFor` 在**旧断言下也会返回 `true`**（文件里本来就有那个名字），所以它不是
   「超时被吞」，而是**从点击那一刻起就不可能为假**。更硬的表述是：那个等待
   测的量在失败时也成立，它没有判别力。
3. **「部署失败时断言必须红，并把失败原因写进 `detail`」——已做到，但 `detail`
   的中文在证据 JSON 里是 mojibake**（控制台代码页；`journey-result.json` 里存的是
   GBK 字节被当 UTF-8 读的结果）。这是套件既有的编码问题，不是本卡引入的；
   `detail` 在内存/日志里是对的（`unicode_escape` 解出来可读）。**没有修**（超出
   本卡边界，也不影响判据）。
4. **包装器的退出码有个假绿面**：`run.mjs` 把子进程退出码 **1** 当作「期望 1 → PASS」，
   而 esbuild 构建失败时 `build.mjs` 恰好也退 1 —— **构建失败会被读成「T8: PASS」**。
   本卡 M1 第一次就撞上了。这是 `run.mjs` 的缺陷（**不在本卡可写文件内，没改**），
   建议另开卡：构建失败应退非 0/1 的专门码，或包装器核对 `journey-result.json` 存在。

### 七、我没验证到的部分（如实）

- **没在真实产品 UI 里点过部署**：本次全部证据来自 t8 U1 探针装配（生产主进程代码 +
  真 Electron + 真 Node-RED），不是打包后的产品窗口。生产渲染端的「editorUrl 变了
  重新 open」那条 effect 我没有在运行中的应用里观察过。
- **没修部署、没改产品代码**（按卡要求）：`apps/desktop/src/**` 零改动。
- **没验宿主 423 握手超时**（`registry.ts:265` 那条「Host ownership response timed
  out」）：本套件里请求根本到不了引擎，构造「到了但父进程 5 秒不回」需要单独注入，
  本卡没做。所以「423 时不弹没有响应」是从源码读出来的，不是实测。
- **`rename-node-via-tray` 的旧红没动**（按卡要求）。有意思的是：本卡三次运行里它
  有时绿（`12-37-59-512Z` 变异跑、P1 后两次 `12-42-47-019Z`/`12-46-28-926Z`）—— 因为通知条（safeMode 警告）有时
  不在或不在名称框上面。这是那个已知缺陷的随机面，不是本卡造成的，也没修。
- **没跑全量**（按卡要求）。只跑了 `--only=node-red-canvas-load-edit-deploy-reopen`，
  **共 10 次运行：9 次有 journey-result（改前基线 1、改后基线 3、M1 有效 1、
  P1 3（首次因导航被 beforeunload 取消而未生效、后两次有效）、P2 1），
  另 1 次 M1 首版构建失败、没跑成**（见第四节末尾）。
- **`library-mirror-reconciliation` 在 P1 下变红**（`payloadHasMcodeTabs: true`，
  因为重载后导入的 tab 可能带了 `x-mcode`）。这不是本卡的判据，也没有深究 ——
  如果下一张卡要加「装载后重开视图」，得先弄清这一点。

### 八、改了哪些文件

- `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`
  —— `baseline-deploy` 步重写（判据 + 证据 + detail）。
- `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`
  —— 新增 `installDeployProbe` / `resetDeployProbe` / `readDeployProbe` /
  `deployRequestNames`（文件末尾，W5 段落）。
- **未提交**，留工作区。未碰 `apps/desktop/src/**`。

