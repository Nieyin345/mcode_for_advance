# T46｜审批卡的真 Electron U1 —— 补 E1 覆盖不到的四种情况

- Status: done（回写见下）
- Category: test / security-regression（P1 security 边界的真实环境验证）
- Priority: P1
- Depends on: T6（`290d3d16`，E1 的 51/51）
- Exclusive writable files：`apps/desktop/scripts/t46-approval-card-u1/`（新套件）、本卡文件。**生产源码零改动**（变异只做临时改写并逐字节还原）。

## Required Skills

- `mcode-smoke`：本仓 U1/smoke 的写法（真 Electron 骨架、变异验证、`cmp` 还原）。
- `desktop-testing-electron`：Electron 主进程测试、`sendInputEvent` 输入管线、多窗口焦点。

## 为什么单开

T6 的 51/51 是 **E1（隔离组件）**：真 React + 真组件 + CDP 派发按键，但**没有
BrowserWindow**。以下四件事只有真实窗口能验，而审批卡是安全边界上的东西，
E1 绿不代表真实窗口里绿：

1. 真窗口里的键盘（`webContents.sendInputEvent` 走 Chromium 输入管线，不是 CDP）；
2. 多窗口焦点（另一个窗口抢焦点时审批卡不误决策）；
3. `settingsOpen` 暂停（设置面板打开时卡片不抢焦点、不决策，关掉后恢复）；
4. `active=false`（后台 keep-alive 会话）不抢焦点、不决策。

## 验收判据（每条附方法）

| # | 判据 | 方法 |
|---|---|---|
| 1 | 真实窗口里 Enter 在卡上不产生决策；Escape 产生 deny | `webContents.sendInputEvent({type:"keyDown"/"char"/"keyUp"})`；读页面 `labProbe().decisions` |
| 2 | **键盘真的送达**（否则 1 的「无决策」是空过） | 同一条 `sendInputEvent` 路径发 Escape 必须真的产生 deny（同组正控） |
| 3 | 焦点在卡上（挂载后） | `document.activeElement.closest('[role=alertdialog]')`，轮询到成立 |
| 4 | 焦点在「允许」+ 已武装后，Enter 真的批准 | 先 `btn.focus()`，等 `allowDisabled === false`（`APPROVAL_ARM_DELAY_MS=500`），再发带 `char` 的 Enter；assert `granted===true` |
| 5 | 模态先开、卡后到：焦点**从未**进卡，Escape 不决策 | 页面 `focusin` 日志按**本组开始时刻**切片（`labFocusedSince(since)`），要求切片段内无 `card:` 条目 |
| 6 | 上条的对照：关掉模态 + 重挂卡 → 同一条 Escape 产生**一条新的** deny | 决策日志按「本组基线 +1」比较（不是「整段日志恰好 1 条」） |
| 7 | `settingsOpen=true`：不抢焦点、Escape 不决策；`false` 后恢复（**不重挂卡片**） | 写 `sessionStore` 桩的 `settingsOpen`（生产组件只读这一个字段），断言焦点/决策按 store 驱动 |
| 8 | `active=false`：不抢焦点、不决策；`active=true` 对照 | 同上，`active` 是 props |
| 9 | 另一个 BrowserWindow 抢焦点时本窗口不产生决策；回到本窗口后 Escape 仍能拒绝 | 第二个窗口 `show:true, opacity:0, x/y:-10000`（用户看不见），`other.focus()` → assert `other.isFocused()===true` 且本窗口 `document.hasFocus()===false`；再 `win.focus()+wc.focus()` 后 Escape 拒绝 |
| 10 | IME 合成键（`isComposing` / `keyCode 229`）不拒绝；普通 Escape 对照 | 页面内派 `KeyboardEvent('keydown', {isComposing:true})` 与 `{keyCode:229}`（真 IME 仍为未做项） |
| 11 | 危险工具（`mcode-app-danger:` 前缀）无 always-allow 控件，点「允许」的决策不带 `always` | 断言 `input[type=checkbox]` 数量 0、按钮文本无「始终允许」；再真 `click()` 读决策 |
| 12 | 卸载后卡片不在 DOM | `labUnmount()` → `document.querySelector('[role=alertdialog]') === null` |
| 13 | 变异：撤掉三条生产守卫，对应组必须各自变红 | `mutate-t46.mjs`（见下） |

## 方法说明（总控要求的三条）

- **用什么驱动键盘**：`webContents.sendInputEvent`（真 Electron 输入管线），不是
  CDP `Input.dispatchKeyEvent`。Enter 需要 `keyDown` + `char` + `keyUp` 三次才触发
  按钮默认激活；Escape 只需 `keyDown`+`keyUp`（E1 记录过同一件事）。
- **焦点怎么保证**：`runner` 把窗口建成 `show:true, opacity:0, x/y:-10000`
  （屏幕外 + 全透明）。**不能用 `show:false`** —— 隐藏窗口的
  `document.hasFocus()` 恒 false，而本卡验的正是焦点语义。第二个窗口同一技巧。
  E 的实测（`webContents.focus()` 即可，不需 `win.focus()`）只在「单窗口、元素
  已在焦点链上」时成立；本卡的多窗口组必须 `win.focus()` 让**窗口**回到前台，
  否则 `document.hasFocus()` 不会变，对照组不成立。
- **拒绝按钮走哪条代码路径**：`ApprovalPrompt` 的 `onKeyDown` 在 `Escape` 上
  `preventDefault + stopPropagation + decide(false)`；`decide` 先过
  `promptActive`（`active && !settingsOpen`）再调 `onDecide`。所以「不决策」
  有两个可能原因（键没送达 / `promptActive` 为假），每组都配了同源正控区分。

## 结果回写（2026-10-23）

### 一句话

新建真 Electron 套件 `apps/desktop/scripts/t46-approval-card-u1/`，**1 条旅程 11 个断言步全过**
（含 5 组「不该发生 + 同源对照」）。三次变异各自红在对应组，`cmp` 逐字节还原。
**生产源码零改动。**

### 套件组成（独占目录）

- `run.mjs` —— 复用 `electron-u1/build.mjs`（`--registry` + `--prebuild`），不复制执行器。
- `prebuild.mjs` —— 把探针页打进 buildDir：真 React 19 + **真 `ApprovalPrompt`** +
  真 Base UI `Dialog`；Tailwind 按生产 `styles.css` 真编译。
- `approval-page.tsx` —— 探针页（`labMountApproval` / `labSetStore` / `labOpenModal` /
  `labFocusedSince` / `labProbe` …）。
- `stub-session-store.ts` —— **唯一**被替换的模块（可切换 `settingsOpen` 的选择器桩）；
  生产组件只读这一字段（`ApprovalPrompt.tsx:83`）。
- `journeys/index.ts` —— 旅程与全部断言。
- `mutate-t46.mjs` —— 可复跑的变异验证。

### 动态证据

```
node apps/desktop/scripts/t46-approval-card-u1/run.mjs
→ t46-approval-card-u1: literal=PASS expectation=all-pass (1 OS process)
→ T46: 退出码 0
```

11 个步骤：`window-facts`（不断言，记录窗口可见性/透明度/`hasFocus`）、
`card-takes-focus-on-mount`、`enter-on-card-is-inert-escape-denies`、
`tab-to-allow-then-enter-approves`、`modal-open-later-card-yields-control-works`、
`settings-open-pauses-and-resuming-works`、`inactive-session-is-inert-active-controls`、
`multi-window-focus-no-false-decision`、`ime-composition-does-not-deny`、
`danger-tool-has-no-always-allow`、`unmount-clean`。

`npx tsc --noEmit` 双包均 exit 0。

### 变异验证

```
node apps/desktop/scripts/t46-approval-card-u1/mutate-t46.mjs
T46 MUTATION modal-guard-removed:        detected=true (failedStep=modal-open-later-card-yields-control-works)
T46 MUTATION settings-pause-removed:     detected=true (failedStep=settings-open-pauses-and-resuming-works)
T46 MUTATION card-focus-removed:         detected=true (failedStep=card-takes-focus-on-mount)
T46 MUTATION: all 3 variants detected; source restored byte-identical
```

每变体：Python 精确替换（计数=1）→ 跑旅程 → 必须 `exit 2` 且 `failedStep` 命中 →
`cp` 还原 + `cmp`。中途第三方改动会拒绝覆盖。

### 调试中修正的两个自身缺陷（如实记录）

1. **焦点日志切片**：最初用全量 `focusLog` 判断「模态期间卡有没有抢焦点」，
   第一次跑就红 —— 日志里是**上一组**（正常挂卡）留下的 `card:` 条目。改为
   页面给每条焦点日志打时间戳 + `labFocusedSince(since)` 按场景切片。
   **这是本套件自身最容易假红/假绿的地方**，其它否定式焦点判据都应照此办理。
2. **决策日志基线**：几组最初写 `decisions.length === 0`，但决策日志跨组累加，
   第二组起必红。改成「本组基线 + 1」比较。

另：危险工具前缀最初写成 `mcode-app:danger.writeFiles`（不存在），
真前缀是 `mcode-app-danger:`（`packages/contracts/src/appControl.ts:22`）——
写成前者时卡片有 always-allow 勾选框，断言按设计红了一次，正好证明这条断言有效。

### 未做项与证据边界

- **真 IME 未验**：IME 组用合成 `KeyboardEvent`（`isComposing` / `keyCode 229`），
  验的是生产守卫的同一入口；搜狗/微软拼音的真实 composition 序列仍是未做项
  （需要真实输入法环境，无头 U1 做不了）。
- **macOS `Cmd` 语义**未覆盖（本机 Windows）。
- **真实引擎审批桥未接入**：本卡把 `onDecide` 落成页面决策日志，**没有**走
  `claude:approve` 真 IPC / 三引擎在线审批；那属于主进程审批桥，另验。
- **没有截断 arm 延迟的内部时序**：只用「等 `allowDisabled===false`」作为
  武装完成的判据，没断言 500ms 内确实不可点（E1 已覆盖该条）。
- 窗口是「屏幕外 + 全透明」而非 `show:false`（为了让焦点语义成立）；
  `window-facts` 步如实记录了这一点。

### 提交

- 实现提交：**`2a61b8ba`**（7 个文件，全部是本卡独占目录 + 本卡）。
- 提交后在该 HEAD 上复跑 `node apps/desktop/scripts/t46-approval-card-u1/run.mjs`
  → `literal=PASS expectation=all-pass`，退出码 0；工作区相对 HEAD 无改动。
