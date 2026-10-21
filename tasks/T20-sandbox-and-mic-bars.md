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
