# T8 —— Node-RED 原生画布真实 Electron U1（`t8-node-red-u1`）

跑**真 Electron**、用**真 Node-RED 5.0.8**（仓库 `node-red/` vendor checkout）画布，
走完「加载 → 编辑 → Deploy → 重开」并复核 T2/T3/T4 的三项成果。证据落在
`<repo>/.tmp/electron-u1/<时间戳>/`（永不自动清理）。

```bash
cd apps/desktop
node scripts/t8-node-red-u1/run.mjs              # 正常跑：期望退出码 1（见下）
node scripts/t8-node-red-u1/run.mjs --mutation   # 变异跑：期望 0（断言被旁路后故意失败变绿）
bash scripts/t8-node-red-u1/negative-control.sh  # 负控：期望 PASS（正式旅程按预期变红）
```

## 退出码（沿用 T16 三档语义）

| 码 | 含义 | 何时出现 |
|---|---|---|
| **0** | 全部旅程按声明通过 | 只在 `--mutation` 跑里应出现 |
| **1** | 唯一失败的是 `expect:"fail"` 旅程，且形态符合预期 | **正常跑**（注册表里有骨架自检旅程） |
| **2** | 出现非预期失败（真正的坏消息） | 正式旅程红了 / 骨架崩了 |

`run.mjs` 把「1」翻译成 `T8: PASS` 并以 0 退出；负控/变异各自核对目标退出码。

## 旅程

| 旅程 | 内容 |
|---|---|
| `node-red-canvas-load-edit-deploy-reopen` | 正式旅程，20 步，跨 **2 个真 OS 进程**（relaunch） |
| `node-red-deliberate-failure` | 骨架自检 + 变异翻转点：在真实画布上断言不可能存在的哨兵名 |

正式旅程的步骤（按序）：

1. `engine-running` —— 生产注册表 `launchSpec`（真 vendor 解析）→ 真子进程 running
2. `canvas-editor-ready` —— 生产 `documentView:open`（引擎凭据注入）+ 关掉首次启动的
   两层模态（更新通知同意框、欢迎导览）—— 它们真的会挡住画布输入
3. `production-load-entry` —— **事实证据**：生产 T59 装载入口对本夹具拒绝（见下）
4. `canvas-import-fixture` —— 编辑器自己的「导入」对话框：真点 textarea + 真 `Ctrl+V`
5. `canvas-renders-fixture` —— 真实画布上出现 tab + 3 个节点（`inject` + `mcode-agent` ×2）
6. 截图 `canvas-loaded.png`
7. `baseline-deploy` —— 真点部署按钮，让磁盘上的 `flows.json` 成为**改名之前**的版本
8. `rename-node-via-tray` —— 节点编辑托盘（`RED.editor.edit`，即双击处理器）→ 真点
   名称框 → `Ctrl+A` → `insertText` → 真点「完成」
9. `canvas-label-shows-rename` —— 画布标签同步
10. 截图 `canvas-edited.png`
11. `deploy-wrote-native-flows` —— 再点部署；**字节对比**：`beforeSha ≠ afterSha`，
    新字节里节点名 = 新名字、instruction 原样
12. `library-mirror-reconciliation`（T2）—— 读 `deploy-reconciliation.json`
13. `trigger-single-ownership`（T3）—— 启动生产旧自动化执行器读事实表
14. `cross-process-owner-cas`（T4）—— 起**真 OS 子进程**抢同一 flowId
15. `relaunch-after-deploy` —— 换进程
16. `reopen-canvas-shows-rename` / `reopen-dom-label` —— 新进程画布仍显示新名字
17. `reopen-flows-bytes-unchanged` —— `flows.json` 与 Deploy 后**逐字节一致**
18. `reopen-ownership-and-ledger` —— 重启后 owner 仍只有 node-red、账本仍无 pending
19. 截图 `canvas-reopened-final.png`

## 装配的是生产代码（与生产 `ipc/index.ts` 的差异只有隔离项）

- `ProductionWorkflowEngineRegistry` + 真 `createEngineLaunchSpec` + 真 vendor 解析
  （把 `process.resourcesPath` 指向一棵只含 `node-red` junction 的临时 resources 根，
  链回仓库 vendor）；没有手拼 NODE_PATH；
- `DocumentViewHost` 单例 + `registerDocumentViewHandlers` + 生产
  `DocumentViewCredentialBroker`（令牌只在主进程里，经 `onBeforeSendHeaders` 按
  webContentsId + 回环 origin 注入）；
- `loadWorkflowIntoNative`（生产 `workflowEngine.load` 的执行体）；
- `automationRunner`（生产旧自动化执行器）与 `FileExecutorOwnershipStore`（T4 的 store）。

构建期只做两件与生产发行构建同源的替换：
`@main/window.js` → `window-holder.ts`（避开语音原生模块），GenOffice vendor →
仓库自带的 fail-closed stub（Node-RED 判据不涉及 GenOffice）。

## 如实边界（不是「通过」的部分）

1. **生产装载入口对任何可保存图都拒绝**。`loadWorkflowIntoNative` 对
   `mcode.trigger` 必报 lossy、`mcode.main` 必报 human-decision、`mcode.agent`
   必报产出契约 lossy；而 `saveWorkflow` 要求自动化必须有触发器、普通图必须有
   `mcode.main`。两端叠加＝**没有任何库文档能通过装载入口进入原生画布**。旅程把
   这条记为 `production-load-entry` 的证据（`known-lossy-refusal`），画布放入改用
   编辑器自己的 Import 手势。缺陷单开卡。
2. **Import 手势会剥掉 `x-mcode`**。上游编辑器只导出 `_def.defaults` 里声明的键
   （Node-RED 5.0.8 的 `RED.nodes.createCompleteNodeSet` / `convertNode`），Mcode 节点
   包没有在 `defaults` 里声明 `x-mcode`。于是经导入进入画布的图**丢失全部 Mcode
   身份**：落盘后 `tab` 不带 `x-mcode.docId`，引擎按 `@node-red-native:<tabId>` 认领，
   Deploy 后的库镜像对账**如实为空**（`library-mirror-reconciliation` 断言的就是这个
   事实，而不是伪造 pending）。缺陷单开卡。
3. **不是安装包形态**：跑的是本仓 `out` 同源的构建产物 + 真 vendor 源码树 + 生产
   preload 源码，没有跑 electron-builder 安装包。
4. 画布手势边界：`sendInputEvent` 的 `clickCount:2` 不满足 Node-RED 的
   `dblClickPrimed` 判据（需要两次真实 mousedown 间隔 < 650ms），所以「进入编辑」
   调节点双击处理器里的 `RED.editor.edit(node)`；托盘里的改名/完成仍是真鼠标真键盘。
   截图与 DOM 证明托盘真的开着。

## 零新依赖

只使用仓库已装的 Electron 44.4.5 与 esbuild。不引入 Playwright。
