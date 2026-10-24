# W26｜「设置 → 工作流 → 看到画布」没有任何真 Electron 旅程证明过

- Status: ready-for-agent
- Category: **验收缺口（集成未验）**
- Priority: **P0 —— 用户当面问的正是这件事**
- Depends on: W15（已交付）、W3（已交付）
- 来源：**用户 2026-10-25 原话**：「工作流都在验证什么呀，集成到设置页面了吗，现在的测试我看还是独立的页面」

## 用户问的是什么

**不是「代码有没有集成」，是「我点进去能不能看到」。**

## 现状（我核实的）

### 一、代码是集成的

`apps/desktop/src/renderer/components/settings/SettingsPage.tsx:437-438`：

```tsx
{active === "workflows" && <WorkflowsPanel purpose="workflow" />}
{active === "automation" && <WorkflowsPanel purpose="automation" />}
```

`WorkflowsPanel` 是 `PANEL_LOADERS` 里的一个 lazy 面板（`:57`、`:110`）。

### 二、但没有一条真 Electron 旅程走过这条路

| 套件 | 它跑的是什么 | 能不能证明「用户点得到」 |
|---|---|---|
| `workflow-engine-view-owner-smoke` | **SSR**（`react-dom/server`），`run.sh` 明写「不起 Electron、不碰真 documentViewHost」 | ❌ |
| `workflow-view-smoke` | 同样 SSR | ❌ |
| `workflow-ui-smoke` | 真 Chromium，但 `main.tsx:141` 是 `render(<SettingsPage />)` —— **真组件、假外壳**（自己的 `index.html` + API 桩） | ⚠️ 半个 |
| `t8-node-red-u1`（W1/W2 旅程） | **真 Electron、真 `App.tsx`** | ⚠️ **但它不走设置页** |

**`t8-node-red-u1` 的三条旅程用的是 `harness.openEngineEditor()`**（`harness.ts:240-247`）：

```ts
const result = host.open({
  docId: ENGINE_DOC_ID,
  url: `http://127.0.0.1:${status.port}/`,
  bounds: { ... },
  visible: true,
```

**它直接在宿主层开一个 `WebContentsView`，从来没经过 `SettingsPage` → 工作流页签 → `EngineRuntimePanel` 那条路。**

**所以「引擎能起、画布能拖能连能部署」证明了，但「用户从设置页进得去」没证明。**

## 用户为什么会在意

**因为这正是 W15 改的那件事。** W15 把默认页签从「工作流库列表」改成「Node-RED 画布」——
**而验证它的是一条 SSR 断言**（`purpose: "workflow"` 首帧 engines 面板是 `flex`）。

**SSR 能证明「组件初始状态对」，证明不了：**

- 设置页那个 lazy 面板**真的被挂载了**；
- `EngineRuntimePanel` 的 effect **真的跑了**（SSR 里 effect 完全不跑）；
- `documentView.open` **真的被调了**；
- 那块原生视图**真的显示在用户眼前**，而不是一个空占位。

**最后一条尤其是**：`EngineRuntimePanel` 的核心是 `api.documentView.open(...)` ——
**SSR 里连 `api` 都不存在**（`prelude.ts` 装的是桩）。

## 任务

### 一、加一条真 Electron 旅程：**从设置页点进去**

**不要在 `t8-node-red-u1` 里加**（那是引擎套件，`harness` 是引擎导向的）。
**新建一个旅程**，或者判断能不能放进 `t8` 的 `journeys/` 但走 UI 路径。**你论证。**

**必须走的路径（每一步都要断言）：**

| # | 步 | 判据 |
|---|---|---|
| 1 | 启动真 Electron，应用加载完 | `window.__mounted === true`（`build.mjs` 的 `app-entry.tsx` 已经设了这个） |
| 2 | **点开设置**（真点击，不是改 store） | 设置覆盖层可见 |
| 3 | **点「工作流」页签** | 面板可见 |
| 4 | **默认就落在 Node-RED 画布页签上** | `#workflows-tab-engines` 的 `aria-selected === "true"`，且 engines 面板 `flex` |
| 5 | **引擎在跑时，画布真的出现了** | `documentView` 里存在那个 `docId` 的视图，且 `visible` |
| 6 | **画布能交互**（W1 已经证明过拖拽，这里只需证明「这块画布是那个引擎的」） | 编辑器 `webContents` 的 URL 端口 == 引擎 `status().port` |

**第 5 步是本卡的关键** —— 它是 SSR 完全做不到的那一步。

### 二、启动引擎要走**用户路径**

**W1/W2 是怎么起引擎的**：直接 `registry.startEngine()`。

**用户是怎么起的**：设置 → 工作流 → 引擎页签 → **点「启动」按钮**。

**先查清那条按钮的 selector**（`EngineRuntimePanel.tsx` 里的 `Button`，文案是
`settings.workflows.engine.start`），**然后真点它**。

**如果点它需要等待启动（引擎起进程要几秒）**，用 `waitFor` 等状态变 `running`，**不要 sleep 固定时间**。

### 三、如果发现「点不进去」或「进去是空白」

**那正是本卡最该报告的东西。** 照实写，**不要为了让旅程变绿去改产品代码**。

**特别检查这两件事**（W15 改过）：

1. 有流停靠在右侧时 `flowDocked` 恒真 → 设置页那块是解释文本 + 收回按钮，**不是画布**。
   如果你的旅程里右侧有停靠，第 5 步会看到那块解释而不是画布 —— **那是设计，不是缺陷**，但要在旅程里说清；
2. `nativeCanvasEpoch` 让 `EngineRuntimePanel` 重新 mount —— 切换路径上会不会多开一次视图。

## 验收判据

1. **六个步骤都有断言**，且**第 2、3 步是真点击**（不是改 store、不是 `setState`）；
2. **第 5 步证明「画布真的在显示」** —— 用 `documentView` 的视图存在 + `visible`，
   **不是只看 DOM 里有个 div**（那个 div 是占位，原生视图不在 DOM 里）；
3. **第 6 步证明「是那个引擎的画布」** —— URL 端口对得上；
4. **变异验证**：
   - 把 W15 的 `DEFAULT_WORKFLOWS_VIEW` 改回 `"library"` → **第 4 步必须红**；
   - 把 `EngineRuntimePanel` 的 `open` 那一步注释掉 → **第 5 步必须红**；
   - **第二条是本卡的核心** —— 它证明你验的是「视图真的开了」，不是「组件渲染了」；
5. `tsc` EXIT=0；
6. **不跑全量**。

## 边界

**可以改：**

- `apps/desktop/scripts/t8-node-red-u1/journeys/`（若放这里）
- 新建套件目录
- `apps/desktop/scripts/t8-node-red-u1/harness.ts`（**只追加**，若需要暴露 `documentView` 的查询口）
- `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`（**只追加**）

**不许碰：**

- `apps/desktop/src/**`（**这是验收卡，不改产品代码**）
- `apps/desktop/scripts/mcode-node-pack-smoke/`、`mcode-node-pack-ports-smoke/`、
  `mcode-agent-capability-smoke/`、`mcode-condition-bridge-smoke/`、`workflow-engine-view-owner-smoke/`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

**⚠️ 开工前先看**：`git status --porcelain apps/desktop/scripts/t8-node-red-u1/`
—— **W23 正在改 `journeys/` 和 `editor-flow.ts`。如果它在途，等它，或者只新建文件不碰它改过的那两个。**

## 回写

`tasks/workflow/W26-settings-entry-e2e.md` 末尾追加 `## 结果回写`：

1. 六步实测（每步实际观察到什么）；
2. 第 5 步怎么证明「视图真的在显示」的（贴代码/贴观察值）；
3. 两个变异各红在哪一条；
4. **你在真 App 里看到的东西，和 SSR 断言说的是不是同一件事** ——
   如果不一样，那是最有价值的产出；
5. **你没能验证的东西**；
6. **卡上写错的地方**。

## 一条判断标准

**「组件初始状态对」和「用户点进去看得到」是两件事。**

SSR 断言能证明前者，而且它便宜、快、稳定。**但它证明不了后者，而后才是用户问的。**

---

## ⚠️ 总控补充（2026-10-25 01:10）：**不要从零搭 U1 基础设施**

**上一个执行者跑了 72 分钟、只在读代码、一个字没写。** 我查了原因 —— **是我卡写错了**：

> 「新建套件目录，照 `apps/desktop/scripts/electron-u1/` 的 build/host 机制来」

**听起来像要从零搭整套 U1。实际不用。**

### `electron-u1/build.mjs` 是**可复用**的，靠 `--registry=` 换注册表

```js
const suite = dirname(fileURLToPath(import.meta.url));   // ← 永远是 electron-u1 自己的目录
let registry = join(suite, "journeys/index.ts");         // ← 默认值
...
else if (a.startsWith("--registry=")) registry = resolve(a.slice("--registry=".length));
```

**所以你要做的只有三件：**

1. 写一个**旅程注册表** `apps/desktop/scripts/workflow-settings-entry-u1/journeys/index.ts`
   （照 `t8-node-red-u1/journeys/index.ts` 的形状 —— **注意：必须透出 `failBecause`**，
   那是 W24 刚在 `t30` 上修过的同一处坑）；
2. 写旅程文件；
3. **`node scripts/electron-u1/build.mjs --registry=<你的注册表> --suite=<你的目录>`**
   （具体参数名读 `build.mjs:41-90` 的解析段）。

**`build.mjs` 其余部分（`app-entry.tsx` 打包真 `App.tsx`、preload、runner）全部复用，一行不用改。**

### 你要用的坐标（我已经查好，不用再找）

| 找什么 | 在哪 |
|---|---|
| **用户怎么打开设置** | `LeftBar.tsx:1019` 的 `onClick={() => setSettingsOpen(true)}` |
| 设置覆盖层 | `App.tsx` 的 `SettingsOverlay`（`if (!open) return null`） |
| 工作流页签 | `#workflows-tab-engines` / `#workflows-tab-library` |
| 面板容器 | `#workflows-panel-engines` / `#workflows-panel-library` |
| 引擎启动按钮 | `EngineRuntimePanel.tsx` 里 `settings.workflows.engine.start` 那个 `Button` |
| 视图占位区 | `EngineRuntimePanel.tsx` 的 `data-engine-view-stage=""` |
| 浏览器里判断"挂载了" | `window.__mounted`（`app-entry.tsx` 已设） |

### 引擎怎么起（用户路径，不是 harness 路径）

**`t8` 用 `registry.startEngine()`，那是宿主层。你要点按钮。**

**如果点按钮太脆**（它要等引擎真的起进程），**允许退一步**：用 `window.api.workflowEngine.start({ engineId: "node-red" })`
（渲染端 RPC，等价于按钮背后的调用），**但要在回写里写明「这是 RPC 不是点击」**，
并说明你为什么退。**不要伪造一个点击。**

### 如果环境不允许（O5 改渲染端 / 显示器掉了）

**照实写「判据写好，真跑待环境」**，**不许写「已修复」**。

判别：

```bash
cd apps/desktop
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.txt 2>&1
echo "renderer: $(grep -cE '(^|/)src/renderer/' /tmp/tsc.txt)"
```

**> 0 → O5 批三在途。** 另外如果 `.tmp/electron-u1/<最新>/.../run-g1.log` 里有
`Current display surface not available` 或 `no secondary display`，**那是这台机器的显示环境变了**
（第二显示器在 00:01–00:20 之间掉了，W24 已定位），**不是代码问题**。
