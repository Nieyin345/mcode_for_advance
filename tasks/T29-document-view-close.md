# T29｜`documentView:close` 对四个编辑器永远拒绝 —— 用户关不掉标签

- Status: ready-for-agent
- Category: **bug（P1，产品缺陷）**
- Priority: P1
- Depends on: T7（`77fdd012`，发现）、T23（`239eb863`，preload 构建）
- Exclusive writable files: `genoffice/apps/*/src/preload/`（或 Mcode 侧 preload）、`apps/desktop/src/main/document/documentViewHost.ts` 的关闭路径、新建回归套件。逐个确认后写进回写区。

## Required Skills
- `research`: 确认 Node-RED... 不，确认 GenOffice 上游四个 app 的 preload 结构，判断该怎么补。
- `mcode-smoke`: 建回归并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T7-genoffice-native-editors-u1.md` 的缺陷段、`apps/desktop/src/main/document/documentViewHost.ts`、`patches/genoffice/` 下与 preload 相关的补丁（尤其 0010）、`genoffice/apps/pdf/src/preload/`、`genoffice/apps/markdown/src/preload/`、`genoffice/apps/html/src/preload/`、`genoffice/apps/sheets/src/preload/`。

## T7 实测出的缺陷（原话）

> **P1，产品缺陷，建议单开卡**：`documentView:close` 对 pdf/markdown/html/sheets 永远拒绝
> —— 宿主发 `mcode:document-view:close-check`，但只有 Docs 的 preload 监听它；四家 vendor preload 零命中。
> 实测：各自返回 …

## 症状

用户打开 PDF / Markdown / HTML / Sheets，想关闭标签时**关不掉**。宿主发 `close-check` 等回应，2 秒超时后拒绝关闭。

T7 的旅程里绕过了这个：先断言拒绝行为，再用 `host.close` 强制关闭。**但真实用户没有这个后门。**

## 必须先查清的事

**这四个 app 的 preload 是谁的？**

- Docs 用的是 **Mcode 自己的 preload**（`documentViewPreload.ts`，T23 确保它进生产构建）
- pdf/markdown/html/sheets 用的是 **vendor 主进程提供的 preload**（`genoffice/apps/<app>/src/preload/index.ts`）

**关键判断**：这四个 app 的关闭语义是什么？

- PDF 的「关闭」是关页面还是关文档？
- Sheets 有未保存状态要检查吗？
- 它们有没有 `beforeunload` 或等价机制？

**先读源码搞清楚，再决定是补 preload 还是改宿主侧逻辑。**

## 两种可能的修法

**(A) 补四个 vendor preload** —— 让它们监听 `mcode:document-view:close-check` 并回应。
- 优点：语义一致
- 缺点：要改四个上游 app 的 preload（走 `patches/`），每个都可能有自己的关闭语义

**(B) 宿主侧不向这四家发 close-check** —— 因为它们本来就没有「关闭前确认」的概念。
- 优点：不改上游
- 缺点：如果它们确实有未保存状态，就绕过了检查

**选一个并论证。** 若选 A，走 `patches/` 追加补丁；若选 B，说明为什么这四家不需要关闭确认。

## 验收判据

1. 回写区给出：四个 app 各自的关闭语义（读源码得到，不是猜）。
2. 明确修法（A 或 B）与论证。
3. **用户能关闭** pdf/markdown/html/sheets 的标签（真 Electron 验证，复用 `apps/desktop/scripts/electron-u1/` 或 `t7-genoffice-u1/` 的骨架）。
4. 若有未保存状态，关闭前**确实**有确认（不静默丢改动）。
5. 变异验证：撤掉修复 → 关闭断言变红 → `cmp` 还原。
6. 双包 typecheck 通过。
7. T7 的六编辑器 U1 套件**不回归**。

## 边界

- 若走 A：**只加补丁，不改 `genoffice/` 源码直接编辑**（走 `patches/genoffice/`）。
- **不改** `documentViewPreload.ts`（T23 刚确保它进构建）。
- **不改** T2/T3/T4/T27/T28 的工作流文件。
- **不宣称 ARC-007 完成**。

## 结果回写（2026-10-23）

### 0. 一句话结论

选了 **(B) 宿主侧不向这四家发 close-check 探针**，但**不是**「不做检查」：宿主把这个
四家的关闭**转给 vendor 自己的 `request*Close`**（vendor 主进程的脏判断 + 保存/放弃/
取消弹窗 + 保存走 vendor 原来的写盘链）。四家**都有**未保存状态与关闭确认，只是确认
逻辑长在 vendor 主进程里，不在页面 preload 里 —— 所以既不能补 preload 探针（等于让
页面重造一份 vendor 已有的语义），也不能什么都不问（会静默丢改动）。

### 1. 四个 app 各自的实际关闭语义（实读源码，不是猜）

| app | 脏状态在哪 | 关闭守卫 | 关闭确认的实际行为 |
|---|---|---|---|
| **pdf** | `pdf-main.ts:705` `dirtyByWc: Set<number>`，页面 `App.tsx:1974` `pdfApi.setDirty(dirty)` 上报 | `requestPdfClose(contents, parent)`（`pdf-main.ts:992`） | 干净 → `true`；脏 → 系统弹窗 **保存 / 放弃 / 取消**；选保存 → `pdf:close-save-request` 让渲染端走它自己的保存链并等结果（失败/超时保持打开） |
| **markdown** | `markdown-main.ts:408` `dirtyByWc`，页面 `App.tsx:255/462/638` 上报 | `requestMarkdownClose`（`:477`） | 同上；选「放弃」还会清理未提交的旁挂资源（`discardPendingOwnedAssets`） |
| **html** | `html-main.ts:834` `dirtyByWc`，页面 `App.tsx:305` 上报 | `requestHtmlClose`（`:1011`） | 同 markdown |
| **sheets** | `sheets-main.ts` `pendingEditCounts`（页面 `App.tsx:632` `notifyPendingEdits` 上报） | `requestSheetsClose`（`:2671`） | 无待保存编辑 → `true`；有 → **保存 / 放弃 / 取消**；保存走 `workbook:close-save-request`。另有「auto-save 过的未命名新工作簿」也算丢弃风险（`autosavedNew`） |

**四家都没有 `beforeunload`**；它们的确认链路是 **vendor 主进程 ⇄ 页面 preload** 的
私有通道（`pdf:dirty-changed` / `pdf:close-save-request` …），页面**从来不订阅**
`mcode:document-view:close-check`（全仓 `grep` 证实：只有 Docs 的
`documentViewPreload.ts` + vendor `docs/src/preload/mcode-view.ts` 映射了它）。
所以修复前宿主那条探针对这四家**必然 2s 超时**，正是 T7 记录的缺陷。

### 2. 修法：B（宿主侧分流），但不是「跳过检查」

**(A) 补四个 vendor preload 监听 `close-check`** 被否决，理由三条：

1. **会让同一能力出现两个判据**（仓库硬规矩 2）。vendor 已有完整的
   `request*Close`（含保存/放弃/取消、保存时等渲染端写完、markdown/html 放弃时
   清理旁挂资源、sheets 的 autosave-new 计数）。再让 preload 回答一句 `dirty` 是
   把同一状态复制一份，将来 vendor 改了这边不会跟。
2. **语义会弱**：`close-check` 只回答「脏不脏」，确认弹窗与保存动作仍得另做；
   而宿主没法替 vendor 执行「选保存」。等于要么再造一套保存流程，要么把用户
   引到一个没有保存选项的确认框。
3. 要走 `patches/genoffice/` 改四个上游 preload + 重打四个产物（T25 的活），
   代价远大于在宿主接一个已经存在的接口。

**(B) 宿主侧分流**的实现（`documentViewHost.ts`）：

- `DocumentViewHostPorts.vendorCloseGuard?: (input: { docId, editor, webContents }) => Promise<boolean>`
  + `setVendorCloseGuard()`（装配期一次）。
- `closeWithDirtyProtection`：`editor ∈ {pdf, markdown, html, sheets}` 时**不发探针**，
  直接 `await vendorCloseGuard(...)`；`false`（脏/取消/保存失败）→ 拒绝关闭并保留视图
  与会话；`true` → 走原来那一条 `close()`（凭据释放、会话摘除、vendor 会话释放全部不变）。
  `webContents` 已销毁 → 直接关（没有可保护的内存状态）。
  **守卫未装配 → fail-closed**（拒绝关闭，点名原因），绝不静默丢改动。
  slides 仍走原来的直接关闭（既有语义，vendor 侧另有 `requestSlidesClose` 给它自己
  的窗口用）；Docs 仍走 Mcode 自己的 `close-check` 探针（未改）。
- 生产装配（`ipc/index.ts`）：`documentViewHost.setVendorCloseGuard(({editor, webContents})
  => requestNativeViewClose(editor, webContents))`。
- `genofficeNativeVendor.ts` 新增 `requestNativeViewClose(kind, contents)` —— **原样转发**
  vendor 的 `requestPdfClose` / `requestMarkdownClose` / `requestHtmlClose` /
  `requestSheetsClose`，弹窗挂主窗口（与生产 `confirmDirty` 的
  `dialog.showMessageBox(win, …)` 同一取舍）。没有复制任何脏判断或保存逻辑。
- `genofficeNativeVendorStub.ts`（vendor 快照缺失时的构建替身）返回 `false` ——
  那是「没有原厂编辑器」的构建，走不到。
- **没有改 `genoffice/` 源码，也没有加 `patches/`**；**没有改 `documentViewPreload.ts`**。

### 3. 真 Electron 验证（成果，不是「跑绿了」）

新套件 `apps/desktop/scripts/t29-document-view-close-u1/`（复用 `electron-u1/build.mjs`
＋ T7 的 vendor 打包别名与 prebuild；真 Electron、真 vendor 视图、生产
`documentView:close` handler 同一个函数对象）：

- 四条旅程（pdf / markdown / html / sheets），每条 **2 代 OS 进程**：干净关闭 →
  relaunch → 在页面里制造未保存修改（markdown 走真 ProseMirror 事务；其余三家经
  页面**自己的 preload 通道**上报，与用户编辑后页面做的事同一个）→ 脏关闭必须
  弹出 **保存/放弃/取消**（用可编程的 `dialog.showMessageBox` 端口记录并断言
  `buttons.length === 3`）→ 选**取消**必须拒绝且视图/会话保留、磁盘字节不变 →
  选**放弃**必须真的关闭。
- 结果：**4/4 旅程 PASS（8 个 OS 进程）**；证据在 `.tmp/electron-u1/<时间戳>/`。
- 断言打在**生产装配路径**上：旅程调的是 `registerDocumentViewHandlers` 注册的
  `documentView:close` handler（T7 harness 记录的同一函数对象），不是测试自己
  复制的一份判据。
- 说明：journey 里「未保存修改」在 html/sheets 上是用页面自己的 preload 通道上报
  的（`htmlApi.setDirty(true)` / `desktopApi.notifyPendingEdits(1)`），不是真键鼠编辑 ——
  这两家的真实编辑手势 T7 已经覆盖；T29 要验的是**关闭路径**是否读到 vendor 的
  脏状态，而 vendor 只看这条上报通道。markdown/pdf 用的是真编辑器操作。

### 4. 变异验证（撤修复 → 真红 → `cmp` 还原）

变异点：`documentViewHost.ts` 的 `if (vendorEditor !== null) {` → `if (false && vendorEditor !== null) {`
（退回修复前形态：发探针、vendor 不订阅、2s 超时拒绝）。

- **无头**：`document-view-host-smoke` 由 538/538 → **6 条 FAIL**，其中
  `★ T29 pdf：守卫允许后 close 成功（修复前这里永远超时拒绝）` 的实际值是
  `{"ok":false,"reason":"无法查询编辑器未保存状态，拒绝关闭"}` —— 正是缺陷原文。
  还原后 **538/538**。
- **真 Electron**：T29 pdf 旅程 `literal=FAIL … failedStep=clean-close-succeeds`；
  evidence 里 `production.reason = "编辑器未响应关闭检查；为保护未保存内容，拒绝关闭"`
  —— T7 当年记下的同一句话。还原后 **4/4 PASS**。
- 两次都用 `cmp -s` 核对源文件逐字节还原（备份在 `.tmp/t29-mutation/`）。
  可复跑脚本：`node apps/desktop/scripts/t29-document-view-close-u1/mutate-t29.mjs`
  （它自己写回并 `cmp` 校验；中途有别的写者就拒绝覆盖）。

### 5. 回归

- `document-view-host-smoke`：**538/538**（含新增 T29 段 35 条：身份/三态/并发一次询问/
  未装配 fail-closed/抛错如实拒绝/slides 语义不变）。
- `genoffice-native-view-smoke`、`document-view-open-smoke`（39/39）、
  `document-view-vendor-page-smoke`（9/9）、`document-view-electron-smoke`（17/17）全绿。
- **T7 六编辑器 U1：6/6 PASS**。为实现这条，**同时更新了 T7 的关闭步骤断言**：
  T7 harness 原先没有装配生产关闭守卫（它不跑 `ipc/index.ts`），修复后它看到的是
  「守卫未装配」的 fail-closed，而不是生产行为 —— 现在 harness 按生产装配注入**同一份**
  `requestNativeViewClose`，四个 journey 的 `close-production-path` 改为要求
  「干净文件 → 生产 close 必须直接成功」，不再把「拒绝」当成预期。
  （对照实验：把 5 个源文件临时还原到 HEAD、T7 全量 6/6 绿；带修复同样 6/6 绿 —— 
  **唯一差异就是关闭断言本身**。期间另外三个 journey 偶发的 `capturePage 空截图`
  在对照跑中也未复现，判定为并行跑两条 Electron 套件导致的截图抢占，与本修复无关。）
- 双包 typecheck 通过（我改的文件；`apps/desktop/scripts/capability-smoke` 与
  `scripts/t30-*` 的类型错误来自别人正在进行的 T35/T30 中间状态，非本卡）。
- 全量 smoke：**536 pass / 7 fail**。7 个失败逐个核过**都与本卡无关**：
  `aoci-index-smoke`（AOCI 台账悬空引用）、`approval-bridge-parity-smoke`
  （`dispatchCodexExternalToolCall is not defined`）、`arc005-pane-electron-smoke`
  （并行跑 Electron 的 PTY/Monaco 抢占）、`genoffice-source-smoke`、
  `genoffice-vendor-freshness-smoke`（单跑 29/29 通过，是并行抖动）、
  `markdown-mode-smoke`（`genofficeAppForPath is not defined`，别人的进行中改动）、
  `module-permissions-smoke`（`Unmapped RPC method: document.apps`）。这些文件
  我的 `git status` 里一个都没碰。

### 6. 交付文件（独占写入边界，逐个确认）

- `apps/desktop/src/main/document/documentViewHost.ts`（+72：端口 + 分流 + 并发共享）
- `apps/desktop/src/main/document/genofficeNativeVendor.ts`（+44：`requestNativeViewClose` 转发）
- `apps/desktop/src/main/document/genofficeNativeVendorStub.ts`（+7：stub false）
- `apps/desktop/src/main/document/genofficeEntryTypes.d.ts`（+2：sheets `requestSheetsClose` 声明）
- `apps/desktop/src/main/ipc/index.ts`（+11：装配期注入守卫）
- `apps/desktop/scripts/document-view-host-smoke/main.ts`（+161：T29 段）
- `apps/desktop/scripts/t7-genoffice-u1/harness.ts`（+9：按生产装配守卫）
- `apps/desktop/scripts/t7-genoffice-u1/journeys/{pdf,markdown,html,sheets}-*.ts`
  （关闭步骤断言改为生产路径；头部描述同步）
- `apps/desktop/scripts/t29-document-view-close-u1/`（新套件：`run.mjs`、
  `dialog-port.ts`、`mutate-t29.mjs`、`journeys/{index,close-journeys}.ts`）

**未改**：`genoffice/` 源码、`patches/`、`documentViewPreload.ts`、`packages/contracts/`、
T2/T3/T4/T27/T28 的文件。**未宣称 ARC-007 完成。**

### 7. 提交

`<填于提交后>`

### 8. 附带发现（不属于本卡，交给总控排）

1. **T7 的关闭断言把缺陷写成了预期**：`close-production-path` 原先断言「生产拒绝 +
   原因含『未响应关闭检查』」。修复后这条会红 —— 这正是它应该做的，但说明**缺陷
   取证式断言会随修复翻转**，其它卡做同类取证时要知道这不是回归。
2. **T7 harness 与生产装配的漂移**：harness 手工装配（不跑 `ipc/index.ts`），
   生产新增的装配步骤（如本卡的 `setVendorCloseGuard`）不会自动跟上。这次是
   T29 自己发现并补上的；同类缺口值得一个「装配清单一致性」检查（T7 harness
   vs `ipc/index.ts`）。
3. `dialog.showMessageBox` 在 Electron 44 主进程里可替换（`writable`/`configurable`
   均为 true，实测），所以「确认真实弹了」可以做成确定性断言；这套端口现在是
   `t29-document-view-close-u1/dialog-port.ts`，其它需要系统确认的 U1 可以复用。

