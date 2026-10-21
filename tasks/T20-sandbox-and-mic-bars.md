# T20｜工件预览沙箱 + 语音活动条（第三批逆向件）

| 项目 | 值 |
|---|---|
| 编号 | T20 |
| 类型 | ARC-005 UI + 安全（复用 `open-claude-ui`） |
| 优先级 | 中高 |
| 建议并发 | 只改渲染端，可与 T05c / T19 并行 |
| 预计规模 | 中 |

---

## 两个件，性质完全不同

| 件 | 行数 | 性质 | 为什么值得做 |
|---|---|---|---|
| **`EpitaxyIframeBridge.tsx`** | 97 | **安全** | 严格移除 `allow-same-origin`、`event.userActivation` 手势门禁、7 种 MIME 分流。Mcode 现在有 HTML 预览，但没这套沙箱规则 |
| **`LiveMicActivityBars.tsx`** | 183 | **UI** | 语音输入时的活动条（`idle`/`connecting`/`active` 三态，音频流驱动的高度动画） |

**先做 Epitaxy**——它是安全边界，比视觉重要。

---

## 第 1 件：EpitaxyIframeBridge（安全）

### 现状

Mcode 有 HTML 预览（`fileEditorKinds.ts` 的 `canPreviewHtml`，走
`openUrlInBrowser` 或内嵌预览）。但它**没有**这套沙箱规则：

- 是否移除了 `allow-same-origin`？
- 是否有 `event.userActivation` 门禁？
- MIME 怎么分流？

### 要做

1. **先审计现状**：找到 Mcode 所有加载不可信 HTML 的地方（浏览器面板、
   HTML 预览、自定义 UI 槽位、模块 UI），逐个看 sandbox 属性。
2. **照抄 Epitaxy 的三条规则**：
   - 严格 `sandbox` 不含 `allow-same-origin`
   - `event.userActivation` 才能触发敏感操作
   - MIME 分流（7 种）
3. **补断言**：每个加载点都有 sandbox 属性，且不含 `allow-same-origin`。

⚠️ **如果 Mcode 已经在用 `WebContentsView` 而不是 iframe**，那 sandbox 属性的
语义不同——要在回写区说明，然后按 `WebContentsView` 的等价手段（`webPreferences`
的 `sandbox`/`contextIsolation`/`nodeIntegration`）落实同样的隔离。

---

## 第 2 件：LiveMicActivityBars（UI）

### 现状

`MicButton.tsx` 已经有了（277 行），但**没有活动条**——录音时只有按钮变色。

### 要做

- 复用 `useVoiceInput.ts` 的现有状态（`idle`/`connecting`/`active`）
- 照抄三态与高度动画规则
- **不要用 framer-motion**：它用的是 `useMotionValue` + `motion.div`，
  Mcode 用 CSS `@keyframes` + `requestAnimationFrame` 即可（仓库已有
  `live-eq-bounce` 这类均衡器动画可参考）
- 接真实 `MediaStream`（如果 `useVoiceInput` 已经拿到）

**注意**：这件的价值低于第 1 件。如果第 1 件做完时间不够，这件可以跳过并说明。

---

## 开工前必读

1. 两个逆向件**全文**。
2. `apps/desktop/src/renderer/components/ide/fileEditorKinds.ts` ——
   `canPreviewHtml` 与 `htmlPreviewDecision`。
3. `apps/desktop/src/renderer/components/browser/BrowserPanel.tsx` ——
   浏览器面板，看它怎么加载页面（WebContentsView 还是 iframe）。
4. `apps/desktop/src/main/document/documentViewHost.ts` —— `WebContentsView`
   的 sandbox 配置。
5. `apps/desktop/src/renderer/components/chat/MicButton.tsx` 与
   `hooks/useVoiceInput.ts`。
6. `apps/desktop/src/renderer/components/customUi/` —— 自定义 UI 槽位是否
   加载不可信 HTML。

---

## 边界（不要碰）

- 只改渲染端 + `documentViewHost` 的 sandbox 配置（如果确实需要）。
- 不改 `genoffice/`、`workflowEngines/`、`modules/`。
- 不引入 framer-motion。
- 不改 `MicButton.tsx` 的既有行为（只在旁边加活动条）。

---

## 验收判据

1. **第 1 件**：所有加载不可信内容的点都有 sandbox 隔离，且不含
   `allow-same-origin`（有断言，逐点列出）。
2. **第 1 件**：`event.userActivation` 门禁有断言（合成事件不能触发）。
3. **第 2 件**：三态切换有行为断言；不用 framer-motion；尊重 reduced motion。
4. 现有 `html-preview-electron-smoke`、`browser-*` smoke 全绿。
5. 双包 tsc 干净。
6. **变异验证**：把 `allow-same-origin` 加回去 → 断言必红。

---

## 回写区要回答

- Mcode 加载不可信 HTML 的点一共有几个？各自的 sandbox 现状是什么？
- 是 iframe 还是 WebContentsView？两者的隔离手段怎么对应？
- 第 2 件做了没有？没做的话为什么？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜执行回写（T20；源码提交 `442006052bbd00fc3e7f78b771755de586767777`）

**范围与现状审计（E2）**：加载非宿主 HTML 的实际入口共四类：
1. `apps/desktop/src/renderer/components/customUi/PanelFrame.tsx`：**iframe**，`sandbox="allow-scripts allow-forms allow-modals"`、无 `allow-same-origin`，已满足隔离；本轮新增原文断言和变异红例。
2. `apps/desktop/src/main/browser/BrowserManager.ts`：浏览器面板和 `htmlPreviewDecision → openUrlInBrowser` 复用同一 **WebContentsView**，`contextIsolation:true`、`nodeIntegration:false`，但 **`sandbox:false`**。原因是 `browserPicker.mjs` ESM preload 依赖非沙箱加载。本任务明令只允许改渲染端及必要的 `documentViewHost`，不能在 T20 擅改该主进程文件/预加载器，故验收 1 **未达成**。
3. `apps/desktop/src/main/document/documentViewHost.ts`：文档/工作流编辑器 **WebContentsView**，`sandbox:true` + `contextIsolation:true` + `nodeIntegration:false`，无须改动（该文件在并行开发中曾有未提交改动，T20 未覆盖）。
4. `apps/desktop/src/main/browser/browserManagerSupport.ts` 的打印 PDF 隐藏 **BrowserWindow**：`sandbox:true`；不属于 iframe。
`apps/desktop/src/main/window.ts` 是可信宿主窗口（非加载不可信页面入口），不计入这四类。WebContentsView 不存在 HTML `sandbox` 属性；以 Electron `webPreferences` 三项和浏览器会话分区作等价审计。

**实际改动**：
- 新增 `EpitaxyIframeBridge.tsx` 与 `epitaxySecurity.ts`：7 个 MIME 精确分流，HTML/SVG 使用禁 `allow-same-origin` 的沙箱 iframe，其他 5 类仅以转义文本展示，未知 MIME fail-closed；校验消息来自 iframe、opaque `null` origin，敏感通道仅在 `event.userActivation?.isActive` 且 `isTrusted` 时放行。特别**不**使用容易被宿主先前点击污染的 `navigator.userActivation.hasBeenActive`。Chromium 普通 MessageEvent 可能根本不提供 `userActivation`，此时拒绝操作而非放宽门禁。注意：当前 Mcode 没有把 7 MIME 工件接入已有浏览器文件预览；此组件尚无生产调用方，**不能以该组件的断言冒充原有自定义面板消息桥全面安全**（验收 2 未完全覆盖实际加载链）。
- 新增 `LiveMicActivityBars.tsx`：六个独立 FFT 频段、connecting CSS 交错动画、active 用真 `MediaStream` 和 RAF 更新高度，idle 静态；复用现有 `useTickerReducedMotion`（系统与用户自定），停止/卸载释放 AudioContext 与 RAF；无 framer-motion。仅给 `useVoiceInput` 暴露现有音频流、在 `MicButton` 旁添加装饰性条，录音按钮既有 start/stop/cancel/快捷键行为不变。

**验证（E1）**：
- `node apps/desktop/scripts/run-smokes.mjs t20-sandbox-mic-smoke`：PASS（7 MIME、iframe 与 WebContentsView 静态配置、合成消息门禁、三态、6 频段、reduced motion、FFT 资源回收）。
- `node apps/desktop/scripts/t20-sandbox-mic-smoke/mutate.mjs`：PASS；精确向 `PanelFrame` 的 iframe 添加 `allow-same-origin` 后，原断言**变红**，并校验源码逐字节还原。再跑 T20 smoke PASS。
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` 和 `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`：双包 PASS。
- `node apps/desktop/scripts/run-smokes.mjs html-preview-electron-smoke browser-smoke browser-file-url-boundary-smoke browser-occluder-rect-smoke browser-pure-smoke browser-script-injection-smoke browser-tabs-a11y-smoke browser-tool-parity-smoke browser-uuid-entropy-smoke custom-ui-smoke`：9 PASS / 1 FAIL。失败项 `html-preview-electron-smoke`：`Timed out: initial blank tab`；单独复跑仍同样失败。两次失败日志位于 `apps/desktop/.tmp/smoke-runs/1792550979121-35224-Vpzbsy`、`1792551033324-27776-8Slv6J`，因此**不能**声明验收 4 达成。

**验收逐条**：1 未达成（BrowserManager sandbox:false）；2 部分达成（新 Epitaxy 桥纯函数与渲染断言已绿，但原有 PanelFrame 消息链未统一走门禁）；3 达成（有三态/音频行为的隔离断言，未做真麦克风 U1）；4 未达成（HTML 预览 Electron 用例两次红）；5 达成；6 达成。**剩余边界**应另由浏览器宿主负责人处理，T20 不越权修改 `BrowserManager` 或其 ESM preload。
