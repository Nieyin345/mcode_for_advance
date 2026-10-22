# T16｜真实 Electron U1 验收框架（可复用驱动骨架）

- Status: ready-for-agent
- Category: task
- Priority: P0 infrastructure
- Depends on: none
- Exclusive writable files: 新建 `apps/desktop/scripts/electron-u1/` 目录（驱动库 + 示例旅程 + run.sh），以及本节末尾的结果回写区。**不改** `arc005-visual-baseline/`、不改产品源码。

## Required Skills
- `mcode-smoke`: 理解现有 E1 证据形态，并在设计中把 U1 与 E1 的边界写死。
- `code-review`: 检查骨架是否真的能区分「通过」与「假装通过」。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`docs/planning/mcode-product-roadmap.md`、`apps/desktop/scripts/arc005-visual-baseline/README.md`、`apps/desktop/scripts/arc005-visual-baseline/electron-host.cjs`、`windowStub.ts`、`bridge.cjs`、`build.mjs`。

## 为什么要这张卡

现在整个项目**能拍静态截图，但不能跑用户旅程**。`arc005-visual-baseline` 拍 39 格 PNG + JSON，每个 JSON 都诚实标注了 `fixture` 类型（`real-app` / `static-terminal` / `stub-editor` / `sidechat-partial`）——这是好的取证纪律，但它**不是 U1**：

- 它验证「某个 DOM 在某个 viewport 下长什么样」
- 它不验证「用户点 A → 输入 B → 看到 C → 保存 → 重开还在」

T7（GenOffice 六编辑器 U1）、T8（Node-RED 画布 U1）、ARC-005 V4（逐屏对照）全都卡在同一个缺口上：**没有一个可复用的「启动真 Electron → 操作 → 断言」骨架**。每张卡都要从零手搓一遍，就会各自发明一套，最后谁也没法复核。

## 目标

产出一套**薄**的、可被后续任务卡 import 的驱动库，让「跑一段真实用户旅程」变成写几行声明式步骤。

### 硬性要求

1. **真 Electron**：必须 `app.whenReady()` 起真实 `BrowserWindow`，真实 `capturePage()`。禁止把 DOM stub 或 jsdom 包装成 U1。
2. **每步都有证据**：每一步产出 {步骤名, 动作, 断言, 截图路径, DOM 快照摘要, 时间戳}。失败时保留现场（不清理临时目录）。
3. **必须能失败**：骨架自带一条**故意失败**的示例旅程，证明断言真的会红。这是本卡最关键的自检。
4. **旅程声明式**：用数据描述步骤（导航/点击/输入/等待/断言），不要求每个用例写 200 行 Electron 样板。
5. **可断言的东西要分档**：
   - `dom` —— 元素存在/文本/属性
   - `visual` —— 截图与基准比对（允许标注「仅记录不断言」）
   - `sideEffect` —— 磁盘文件真的变了（用于保存/重开类旅程）
   - **三种都必须能单独开关**，便于某一步只取证不断言
6. **零新依赖优先**：先看现有 Electron + esbuild 能不能做。真要加依赖（如 Playwright 的 Electron 支持），必须在回写里给理由、许可、体积影响。

### 建议的最小 API（可调整，但要写进回写）

```ts
const journey = defineU1Journey({
  name: "genoffice-docs-open-edit-save",
  launch: { userData: temp, env: {...} },
  steps: [
    step.navigate("/"),
    step.click("[data-testid='file-tree'] >> text=blank.docx"),
    step.waitFor("[data-genoffice-editor]"),
    step.assertDom(...),
    step.screenshot("opened"),
    step.type("...", "hello"),
    step.assertSideEffect({ file: "blank.docx", sha256Changed: true }),
  ],
});
```

## 必须覆盖的三条示例旅程（证明骨架可用）

1. **纯 UI**：启动 → 主窗口出现 → 点左栏某项目 → 断言中间面板切换。不需要真实文件。
2. **文件副作用**：打开一个临时 `mcode.db` 副本与临时文档 → 改一个字节 → 保存 → **重开进程** → 断言改动还在。这条证明骨架能验「保存」这类最容易假绿的行为。
3. **故意失败**：断言一个不存在的元素，**必须红**，并把截图与 DOM 快照留在失败的证据目录里。

## 禁止事项

- 不得把 `arc005-visual-baseline` 的 fixture 冒充成 U1。
- 不得为了让骨架「跑绿」而放宽断言。
- 不得在骨架里读写真实用户数据目录；一律 `mktemp -d`。
- 不得宣称 T7/T8/ARC-005 V4 已完成——本卡只交付**框架**。

## 验收判据

1. `bash apps/desktop/scripts/electron-u1/run.sh` 能起真实 Electron 并跑完三条示例旅程。
2. 第二条旅程**在真实重开进程后**断言到改动持久化。
3. 第三条旅程**失败**，且失败证据（截图 + DOM）落盘；脚本以非零码退出。
4. 骨架被至少一个后续卡可直接 import（在回写里给出 import 示例）。
5. 变异验证：把骨架里的断言执行改成「无条件通过」，第三条旅程必须由红变绿——证明它之前真的在判。

## 结果回写（2026-10-23）

### 交付物

新建 `apps/desktop/scripts/electron-u1/`（独占目录，未改 `arc005-visual-baseline/`、产品源码）：

| 文件 | 作用 |
|---|---|
| `driver/types.ts` | 旅程/步骤/证据/结果的数据契约；launch（page/preload/useRealDb/assertions 三档开关） |
| `driver/steps.ts` | 声明式步骤工厂 `step.*` + `defineU1Journey`（校验 kebab-case、failBecause 必填） |
| `driver/verdict.ts` | 判定唯一来源：literalStatus + classifyJourney（all-pass / expected-failure / unexpected-failure）+ 三档退出码 |
| `driver/runner.ts` | 真 Electron 主进程里的执行器：真 `sendInputEvent` 点击、`insertText` 键入、`capturePage`、真 `initDb()`、真 `file:writeFile` handler、relaunch 协议（exit 77 → 新 OS 进程续跑 state.json） |
| `driver/index.ts` | 后续卡唯一 import 入口 |
| `journeys/01-ui-project-switch.ts` | 旅程 1（纯 UI，真 App bundle + api-stub） |
| `journeys/02-file-side-effect.ts` | 旅程 2（临时 mcode.db + 临时文档 + 产品真 preload + 真 IPC + 真重开） |
| `journeys/03-deliberate-failure.ts` | 旅程 3（故意失败 + failBecause 形态自检） |
| `build.mjs` | 构建（App bundle / 产品 preload / runner / journeys / 页面模板）+ 逐旅程逐代 spawn Electron + 变异注入 + 汇总退出码 + 自检 |
| `electron-host.cjs` | 每个 OS 进程的宿主：路径隔离（mktemp runDir/data）、`app.whenReady` → runner |
| `api-stub.js` | 旅程 1 的虚构数据（独立一份，不改 arc005 的） |
| `verify.mjs` | 两趟（正常/变异）的 31 条机器判据 |
| `run.sh` | 正常跑 + 变异跑 + verify；证据留在 `<repo>/.tmp/electron-u1/<ts>/` 永不清理 |
| `README.md` | API、边界、退出码、复用方式、Playwright 评估、未覆盖项 |

### API 设计（与任务卡建议的差异）

任务卡建议 `step.click("[data-testid='file-tree'] >> text=blank.docx")` 这种 Playwright 风格组合选择器。**未采用**，改为 `selector + { text }` 显式参数：Mcode 没有 Playwright 的 selector engine，自解析 `>>` 只会造一套半吊子选择器语法。`step.*` 全集：

`navigate / click(selector, name, {text,button}) / type(selector, text, name, {clear}) / press / waitFor(selector, name, {text,timeoutMs}) / waitForGone / sleep / eval / assertDom(selector, opts, name) / assertEvaluated / screenshot(shot) / assertScreenshotChanged(shot, baseline) / recordSideEffect(file, key) / assertSideEffect(file, opts, name) / relaunch(name, reason)`。

- **三档可独立开关**：`launch.assertions.{dom,visual,sideEffect}`。关掉的档仍执行并记录真实结果到 `observed.actualStatus`，证据标 `skipped:true`，永不判 FAIL（只取证不断言）。
- **路径占位**：`@doc` / `@db` / `@projectDir` / `@home` 由 runner 从启动器 env 解析，旅程文件零硬编码临时路径。
- **exit 77 relaunch 协议**：旅程中 `relaunch` 步骤把 state.json（已完成步、证据、sha256 记录、截图哈希、PID 列表）原子落盘后 `app.exit(77)`；启动器看到 77 就以**新 OS 进程**从下一步继续。证据里每步带 `pid` + `generation`，`generations ≥ 2` 且 PID 不重复由 verify.mjs 强制。

### 三条旅程结果（2026-10-23 实测）

`bash apps/desktop/scripts/electron-u1/run.sh` → `verify: 31/31 判据通过`，脚本退出 0。

| 旅程 | 正常跑结果 | 关键证据 |
|---|---|---|
| 1 `ui-project-switch` | **PASS**（17 步全 PASS，1 个 OS 进程） | 真鼠标点击坐标 (112,281)/(139,312)；两帧截图 sha256 不同；活动标签 `aria-selected` 切换 |
| 2 `file-save-relaunch-persistence` | **PASS**（16 步全 PASS，**2 个 OS 进程** PID 25364→25284） | 保存经真 preload→`file:writeFile`→disk；`disk-doc-rewritten`（sha256 变、含 beta、不含 alpha）；重开后 `db-reopen-project-row`（真 `ProjectRepo.get` 自检）+`doc-still-beta-after-reopen`+`ui-reads-beta-after-reopen` 均 PASS |
| 3 `deliberate-failure` | **FAIL（预期）** → expectation=`expected-failure` | 失败步 `assert-missing-element`；失败截图 `shots/assert-3-fail.png`（161,720 B）+ 完整 DOM `dom/failure-assert-missing-element-g1.html`（377 节点）落盘 |

套件退出码 = 1（正常跑：唯一失败是预期失败）；变异跑 = 0。**因此「全部旅程 PASS」在默认跑里不是期望结果** —— 第三条故意失败旅程必须在。这是设计，已写进 run.sh 文件头与 README。

### 变异证据（验收判据 5）

`node build.mjs --mutation=unconditional-pass` 把 `driver/runner.ts` 里 `assertionStatus()` 的函数体（唯一判定出口）内存替换为 `return "PASS"`（磁盘源码不动，hook 失配会显式报错）。实测：

- 正常跑：`deliberate-failure` literalStatus=**FAIL**，expectation=expected-failure，套件 exit **1**；
- 变异跑：同一条 literalStatus=**PASS**，expectation=all-pass，套件 exit **0**，日志打出 `U1 MUTATION ACTIVE`；
- verify.mjs 第 5 组判据断言这个翻转 + 「变异后不再有任何预期失败旅程」+ 「两趟都没有意外失败旅程」+ 「变异跑里旅程 1/2 仍 all-pass」。

### 验收判据逐条

1. `run.sh` 起真 Electron 跑完三条旅程 —— **达成**（`app.whenReady` + 真 BrowserWindow + 真 capturePage；日志 `sqlite created/opened`、真实 click/relaunch 记录）。
2. 第二条在真实重开进程后断言到持久化 —— **达成**（两代 PID 不同；重开代先读库自检项目行，再断言文件内容/sha256/DOM 读回）。
3. 第三条失败且证据落盘、非零退出 —— **达成**（失败截图 + DOM；正常跑退出码 1）。
4. 可被后续卡 import —— **达成**，示例（同时写在 README）：
   ```ts
   // apps/desktop/scripts/t7-genoffice-u1/journeys/index.ts
   import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
   export const journeys = [defineU1Journey({ name: "genoffice-open-edit-save", launch: { page: "bundle", preload: "product", useRealDb: true }, steps: [...] })];
   // 执行：node ../electron-u1/build.mjs --registry=scripts/t7-genoffice-u1/journeys/index.ts
   ```
5. 变异验证 —— **达成**（见上，红→绿翻转由 verify.mjs 机器核对）。

### Playwright 评估（coordinator 补充要求）

已读 `core/electron-testing.md`、`locators.md`、`assertions-and-waiting.md`、`fixtures-and-hooks.md`、`configuration.md`（前 120 行）。结论：**零新依赖成立，不引入 Playwright**。

- `_electron.launch` + `firstWindow()`：现有 electron-host 模式（`app.whenReady` + `BrowserWindow` + `loadFile`）完全等价；
- `app.evaluate()` 主进程执行：runner 本身就跑在主进程，无需此能力；
- 点击/输入：`webContents.sendInputEvent`（真鼠标坐标）+ `insertText`（真输入栈，React 受控组件可收）已实测通过（旅程 1、2）；
- 重开：`app.exit(77)` + 启动器换进程 + state.json 续跑，Playwright 的 `app.close()`+relaunch 反而更笨重；
- 许可与体积：Playwright 为 Apache-2.0；即使不下载浏览器二进制，core+deps 仍在 ~10MB 量级并引入版本漂移面。其独有能力（trace viewer、自动重试、录屏）均非本卡判据。

### 变更与验证

- **只新增** `apps/desktop/scripts/electron-u1/**` 与本回写区；未改任何只读边界文件（`git status` 里他人的 M 项全部保持原样）。
- `npx tsc --noEmit -p apps/desktop/tsconfig.json` → 0；`packages/contracts` → 0（scripts 在 desktop tsconfig 的 include 里，骨架受类型门禁）。
- 本套件目录名 `electron-u1` 不匹配 `*-smoke` 正则：**有意**——U1 是独立证据等级，不应被 `run-all-smokes.sh` 当 smoke 顺带跑（README 已注明）。

### 未覆盖项（如实）

- T7 / T8 / ARC-005 V4 **未完成**；本卡只交付框架与三条示例。
- `file:writeFile` 的 CAS 冲突分支与并发租约未覆盖（旅程 2 走 happy path + 重开持久化）。
- visual 档只有「两帧必须不同」；没有像素级 baseline 比对（arc005 的 compare.mjs 仍是那件事的负责方）。
- 页面模板抽取只认 journeys 文件里的 `const PAGE = \`…\`` → `<basename>.html`；多页面旅程需自行落盘。
- 旅程 1 的 App bundle 只换 `lib/api`（api-stub）与 `monacoSetup`；其余为真组件。

### 提交

见下方「提交 SHA」。

