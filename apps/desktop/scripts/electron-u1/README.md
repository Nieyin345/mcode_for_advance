# T16 — 真 Electron U1 旅程骨架（`electron-u1`）

跑真 Electron、操作真界面、断言真磁盘，每一步留证据。给后续卡（T7 GenOffice、
T8 Node-RED、ARC-005 V4）复用。

```bash
bash apps/desktop/scripts/electron-u1/run.sh
```

两趟：正常跑（期望退出码 **1** —— 唯一"失败"的是故意失败旅程，且形态符合预期）
→ 变异跑（把断言执行换成无条件通过，期望退出码 **0**，即那条旅程由红变绿）
→ `verify.mjs` 31 条判据。证据落在 `<repo>/.tmp/electron-u1/<时间戳>/`（永不自动清理）。

## 与 `arc005-visual-baseline` 的边界（写死）

| | arc005-visual-baseline | electron-u1（本套件） |
|---|---|---|
| 验证对象 | 某个 DOM 在某个 viewport 下长什么样 | 用户点 A → 输入 B → 看到 C → 保存 → 重开还在 |
| 动作 | 无（摆好场景直接拍） | 真鼠标 `sendInputEvent` 点击、真 `insertText` 键入、真 OS 进程重开 |
| 断言 | compare.mjs 与参考矩阵比对 | `dom` / `visual` / `sideEffect` 三档，**可单独开关** |
| 失败概念 | 无（data-missing 显式登记） | 每步 PASS/FAIL；旅程可声明 `expect:"fail"` 自检 |
| 证据 | 39 格 PNG + JSON + `fixture` 类型 | 每步 {动作, 断言, 截图, DOM 快照摘要+完整HTML, PID, 时间戳} |

**禁止**拿 arc005 的 fixture 截图冒充 U1 旅程证据；也禁止把本套件的证据当作
arc005 视觉基线的一部分。

## API（`driver/index.ts`，后续卡只 import 这一个文件）

```ts
import { defineU1Journey, step } from "../electron-u1/driver/index.js";

export const journeys = [
  defineU1Journey({
    name: "genoffice-docs-open-edit-save",           // kebab-case，直接当证据目录名
    launch: {
      page: "bundle",                // 真 App（build.mjs 打的 App.tsx bundle）
      preload: "product",            // 真 src/preload/index.ts 构建产物（真 window.api）
      useRealDb: true,               // 主进程 initDb() + 真 ProjectRepo（mktemp 数据根）
      assertions: { dom: true, visual: true, sideEffect: true }, // 三档独立开关
      size: { width: 1280, height: 800 },
    },
    steps: [
      step.waitFor("[data-testid=workspace-main]", "main-window-visible", { timeoutMs: 30_000 }),
      step.click("[data-genoffice-doc]", "click-doc", { text: "blank.docx" }),
      step.assertDom("[data-genoffice-editor]", { textContains: "hello" }, "editor-loaded"),
      step.recordSideEffect("@doc", "doc-before"),        // @doc/@db/@projectDir/@home 由 runner 解析
      step.click("#save", "click-save"),
      step.assertSideEffect("@doc", { sha256ChangedFrom: "doc-before" }, "doc-changed"),
      step.relaunch("reopen-after-save"),                 // 真退出 + 新 OS 进程继续
      step.assertSideEffect("@doc", { contains: "hello" }, "persisted-after-reopen"),
      step.screenshot("final"),
    ],
  }),
];
```

步骤工厂全集：`navigate / click / type / press / waitFor / waitForGone / sleep / eval /
assertDom / assertEvaluated / screenshot / assertScreenshotChanged / recordSideEffect /
assertSideEffect / relaunch`。

`launch.page` 三种：`"bundle"`（真 App）、`{ file }`（build 目录内的页面名，
build.mjs 从 journeys 里抽 `const PAGE = \`…\`` 落盘）、`"bundle"` 缺省。
必填 `name`（kebab-case）；`expect:"fail"` 必须配 `failBecause(evidence)`。

### 后续卡如何复用（不复制执行器）

```bash
# 在你的套件目录（例：apps/desktop/scripts/t7-genoffice-u1/）：
node ../electron-u1/build.mjs --registry=scripts/t7-genoffice-u1/journeys/index.ts
```

`build.mjs --registry=` 只替换旅程入口，共享同一个 runner / 页面 / api-stub 构建。
若你的旅程需要自己的页面模板，把 `const PAGE = \`…\`` 写进你的旅程文件（build.mjs
会按文件名 `<journey 文件 basename>.html` 落盘——见「未覆盖项」）。需要真 App 之外的
preload 时在 `launch.preload` 指到 build 目录里的文件。

## 三条示例旅程

1. `ui-project-switch`（纯 UI）：真 App + 真 store + 虚构 API 数据。启动 → 主窗口
   出现 → 展开项目 B → 点其会话行 → 断言中间面板切换（消息、活动标签、截图两帧不同）。
2. `file-save-relaunch-persistence`（文件副作用）：临时 `mcode.db` 副本 + 临时文档 →
   页面经**产品真 preload** → `file:writeFile`（真 pathGuard / osFileLease / CAS /
   原子替换）→ `relaunch` → **新 OS 进程**先自检库里项目行仍在，再断言文档内容与
   sha256 持久化。
3. `deliberate-failure`（故意失败）：断言不存在的元素 → 必须红；失败步的截图（161KB
   PNG）与完整 DOM（377 节点）落盘；`failBecause` 要求失败恰好落在该步、且前置正对照
   PASS。**变异验证**：把 `assertionStatus` 改成无条件 PASS，它的 `literalStatus`
   由 FAIL 翻成 PASS，套件退出码从 1 变 0。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 全部旅程按声明通过（含"故意失败"按预期失败）。**默认无变异跑不该出现** —— 第三条变绿说明断言被旁路 |
| 1 | 唯一失败的是 `expect:"fail"` 旅程且形态符合预期（**默认跑的正常结果**） |
| 2 | 意外失败：非预期旅程失败 / 预期失败形态不对（骨架自己崩了） |
| 3 | 自检失败：正常跑里"故意失败"没有按预期失败 |

## 断言分档

| 档 | 例子 | 关掉后 |
|---|---|---|
| `dom` | `assertDom`、`assertEvaluated` | 实际结果写进 `observed.actualStatus`，证据标 `skipped:true`，永不判 FAIL |
| `visual` | `screenshot`（仅记录）、`assertScreenshotChanged`（两帧 sha256 不同） | 同上 |
| `sideEffect` | `assertSideEffect`（exists / contains / sha256ChangedFrom / sha256Equals） | 同上 |

失败时（不论哪档）runner 额外抓一张截图 + DOM 快照（即使该步没配 screenshot），
文件落在 `<证据目录>/dom/` 与 `shots/`，**不清理**。

## 零新依赖（Playwright 评估）

**结论：不需要 Playwright。** 评估记录（coordinator 要求）：

- 现有 `arc005-visual-baseline` 的 `electron-host.cjs` + `capturePage()` 模式可以
  且**已经**扩展出点击/输入/重开/断言（`sendInputEvent` + `insertText` + `app.exit(77)`
  + 启动器换进程），本套件就是证明。这三项恰好是 Playwright `_electron` 提供的全部
  关键能力，其中 `app.evaluate()` 的"主进程执行代码"我们直接在 runner 里就有（runner
  本来就跑在主进程）。
- 真要加 Playwright：Apache-2.0（`@playwright/test`），但会拉 ~100MB+ 的浏览器二进制
  （Electron 测试需要 `executablePath`，可不下载 Chromium，但 core 包 + deps 仍是
  ~10MB 量级），且给这个"零新依赖"仓库增加一次版本漂移风险。体积影响远超收益。
- Playwright 唯一比我们强的地方：trace viewer、自动重试、跨平台录屏。这三项都不是
  本卡判据；需要时再评估。

## 已知限制 / 未覆盖项

- **T7/T8/ARC-005 V4 未完成**。本套件只交付框架与三条示例，不代表任何产品旅程已验收。
- `file:writeFile` 的 CAS 冲突分支、并发租约未在 journey-2 覆盖（只走 happy path +
  重开持久化）。冲突/并发留给调用方按需加步骤（`recordSideEffect` + 手工篡改文件）。
- journey-1 的 App bundle 只换 `lib/api`（`window.labApi` 桩）与 `monacoSetup`；
  `LeftBar`/`StreamSidebar`/`ChatPane` 都是产品真组件。真 IPC 的桌面链路（preload →
  handler）由 journey-2 覆盖，不重复。
- 页面模板抽取只认 journeys 文件里 `const PAGE = \`…\`` 的名字 → `<basename>.html`；
  多页面旅程需要自己的 `launch.page.file` 与手工落盘（见 build.mjs 第 4 节）。
- `--only=<journey>` 仅供调试；`run.sh` 永远跑全部 + 变异。
- 套件目录名 `electron-u1` **不**匹配 smoke 自动发现正则（`*-smoke`）——这是有意的：
  U1 是独立于 E1/headless smoke 的证据等级，不应被 `run-all-smokes.sh` 顺带当 smoke 跑。
