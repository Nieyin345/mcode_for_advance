# T23｜生产构建与发行 staging 缺四个编辑器的 preload —— 安装包里四个编辑器是坏的

- Status: ready-for-agent
- Category: bug
- Priority: **P0 发行阻断**
- Depends on: none
- Exclusive writable files: `apps/desktop/electron.vite.config.ts`、`apps/desktop/build/stage-genoffice-resources.cjs`、相关构建校验脚本、新建回归套件。**不改** `genoffice/` 上游、`patches/`。

## Required Skills
- `code-review`: 确认修复覆盖生产构建与发行 staging 两条路径，而不只是让测试变绿。
- `mcode-smoke`: 给「生产产物里真有这些文件」建断言，而不是给「测试自己能打包」建断言。

Read before work: `CLAUDE.md`、`docs/planning/product-roadmap/T13-genoffice-baseline.md`（**§0.4 与 §11 必读**）、`apps/desktop/electron.vite.config.ts`、`apps/desktop/build/stage-genoffice-resources.cjs`、`apps/desktop/scripts/arc005-visual-baseline/README.md`。

## T13 已核实的事实（我已独立复验，不要重新发现）

### 缺口一：生产构建不产出 Docs 的 preload

```
grep -n "documentViewPreload" apps/desktop/electron.vite.config.ts
→ 零命中（22 个历史版本也零命中）
```

四个真 Electron 套件（`document-view-*`）各自把 `documentViewPreload` **打包到自己的探针临时目录**，所以它们能绿。**生产构建从来不产出 `out/main/documentViewPreload.js`。**

### 缺口二：发行 staging 只复制两个编辑器的 preload

```js
// stage-genoffice-resources.cjs:434
const nativePreloads = ["sheets", "slides"].map(name => ({
  name, preload: join(vendor, "apps", name, "out", "preload"),
}));
```

而 `EDITOR_APPS` 是**六个**（docs/sheets/slides/pdf/markdown/html）。

**后果**：安装包里 PDF、Markdown、HTML 三个编辑器的原生视图必然 `status=false` 降级。

### 缺口三：vendor 产物旧于补丁 0013

`ai:tool-result` 在 Docs 的 vendor `out/` 产物里 **0 命中**，说明 vendor 构建产物早于补丁 0013。T0 的接线即使代码正确，安装包里也不会生效。

## 为什么这是 P0

**六个编辑器里四个在真实安装包中是坏的，而现有测试全绿。**

绿的机制是「测试自己发包，绕过生产构建与 staging」。这和 CLAUDE.md 警告的假绿是同一类：套件跑绿但根本没覆盖到真实路径。

用户装上这个包，打开 PDF/Markdown/HTML 会降级；Docs 的原生视图根本不工作。

## 目标

三处缺口**全部**修掉，并且证明修的是生产路径。

### 缺口一：生产构建

- 在 `electron.vite.config.ts` 里为 `documentViewPreload` 增加构建入口，产出到生产位置。
- 在 T13 报告所述的四个 `document-view-*` 套件里，**改为消费生产构建产物**（或至少增加一条断言：生产配置声明的入口存在且产物路径与套件使用的一致）。
- 断言方式不限，但**必须证明「生产构建跑完后这个文件真的存在」**，不是「套件自己打包了它」。

### 缺口二：发行 staging

- `nativePreloads` 从 `["sheets","slides"]` 扩到六个编辑器实际需要的集合。
- **先核实**六个编辑器各自是否真的有 `out/preload` 产物；有的必须 stage，没有的要说明为什么不需要（例如 docs 走 Mcode 自己的 preload）。
- staging 的完整性校验要按**实际存在的** preload 集合断言，不能硬编码两个名字。

### 缺口三：vendor 产物陈旧

- 核实 vendor `out/` 的构建时间与补丁 0013 的关系。
- 如果确实陈旧：说明重建流程，并在 staging 时**校验产物包含补丁 0013 的标记**（例如 `ai:tool-result` 出现在预期产物里），不含就 fail-closed。

## 验收判据

1. 跑一次生产构建，**断言 `out/main/documentViewPreload.js` 存在**。
2. 跑 staging，**断言六个编辑器各自需要的 preload 都在安装包布局里**；缺任何一个就失败。
3. 三个 `document-view-*` 类套件不再依赖「自己打包那一个文件」——或至少新增一条断言把生产配置与套件输入绑在一起。
4. 若 vendor 产物陈旧：staging 能检测到并明确报错，而不是静默出一个坏包。
5. **变异验证**：把缺口二改回只 stage 两个 → 第 2 条必须变红；逐字节还原（`cmp`）。
6. 双包 typecheck 通过。
7. **不得**宣称 T7（六编辑器 U1）完成——本卡只修构建与发行链，真实 Electron U1 是 T7。

## 边界

- **不改** `genoffice/` 上游源码、`patches/genoffice/`。若必须重建 vendor 产物，只在回写里记录命令与结果。
- **不碰**正在被 T0 修改的 `document/docsAiPorts.ts`、`document/nativeEditorToolTransport.ts`。
- 若发现修复需要改 `documentViewHost.ts`，先停下报告，另开卡。

## 结果回写（2026-10-23）

### 一、三处缺口的复现证据（实跑，非读码）

**A. 生产构建不产出 Docs preload**

```
$ grep -n "documentViewPreload" apps/desktop/electron.vite.config.ts
（无输出，exit 1）
$ node node_modules/electron-vite/bin/electron-vite.js build     # apps/desktop，EXIT=0
$ ls apps/desktop/out/main/documentViewPreload.js
ls: cannot access ...: No such file or directory
$ find apps/desktop/out -name "documentViewPreload*"
（空）
```

构建本身成功（main/preload/renderer 全部产出），唯独没有该文件；`out/preload/` 只有 `index.mjs` / `browserPicker.mjs` / `browserPicker.cjs`。

**B. staging 只复制两个编辑器 preload**

用生产 staging 函数对真实 vendor 树实跑（许可证严检关闭，属 T9/T11 范畴，与本缺口无关）：

```
docs: preload staged=false
sheets: preload staged=true
slides: preload staged=true
pdf: preload staged=false
markdown: preload staged=false
html: preload staged=false
editorPreloadSha256 keys: sheets,slides
```

六家 vendor 都有 `out/preload/index.js`（docs 29556B / sheets 140575B / slides 22706B / pdf 12731B / markdown 13713B / html 11500B），但 staging 只带两家。

**C. vendor 产物旧于补丁 0013**

```
$ grep -c "ai:tool-result" genoffice/apps/docs/out/renderer/assets/*.js
→ 四个 JS 全部 0
$ grep -rl "aiToolResult\|ai:tool-result" genoffice/apps/docs/out/
（空）
$ ls --time-style=full-iso genoffice/apps/docs/out/preload/index.js
2026-10-18 09:50
$ git log --diff-filter=A -1 -- patches/genoffice/0013-*.patch
2026-10-22 16:07:39 +0800 e0009be4
```

产物时间早于补丁 4 天；源码 `apps/docs/src/renderer/ai/transport.ts:10` 已在用 `window.desktop.aiToolResult`，补丁 0013 的 `ai:tool-result` 路由与 `toolResultAck` 均在 `mcode-view.ts` / `transport.ts` 中，产物里一个都没有。

### 二、修复点

**A → `apps/desktop/electron.vite.config.ts`**

- `preload.build.lib.entry` 增加 `documentViewPreload: "src/main/document/documentViewPreload.ts"`（独立入口，正是四个套件各自 esbuild 的那份源）。
- 新增独立插件 `mcode:document-view-preload`：把该 chunk 转成 CJS、删掉 ESM 孪生、写到 `<outDir>/../main/documentViewPreload.js` —— 与 `documentViewHost.ts:410-419` 的 `join(__dirname, "documentViewPreload.js")` 对齐（该文件被 main entry 打进去，`__dirname` 是 `out/main`）。缺 chunk / 缺 `require("electron")` / 无输出目录一律抛错。
- 原有 picker 插件名 `mcode:browser-picker-sandbox-cjs` 保持不变（`t73-browser-sandbox-smoke` 对它做源码级断言，不越界改它）。

**B → `apps/desktop/build/stage-genoffice-resources.cjs` + `verify-genoffice-editors-after-pack.cjs`**

- 新增 `NATIVE_PRELOAD_KINDS = ["pdf","markdown","html","sheets","slides"]`，注释写明依据：`genofficeViewFactories.ts:17` 的 `NativeKind` 五kind 才挂 vendor `WebContentsView`（`preloadPath = apps/<kind>/out/preload/index.js`）；**docs 不在内**，Docs 视图由 `documentViewHost.ts` 用 Mcode 自己的 `out/main/documentViewPreload.js` 创建，vendor 的独立 docs preload 装进去只是多一份没人用的高权限面。
- `nativePreloads` 改由该常量生成；`editorPreloadSha256` 清单随之扩到五家。
- `verify-...-after-pack.cjs` 的 `preloadNames` 从硬编码 `["sheets","slides"]` 改为 `[...NATIVE_PRELOAD_KINDS]`，清单缺项/多项都拒绝。
- 新增断言把常量绑到运行时契约本身：从 `genofficeViewFactories.ts` 读 `const kinds: readonly NativeKind[] = [...]`，与 `NATIVE_PRELOAD_KINDS` 做集合相等；同时断言 staging 实际目录集合与之相等、`apps/docs/out/preload` 不得出现。

**C → 同两个 build 文件**

- 新增 `assertDocsRendererHasAckTransport(renderer)`：扫描 DocS `index.html` 入口脚本 + `assets/*.js`，要求同时出现补丁 0013 引入的两个渲染端名字 `aiToolResult` 与 `toolResultAck`；缺失即 fail-closed 并给出「先按 pinned HEAD 重建六家 renderer」的明确指引。
- staging 在 `includeEditors` 校验段调用它（**在动旧 stage 之前**，失败不会替换上一份产物）；afterPack 在六个 renderer 摘要校验之后再调一次（摘要一致只证明「包=stage」，证明不了「stage 建于 0013 之后」）。
- **没有重建 vendor 产物**（不写 `genoffice/`）。真实 vendor 树经生产 CLI 入口（`node build/stage-genoffice-resources.cjs`，`MCODE_INCLUDE_GENOFFICE_EDITORS=1`）实跑时，先被 T9/T11 的许可证严检挡住（`GenOffice strict release blocked: full upstream license text is unresolved for 10 packages`，与本卡无关）；改用同一 staging 函数的非严检模式后，0013 门禁立刻 fail-closed：

```
Error: GenOffice docs renderer predates patch 0013 (missing aiToolResult, toolResultAck):
the vendor out/ build is older than the reviewed source. Rebuild the six vendor
renderers from the pinned HEAD before packaging; do not stage a stale build.
```

重建命令（**未执行**，留待有批准时做）：在 `genoffice/` 按 pinned HEAD 对六家跑 `pnpm --filter <app> build`（`electron-vite build`），然后重跑 `MCODE_INCLUDE_GENOFFICE_BUNDLE=1 MCODE_INCLUDE_GENOFFICE_EDITORS=1 node build/stage-genoffice-resources.cjs`。

### 三、生产构建与 staging 的实际产物清单

**生产构建**（`node electron-vite/bin/electron-vite.js build`，EXIT=0）：

```
apps/desktop/out/main/documentViewPreload.js   27797 B   CJS，唯一 require 是 "electron"
  - 内含 installMcodeDocsViewPreload()（vendor mcode-view.ts 编译进来，含 mcode:docs:ai-tool-result）
  - 内含 slidesApi 与 exposeInMainWorld("slidesApi", ...)
apps/desktop/out/preload/index.mjs / browserPicker.mjs / browserPicker.cjs   （原有三项不变）
apps/desktop/out/preload/documentViewPreload.mjs   → 不存在（ESM 孪生已删）
```

**staging**（真实 vendor 树的**临时副本** + 仅副本注入 0013 标记，真 `genoffice/` 一字未动）：

```
docs     preload staged=false   （设计如此，走 Mcode 自己的 preload）
sheets   preload staged=true    140583 B
slides   preload staged=true     22706 B
pdf      preload staged=true     12731 B
markdown preload staged=true     13713 B
html     preload staged=true     11500 B
editorPreloadSha256 keys: html,markdown,pdf,sheets,slides
editorAssetsSha256   keys: docs,html,markdown,pdf,sheets,slides
```

### 四、变异证据

| 变异 | 改法 | 结果 | 还原 |
|---|---|---|---|
| A：删生产配置入口 | 从 `lib.entry` 删 `documentViewPreload` 一行 | 新套件 FAIL `production preload declares documentViewPreload`，随后插件抛 `[mcode:document-view] missing documentViewPreload.mjs preload chunk`，EXIT=1 | `cmp` 逐字节一致，复跑 18/18 |
| B：staging 改回两家 | `NATIVE_PRELOAD_KINDS` 改回 `["sheets","slides"]` | `genoffice-editors-release-smoke` AssertionError（actual `[sheets,slides]` vs expected 五家），EXIT=1 | `cmp` 逐字节一致，复跑 29/29 |
| C：删 staging 的 0013 校验 | 删 `assertDocsRendererHasAckTransport(...)` 调用行 | 该套件 `Missing expected exception`，EXIT=1 | `cmp` 逐字节一致，复跑 29/29 |

另有两处新断言被单独验证会红：afterPack 缺 pdf preload（删文件+删清单项 → `preload integrity manifest` 拒绝）、afterPack 0013 标记（剥标记并同步刷新 digest → 仍被 `0013\|aiToolResult\|toolResultAck` 拒绝）。

### 五、测试结果

- `production-build-preload-smoke`（**新建**）：18/18 PASS
- `genoffice-editors-release-smoke`：29/29 PASS（原 25 条 + 4 条新断言）
- `t76-vendor-release-integrity-smoke`：24/24 PASS（夹具同步五家 preload + 0013 标记）
- `t73-browser-sandbox-smoke`：5/5（picker 插件名与 CJS 产物断言未受影响）
- `document-view-host-smoke`：全套通过；`slides-preload-abi-smoke` 15/15；`genoffice-native-view-smoke` 21/21
- `ipc-wiring-smoke` 45/45；`mobile-static-compress-smoke` 43/43
- `t87-genoffice-provenance-license-smoke`：71/71
- 双包 typecheck：`npx tsc --noEmit -p apps/desktop/tsconfig.json` 与 `-p packages/contracts/tsconfig.json` 均 EXIT=0

**已知既有红（与本卡无关，已用 HEAD 版本文件复验）**：

- `release-readiness-smoke` 的 `check-genoffice.cjs` 在「all six copied vendor editors pass post-pack resource gate」处红：夹具没写 `cliSha256`/`cliDependenciesSha256`/`pdfiumWasmSha256`，`verifyPackagedNativeRuntime` 拒绝。把本卡 5 个改动文件临时还原为 HEAD 版本后**同样红**，失败点与报错一字不差。
- critical 集合中 `claude-ipc-smoke` / `mcp-endpoint-smoke` 红：esbuild 解析不到 `@main/document/genofficeSheetsEntry.js`（`genofficeNativeVendor.ts:13`），套件没配该别名。同样在 HEAD 版本下复验为红。这两项属套件与 T29 vendor 接线的旧缺口，不在本卡文件边界内。

### 六、提交

提交：`239eb863e9e9d9903cf6569241c7743c1e84e255` — `fix(T23): ship every native preload and fail closed on a stale Docs renderer`（8 files changed, 492 insertions(+), 25 deletions(-)）。提交后已在该提交状态重跑：production-build-preload-smoke 18/18、genoffice-editors-release-smoke 29/29、t76 24/24、t73 5/5，双包 typecheck 均通过。

### 七、仍需 T7 覆盖的 U1 项（本卡不宣称）

1. 重建六家 vendor 产物后，Docs 页在**安装包形态**下真实加载 `out/main/documentViewPreload.js` 并挂载（首帧零未捕获异常、`#root` 有子树、`window.desktop` 桥可用）。
2. PDF / Markdown / HTML 三家在安装包里打开→编辑→保存→重开（本卡只保证 preload 与 renderer 进了包，没验证运行行为）。
3. Sheets 的 Rust sidecar 与 Slides 双路线在安装包形态下的保存所有权/时序。
4. 补丁 0013 的 ACK 在真实三 SDK 在线回合中的同轮往返（T0 的真实在线回合另卡）。
5. `document.capabilities.hosts.*` 与安装包真实能力的一致性核对。

