# T49｜扩展线的真实缺口：核实与修复

- Status: done（回写见下）
- Category: bug（P1，主界面首帧白屏）
- Priority: P1
- Depends on: 无
- Exclusive writable files: `apps/desktop/src/renderer/components/modules/moduleCatalogShape.tsx`、新建套件 `apps/desktop/scripts/t49-contributions-undefined-smoke/`、本卡。

## Required Skills

- `mcode-smoke`：本仓 smoke 的写法（`esbuild` 打包 + 断言 + 变异验证 + `cmp` 还原）。
- `diagnosing-bugs`：从现象（某个套件红）追到根因（生产首帧解引用 `undefined`）。

## 任务（总控派发，2026-10-23）

1. 实测所有 extension/module 套件；
2. 判断回写里列的三条缺口哪条是真缺口（判据：**用户能不能用**）；
3. 真缺口就做掉，优先渲染端状态面板。

## 结果回写（2026-10-23）

### 1. 实测：29 个 extension/module 套件逐个跑

`ls scripts/ | grep -E "extension|module"` → 28 个套件目录（另有一个 `gen-module-permission-map.mjs` 生成器，不是套件）。

| 结果 | 数量 | 套件 |
|---|---|---|
| **绿** | 28 | extension-authoring(24/24)、extension-bridge(637 assertions)、extension-danger-delegation(36/36)、extension-store(271/271)、extension-workshop(26/26)、library-preview-extension、module-app-call、module-catalog-shape(17/17)、module-catalog(21)、module-catalog-ui(26)、module-consent-copy(13/13)、module-contract(118)、module-executor(30)、module-extension-lifecycle(160/160)、module-file-identity(9/9)、module-grant-revoke-safety(34/34)、module-install-consent、module-permissions、module-phase2-e2e(10)、module-phase2-security(32)、module-platform(33)、module-protocol-integrity(15/15)、module-ui(13)、module-workflow、runtime-node-modules、workflow-extension-seams(12/12) |
| **红** | 1 | **`module-contributions-smoke`（exit=1）** |

跑测试前先过门禁：`git status --porcelain` + `npx tsc --noEmit -p apps/desktop/tsconfig.json`（exit 0）。

### 2. 那条红的根因 = 一个**真实的产品缺陷**

`module-contributions-smoke` 的红不是它自己的问题。它的真 UI 树在挂载
`ModuleViewDock` 时崩在：

```
TypeError: Cannot read properties of undefined (reading 'modules')
    at contributionsOf (moduleCatalogShape.tsx:52)
    at ModuleViewDock
```

**根因**（读生产源码 + 复现确认）：

- `useRpc` 的 `data` 在**第一次请求成功之前恒为 `undefined`**（`useRpc.ts:53-55` 的契约：
  "`undefined` until the first success"）；
- 四个生产调用点都把它直接交给 `contributionsOf`：
  `RightPanel.tsx:123`（**主界面右栏，常驻、无错误边界**）、`CommandPalette.tsx:208`、
  `ModuleContributions.tsx:35`（ModuleViewDock）、`ModuleContributions.tsx:145`（ModuleSettingsPanel）；
- `contributionsOf` 的注释承诺「形状不对时**返回空而不是抛**」，但它先问的
  `moduleCatalogShapeError(catalog)` 把 `undefined` 判成**「还没读到 = 加载态，不是形状错误」**
  并返回 `null`，于是紧接着的 `catalog!.modules` 在首帧解引用 `undefined` → `TypeError`。

**后果**：`RightPanel` 是常驻面板、渲染期直接调用、React 19 主界面没有错误边界 ——
**主界面首帧白屏**。这不是「扩展装不上」，是「开机就白屏」。

> T41 当初就为这个场景写了「形状判据 + 不炸」的承诺（文件头注释），但只挡住了
> 「回包存在但 `modules` 缺失」，漏掉了「回包根本还没到」。

### 3. 修复

`moduleCatalogShape.tsx` 的 `contributionsOf` 增加一行前置判（`undefined` 是加载态，
不是形状错误，但绝不能解引用）：

```ts
if (catalog === undefined || moduleCatalogShapeError(catalog) !== null) return [];
```

同时去掉 `catalog!` 的非空断言（现在类型上已经被收窄，不再需要「我知道它非空」的谎）。

**没有改** `moduleCatalogShapeError` 的语义（`undefined → null` 是对的：它是加载态，
`ModuleCatalogNotice` 靠这个区分「还没读到」与「数据坏了」）。

### 4. 新增回归套件（独占目录）

`apps/desktop/scripts/t49-contributions-undefined-smoke/`（`run.sh` + `main.ts`）：

- **不手抄实现**：按源码结构（参数表配对 `)` → 跳过返回类型里的 `<>` → 函数体配对 `{}`）
  从生产文件切出两个纯函数，交给 **esbuild** 转译后 `import` 真产物；
- 四组断言：①**首帧 `undefined` 不抛、返回空**；②正向对照（正常目录仍返回 1 条 view 贡献，
  防止修成「永远返回空」）；③`slot` 不匹配返回空；④反向对照（`modules` 缺失/非数组仍返回空且能说出原因）。

结果：`t49-contributions-undefined-smoke:7/7 通过`。

**修之前**（同一套件跑在旧代码上）：`6/7`，唯一红的就是
`★ 首帧（data 还是 undefined）时 contributionsOf 不抛、返回空数组` ——
`{"threw":"TypeError: Cannot read properties of undefined (reading 'modules')"}`。

### 5. 变异验证

| 变异 | 结果 |
|---|---|
| 把 `if (catalog === undefined \|\| …)` 改回 `if (moduleCatalogShapeError(catalog) !== null)` | **1 红**（正是首帧那条），`6/7` |
| `cp` 还原 + `cmp` | **逐字节一致**，复跑 `7/7` |

### 6. 回归

修完后重跑模块组六个套件，全绿：

```
module-contributions-smoke       exit=0   10 passed     ← 修前 exit=1（超时崩）
module-catalog-shape-smoke       exit=0   17/17
module-catalog-ui-smoke          exit=0   26 checks
module-ui-smoke                  exit=0   13 browser checks
module-catalog-smoke             exit=0   21 checks, 0 failed
module-consent-copy-smoke        exit=0   13/13
```

**`module-contributions-smoke` 由红转绿**，进一步印证根因判断（它崩的就是那个首帧）。

双包 typecheck：`apps/desktop` exit 0、`packages/contracts` exit 0。

### 7. 三条「已知缺口」的判断（判据：用户能不能用）

| 缺口 | 实证 | 判定 |
|---|---|---|
| **① MERGE-1 的 `storageModule` 注入** | 全仓 `grep storageModule` → **0 处生产/契约代码**，只出现在 `tasks/T14`、`T21` 的**文字**里；它指的是 Node-RED 的 storage 注入点，不是扩展线。扩展线**没有**这个待办。 | **不是扩展线的缺口**（原描述串了线） |
| **② 渲染端无工坊状态面板** | 有 `ModuleSettingsPanel`（设置页 `extension-settings` 分区，扩展自己声明的设置项）、`CapabilityCatalogPanel`（扩展提供的**能力目录**，挂在 `ModuleSurface`→`FilesPanel`）、`ModuleViewDock`（扩展视图面板）。**没有**的是「已装扩展列表 + 每个扩展的健康/权限/最近调用」这一种**工坊状态页**。 | **部分成立**：扩展的**能力**用户看得到（能装、能用、能看到它贡献的视图与设置）；看不到的是「管理视角」的汇总。当前**不阻塞任何使用路径**。 |
| **③ 真 Electron U1** | 本卡未做；扩展的 UI 验证目前是 E1（真 Chromium + 真组件，`module-ui-smoke` 13 条、`module-catalog-ui-smoke` 26 条）。 | **可接受的取舍**：扩展 UI 不依赖 OS 焦点/多窗口/原生弹窗（与 T46 审批卡不同），E1 覆盖足够；真缺口在**主进程装载**那一侧，已有 28 个无头套件覆盖。 |

**结论：本轮唯一真正「用户能不能用」级别的缺口是首帧白屏**（上面第 2 节的缺陷），
它不是那三条里的任何一条，而是核实过程中撞出来的。那三条里：①是串线，
②是管理视角的增强（不阻塞），③是本卡不做的取舍。

### 8. 交付

- 源码：`apps/desktop/src/renderer/components/modules/moduleCatalogShape.tsx`（+9/-2）
- 新套件：`apps/desktop/scripts/t49-contributions-undefined-smoke/`（`run.sh`、`main.ts`）
- 本卡

**未改**：`policy.ts`、`appControl/tools.ts`、`documentToolRuntime.ts`、`runner.ts`、
`electron-u1/`、任何 index/索引文件。

### 9. 提交

`<填于提交后>`
