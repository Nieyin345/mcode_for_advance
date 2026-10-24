# Office 总控｜缺口总表与卡序

> 2026-10-24 建立。**这份是 Office 线的唯一进度依据**，每交付一张卡就更新一行。
> 本目录（`tasks/office/`）的卡由 Office 总控写，编号从 `O0` 起，与 `tasks/T*.md` 互不干涉。

## 一、验收依据（不是本文件发明，来自三处）

| 来源 | 承载什么 |
|---|---|
| `docs/planning/mcode-product-roadmap.md` §3 | Office/GenOffice 的产品定位与「验收纪律」 |
| `audit-ledgers/Mcode_统一审查台账.md` §四 **E2E-3 / E2E-4** | 六格式编辑的**否决型**判据；AI 交互的否决型判据 |
| `docs/planning/arc007-genoffice-native-integration-map.md` | 每个格式「必须复用哪个上游包」「当前缺口」 |

**验收纪律（原话）**：E1/headless 只能证明覆盖路径，**不等于真实 Electron U1**。
「任何一个独立红例尚在时不得给对应原 ARC 的完整开发/独立复核打勾。」

## 二、E2E-3 / E2E-4 逐条对照（2026-10-24 实测基线）

跑过的东西和结果，**不是读代码猜的**：

| 判据 | 现状 | 证据 |
|---|---|---|
| 六格式**打开→编辑→保存→关闭→重开** | ✅ 全过 | `t7-genoffice-u1` 6 journeys all-pass，真 Electron，2 OS 进程 |
| 六格式**含 DOM + 视觉 + 磁盘副作用**三层断言 | ✅ | journey 里 `assertDom` / `assertVisual` / `assertSideEffect` |
| 六格式**vendor 资源齐全** | ✅ | 六个 `out/renderer` + `out/preload` + sidecar 8.9MB + CLI 14MB |
| **AI 选区交互主链路** | ✅ 全过 | `genoffice-ai-ask-smoke`：chip→气泡→队列→发送→文档改动→落盘→围栏 |
| **AI 用的是真三 SDK** | ❌ **mock 端点** | 该套件 `probe.ts` 用 mock `/chat/completions` |
| **三 SDK 生产接线存在** | ✅（代码层） | `docsAiPorts.ts:59` `SUPPORTED = claude-sdk/pi-sdk/codex-sdk` |
| **公式/图表/批注/动画/未知部件不静默损坏** | ❓ **未验** | 现有 journey 只验「有内容、能保存」，不验复杂部件保真 |
| **用户与 Agent 并发改同一文件冲突提示** | ❓ 部分 | `genoffice-native-view-smoke` 有 PPTX CAS 用例；六格式未逐一验 |
| **兼容软件回读**（Office/WPS 打开我们保存的文件） | ❓ **未验** | 现有断言只到「重开我们自己能读」 |
| **安装版 U1**（离开源码开发机） | ❌ **未验** | 打包链路已通（`--dir`），但没有一次「装完之后打开六格式」的验收 |

## 三、已确认不是缺口的（避免重复开卡）

跑过、绿的，**不要再开卡**：

- `document-router-smoke` 133/133、`genoffice-file-routing-smoke` 52/52
- `genoffice-native-view-smoke` 21/21、`document-view-host-smoke` 18/18
- `document-read-smoke`、`genoffice-format-gates-smoke`、`genoffice-ai-ask-smoke` 各 PASS
- `genoffice-pane-fence-smoke` 含变异、`t11`/`t87` 许可证门禁
- 六格式 U1（`t7`）

**⚠️ 一个调用方式的坑**：`bash apps/desktop/scripts/<name>/run.sh` 从仓库根跑会失败
（脚本内部 `cd` 后 `dirname "$0"` 变成相对路径，`../lib/esbuild-path.sh` 找不到）。
**必须用 `pnpm test:smoke <name>`**，否则会把「调用方式错」误读成「套件红」。
（我第一天就误读了两次。）

## 四、卡序

按「用户能看见什么」排，不按代码整洁度排。

### O0 — 六格式复杂样本保真（E2E-3 的真缺口）

**为什么第一张**：现有 U1 只证明「简单内容能读写」，而用户抱怨的正是「AI 改完文档又烂又丑」。
复杂部件（公式、图表、批注、动画、嵌套表）静默损坏，是这个产品最致命的失败形态——
**它不报错，用户打开才发现文件坏了。**

**判据**：六格式各一份复杂样本，编辑一处无关内容 → 保存 → 重开 → **未触碰的复杂部件逐项仍在且语义等价**。

### O1 — 真实三 SDK 的 AI 交互 U1（E2E-4 的真缺口）

**为什么**：`genoffice-ai-ask-smoke` 用 mock 端点。用户要的是「原版 AI 交互 + Mcode 的三家引擎」，
mock 通过**不能证明**真 SDK 能驱动这条链。三家各自的差异（工具调用格式、流式、错误）没有覆盖。

**判据**：claude-sdk / pi-sdk / codex-sdk 各跑一次真 Agent，选区→AI 改动→落盘；
**失败时不许静默换引擎**。

### O2 — 并发写同一文件的冲突提示（E2E-4 后半）

**为什么**：用户和 Agent 同时在改同一份文档，旧结果覆盖新内容是**数据丢失**，比任何 UI 问题严重。

**判据**：六格式各验一次「打开→外部改动→保存被拒并提示」；PPTX 已有 CAS 用例，其余五个补上。

### O3 — 安装版 Office 验收（E2E-6 的 Office 部分）

**为什么**：`--dir` 打包已通，但**没有任何一次「装完之后打开六格式」的证据**。
源码开发机能跑，不等于用户装上能跑（资源路径、sidecar、字体都可能不同）。

**判据**：从 `release/win-unpacked` 启动，六格式各开一份，编辑保存重开。

## 五、状态

| 卡 | 状态 | 提交 | 子代理 | 独占目录 |
|---|---|---|---|---|
| O0 六格式复杂部件保真 | **执行中** | `de95c45e`（卡） | 已派 | `scripts/t7-genoffice-u1/**` |
| O1 三家引擎驱动 AI 编辑 | **执行中** | `f74f6b52`（卡） | 已派 | `scripts/o1-three-provider-ai-smoke/**` |
| O2 六格式保存冲突 | **执行中** | `153d6686`（卡） | 已派 | `scripts/o2-conflict-u1/**` |
| O3 安装版 Office | **✅ 交付** | `53413379`（卡）/ `f383922b`（代码） | 已完成 | 16/16 PASS，23/23 变异 |
| O4 docs 关闭缺陷修复 | **执行中** | `2120284e`（卡） | 已派 | `scripts/o4-docs-close-smoke/**` |

## O3 交付摘要（`f383922b`，16/16 PASS）

**解压态产物六格式全 PASS。** `capabilities.hosts` 六项 true，`cliPath` 指向
`resources/genoffice/cli/genoffice.cjs`（安装版分支，显式断言不含 `/genoffice/packages/cli/`）。
每份夹具由**产物 CLI** 生成，六格式各自断言特征 DOM + 唯一 token。

**三条值得记的**：

1. **卡 §6.2 我写错了**：改 `editorsBundled` 不会让任何断言红 —— 它**运行时零消费方**
   （`grep` 零命中，只被构建期脚本读）。真正被 `genofficeCli.ts:113` 读的是 `bundled`。
   已在卡里改正并划掉原说法。
2. **发现真缺陷 → 开了 O4**：docs 关闭恒被拒（`createDbGuardedIpc` 只有 `handle` 没有 `on`）。
3. **sheets 的断言边界，子代理如实标注了**：生产页面**没有**可读单元格的 DOM/桥面
   （`__univerAPI` 只在 DEV 下挂）。它第一次变异写「六个全红」是错的，改成「五个红 + sheets 绿」
   并注明原因 —— **没有硬拗成红来制造不存在的覆盖**。这是正确做法。

## 下一批

- **O4** 已派（docs 关闭修复）
- **O5** 待开：取决于 O0/O1/O2 的红表

**不要提前开。** O0/O1/O2 是取证，结论决定修什么。

---

## 六、已知的设计约束（不自造，从源码读出来的）

### 6.1 `WebContentsView` 会盖住一切 React 浮层

`GenofficeViewHostPane.tsx` 文件头原文：

> `WebContentsView` 是叠在 BrowserWindow 上的 **OS 级子视图**，它不属于 React 的 DOM 树。

**后果**：编辑器区域内**不能**用 React 渲染下拉菜单、tooltip、右键菜单、弹窗 —— 全部会被盖住。
任何「在 Office 编辑器上叠加 UI」的需求，**要么走 GenOffice 自己的渲染，要么改视图 bounds**。

现在不是 bug（没人在编辑器列上加浮层），但是**约束**。

### 6.2 编辑器没有边框，是结构性的，不是漏了

`GenofficeViewHostPane.tsx:545` 的 stage 是空 div，`measureBounds()` 用
**`getBoundingClientRect()` 原样矩形**（`:179-195`，无内缩），所以视图**精确盖满 stage**。

**加 CSS border 是无效的** —— 边框会被视图盖住。
要加边界，只能**让 stage 内缩 1px**，把 border 画在它的父容器上。

**代价**：内缩会让编辑器内容少 2px 宽高。对 slides 画布缩放、表格列宽可能是可见的。
**所以这条必须配「内缩前后编辑器内容渲染一致」的断言，不能只改样式。**

### 6.3 抽屉挤压编辑器列，但不会遮挡

`ThreePaneLayout.tsx:442-449`：drawer 是 `position: "relative"` + flex 流 + `maxWidth: 30%`，
**不是浮层**。它挤压布局，不遮挡。

`editorWidthPct` 默认 50、范围 20–80（`sessionStore.ts:796` / `EDITOR_WIDTH_PCT_MIN/MAX`），
是**相对父容器的百分比**，不是像素。正文 `max-w: 672` 不改变它。

**抽屉开 30% 时编辑器会很窄**，但那是「窄」不是「被盖」，且 `ResizeObserver` 会重算 bounds，不会错位。

### 6.4 面板边框与圆角：现有唯一先例是 6px，不是 10px

UI 总控给的数值我逐条核过：

| token | 存在？ | 谁在用 |
|---|---|---|
| `--panel-edge`（`#e3e3e2` 亮 / `#2c2c2a` 暗 / 另有 sketch、暖色两套） | ✅ `styles.css:195/404/2610/2641` | 结构长线 |
| `border-edge-panel` → `--panel-edge` | ✅ `tailwind.config.js:80` | 三栏分隔、右栏面板 |
| `--radius-panel` = 10px | ✅ `styles.css:1099` | **没有任何大面板在用** |

**UI 说「右栏面板用的就是 --panel-edge」，边框对、圆角错。**

`RightPanel.tsx:345/:357` 实际是 `rounded-md border border-edge-panel`。
Tailwind **没自定义 `borderRadius`**（`tailwind.config.js` 只有 colors），所以 `rounded-md` = 默认 **6px**。

全仓「`rounded-{md,lg,xl}` + `border border-edge-panel`」的组合**只有这两处** —— 这是唯一先例。

**所以 Office 面板若用 10px，会和右栏的 6px 不一致**，而且 4px 差异在小尺度上不明显，
不会被立刻发现。等 UI 总控定夺；定了之后把最终值写在这里。

**这一条的意义不在于 4px**，在于：**「token 存在」不等于「token 在用」**。
UI 给的是「设计意图」，代码里是「实际取值」，两者不一致时以代码为准，并**把这个不一致报出来**。
