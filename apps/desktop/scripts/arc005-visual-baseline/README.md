# ARC-005 / T12 V4 — 真 Electron 视觉基线（含明确标注的夹具）

从仓库根目录运行：

```bash
# Windows cmd.exe / native Node (works without WSL Node)
node apps/desktop/scripts/arc005-visual-baseline/build.mjs
node apps/desktop/scripts/arc005-visual-baseline/compare.mjs
node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
```

针对界面收敛的快速实际 Electron 检查可设置环境变量后运行 build：
`set "ARC005_VISUAL_SCENES=sidechat,files-pane,git-pane,narrow-window"` 与
`set "ARC005_VISUAL_CONDITIONS=narrow"`。不设置则**完整 17×3=51 格**。
轻量源码 E1 检查：`node apps/desktop/scripts/run-smokes.mjs arc005-main-ui-u1-guard-smoke t5-visual-probe-integrity-smoke`。

仅使用现成 Electron/esbuild/Tailwind/React 依赖。根组件始终是**真实 App**
和真实 Zustand store，LeftBar / StreamSidebar **不再用占位组件替换**；
只为 `lib/api` 和 `monacoSetup` 保留已有构建桩。项目、会话、Git worktree、
文件树等 API 使用 `api-stub.js` 的独立虚构数据响应；无真实数据目录访问，
无真实 PTY/Monaco worker 创建。

## 怎么用这个套件（先读这一节）

**它产出两种东西，用途完全不同 —— 混用会得出错误结论。**

| 产物 | 谁在读 | 用来做什么 |
|---|---|---|
| **`.json`** | `compare.mjs` | **判据**：比对已登记的 token / 圆角 / 动效 |
| **`.png`** | **人眼** | **对照**：看「改前改后长什么样」 |

### 1. `compare.mjs` 比的是 token，**不是像素**

源码第一行写着，`:98-100` 只读 `.json`：

```js
// T01 ARC-005 V4: compare computed tokens (not guessed screenshots) only
const path = join(evidence, row.file + ".json");
const sample = JSON.parse(readFileSync(path, "utf8"));
```

**`.png` 在 `compare.mjs` 里一次都没出现。**

**所以**：截图的字节差异、尺寸抖动、时钟秒位 —— **对判据零影响**。
判断「改动是否引入回归」，看 `diff.md`，**不要拿两轮的 PNG 直接比**。

### 2. PNG 是给人看的对照物

**改 UI 之后看 PNG，前提是两张图尺寸相同、内容可比。**

已知会让这件事失效的噪声（见下一节），看到它们**不要当成回归**。

### 3. 已知的 PNG 抖动（不是回归）

| 噪声 | 表现 | 为什么会这样 |
|---|---|---|
| **时钟秒位** | 暗色场景里几处 8px 差异，灰度差 1 | `useNow` 每 1 秒跳，数字重排。**已修**：探针截图前冻结时钟 |
| **窗口尺寸抖动** | 同场景两次跑出不同分辨率（实测 `2218x1292` vs `2240x1357`） | `setSize` 之后只有一个固定 `sleep`，窗口 chrome 还没稳定就 `capturePage()`。**未修** |

**如实记录实测**：48 张图两轮连跑，**只有 12 张逐字节相同**。
**这不削弱判据**（判据不看 PNG），但**削弱「并排看图」的可靠性**。

### 4. 新增场景怎么加（2026-10-24 实做过的路径）

**三个文件，各有各的职责：**

| 文件 | 改什么 |
|---|---|
| `probe.ts:18` 的 `SCREENS` | 加 `[场景名, 中文标题]` |
| `probe.ts` 里那个大 `js()` 场景分派（`if (id === '...')`） | 给新场景设置 store 状态 |
| `probe-assertions.ts` | 加 `dom` 断言：面板真的渲染了（元素数、文本） |
| `build.mjs:38` 的清理正则 | **把新场景名加进去**，否则重跑时旧图会残留 |

**⚠️ 数据一律走 `api-stub.js` 的虚构响应，不碰真实数据目录。**

**⚠️ 第一次拍就是基线** —— 不要写 `visual` 断言（那是给「和基线比」用的，
新场景还没有基线可对）。

**⚠️ 拍不出来就记 `data-missing` 并写清原因**，不要用别的场景顶替。

## 格数的证据属性

**期望格数不是常量，是算出来的**：`SCREENS.length × CONDITIONS.length`
（现在是 17 × 3 = **51**）。`probe.ts` 把它写进 `.tmp/arc005-visual/expected.json`，
`build.mjs` 与 `compare.mjs` 都读那个文件 —— 它们与 `probe.ts` 是两个进程，
读不到运行时的 `SCREENS`，所以必须有这个文件当唯一来源。

**加场景只改 `probe.ts` 的 `SCREENS`，另两个文件不用碰。** 以前两处各写死一个
`39`，T136 把场景扩到 17 个之后全部恒假，`build.mjs` 每次 exit 1、`run.sh`
的 `set -e` 直接把 token 比对整段吞掉 —— **门禁一次都没跑过，而屏幕上打的是
`failed=0`**（T141）。

**`data-missing` 分两种，别混**：

- **登记过的**（`probe.ts` 的 `KNOWN_UNCAPTURED`，写进 `expected.json`）→ 已知缺口，
  如实记录，**不挡门禁**；
- **没登记的** → 某次拍摄崩了或场景被改坏，**必须红**。

以前 `sidechat` 是未接入工作流 IPC 的隔离面板，3 格永远标记为
`DATA_MISSING`。现在它真实打开右栏的 `WorkflowBoardPanel → SideChatPanel`，
展示两条虚构子对话并通过点击验证真实会话选择，**不再允许登记为常驻缺失**。
仍坚持失败时退出非零，不能用看起来相似的占位元素混过门禁。

每格按 `<screen>-<condition>-<nominal-width>.json/.png` 输出到
`.tmp/arc005-visual/`。截图均由真实 Electron `capturePage()` 生成，
但 **capturePage 是真的，并不意味着面板的每个内部功能也是真的**。
每个 JSON 都有顶层 `fixture`，实际渲染 DOM 的 `data-arc-fixture` 也有对应类型：

| 场景 | fixture | 取证边界 |
|---|---|---|
| empty/messages/tools/approval/settings | `real-app` | 真 App + store，内容是虚构的 |
| parallel | `real-StreamSidebar` | 真实侧栏组件，三条假会话及运行状态 |
| projects | `real-LeftBar` | 真实项目树，两个假项目 |
| diff | `real-lineDiff-DiffView` | `.tmp` 下 v1.ts、v2.ts 两版，真实 `lineDiff` 计算与 `DiffView` 渲染；不是 Monaco 编辑器 |
| preview | `real-markdown-renderer` | 真生产 `Markdown` 渲染；尚未验证 PDF/图片 |
| terminal | `static-terminal` | 只验证 token/排版；**没有 PTY** |
| editor | `stub-editor` | 假只读源码面板；**不是 Monaco** |
| sidechat | `real-SideChatPanel` | **真实 App 右侧工作流面板内的 SideChatPanel**；虚构的两条子会话通过只读 API 桩加载，并测试点击第一条子会话的选择状态、再返回列表截图；**不代表**工作流 IPC/节点执行验收 |
| narrow-window | `stub-editor+real-layout` | 强制实际窗口 1024×640，打开左栏/右栏并覆盖只读编辑器桩；light/dark 也在 1024 实拍 |

**特别注意：** 文件名中的 `light-1280` / `dark-1280` 对 `narrow-window`
代表**主题条件**，不是实际 viewport；实际 window size 见 JSON
`requested`、`snapshot.viewport`。其他行按命名窗口尺寸拍摄。

每张 JSON 还写入 `snapshot.workspaceSkin`，验证 ARC-005 视觉层样式表确已加载、工作区存在、控件尺寸及焦点色均非空；漏加载样式会令捕获失败，而不再产生误导性的通过。

`sidechat`、`files-pane`、`git-pane` 与 `narrow-window` 还检查真实 `snapshot.paneGeometry`：中心区宽至少 240px、右栏宽至少 130px，并要求二者没有实际二维覆盖。窗口布局退化为重叠浮层或把聊天主窗挤没时会标记 `DATA_MISSING`，不再只比较颜色令牌。

每张 JSON 都写入 `snapshot.measured`（固定 16 个选择器的
`getComputedStyle`，不出现标 `present:false`），
`snapshot.tokens`（根令牌原值），`probe`（DOM 验证）
和 `deviceScaleFactor`。没有安全场景或渲染失败仍写
`data-missing` 及原因；不会用其它截图顶替。

## compare 和变异验证

`compare.mjs` 仅比对参考矩阵 §二/四/五已经登记的
surface/content/edge、圆角及动效；生成 `.tmp/arc005-visual/diff.md`。
目前保留 **13 次暗色 --edge 的旧矩阵偏差**（单一根因），
因此比较器退出码 **2 代表发现真实未登记差异**，不是截图失败。
`run.sh` 会保留该证据而不会吞掉其它类型错误。

### ⚠️ 两次连跑会有差异，那是噪声不是回归（2026-10-24 实测）

**逐字节比两次连跑的 48 张 PNG，只有 12 张完全相同。** 其余分两类：

| 类别 | 表现 | 来源 | 处理 |
|---|---|---|---|
| **时钟秒位** | 四处暗色各 8px，灰度差 1 | `useNow` 每 1 秒跳，跳的瞬间数字重排 | ✅ **已修**：探针截图前设 `globalThis.__MCODE_FREEZE_CLOCK__`，`useNow.ts` 读到就用固定值、不启 ticker |
| **窗口尺寸抖动** | 同场景两次跑出 `2218x1292` vs `2240x1357` | `capturePage()` 时窗口 chrome 还没稳定 | ❌ **未修**：`probe.ts` 的 `setSize` 之后只有一个固定 `sleep`，改成等 `resize` 事件要动全部 48 张的时序 |

**关键区分**（别把这两件事混为一谈）：

| 用途 | 受这两类噪声影响吗 |
|---|---|
| **`compare.mjs` 判据** | ❌ **完全不受** —— 它读 `.json` 的 token，不读 PNG |
| **人眼看图并排对比** | ✅ **受影响** —— 尺寸不同就没法并排 |

**所以「两次连跑不一致」不是回归信号，也不是判据缺陷。** 判断改动是否生效，
看同一轮的 `diff.md` 与 token 快照；PNG 只用来「看长什么样」。

**为什么没把尺寸抖动也修掉**：那要重排 `probe.ts` 的等待逻辑，风险覆盖全部
51 格；而 `compare.mjs` 本来就不按像素比。**为了「让 PNG 逐字节稳定」去改核心
时序，代价大于收益。**

**如果要修，正确做法是**：`setSize` 之后等 `win.once('resize')` + 一个渲染帧，
而不是加长 `sleep`（加长只是把相位推到另一个不确定的位置）。

T12 的 token 变异验证保存在
`.tmp/arc005-visual/mutation-t12.json`；
暂时把 `empty-light-1280.json` 的
`snapshot.tokens["--surface"]` 改为 `255 0 255` 后，
未登记差异应从 13 增为 14；还原后回到 13，原/还原
文件 SHA-256 与字节比较相同。

## 仍未覆盖的功能

- 侧聊的 UI 本体、列表呈现和子会话选择已覆盖，**live WorkflowBoard IPC、节点执行与真实异步运行尚未覆盖**；如要验业务互动，需产品级真 preload/主进程工作流订阅环境，仅在本测试目录提供虚构行和只读 stub 不等价。
- 编辑器真实 Monaco worker、PTY 的会话生命周期、PDF 和图片预览
  不是本批视觉夹具的证据。后续验收不能拿静态桩代替 U1 功能结论。
- 仅代表本机 Mcode 的真实 Electron 画面；未取得用户安装版 Claude
  Desktop 的逐屏参照图，不据此宣称 ARC-005 视觉整体一致。
