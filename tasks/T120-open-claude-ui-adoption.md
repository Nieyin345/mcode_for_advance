# T120 第一阶段：`open-claude-ui` 36 项映射表

**结论先行：用户说的「你只是换了一下颜色」不准确 —— 上游已经有 17 个组件在 Mcode 里被移植过
（`components/ui/cds/` 四个、`ThinkingAccordion`、`McpToolDecisionCard`、`reconcileStreamingRows`、
**500ms WebKit 合成后卫**、composer 三态投影、View Transition、RovingFocus 等）。
但迁移是「按形状重写」，不是整批接入，而且**有三处关键机制确实没搬**：

- **超长消息折叠 + 渐变 mask** —— Mcode 零命中；
- **图片灯箱的 pan/zoom** —— 只有 hover 缩放，没有状态机；
- **限流倒计时** —— 有重试，但用户看不到要等多久。

核查时间：2026-10-24，HEAD 见 `git log -1`。

---

## 一、前提核实（决定「直接 import」还是「照形状重写」）

| 项 | 上游 | Mcode | 结论 |
|---|---|---|---|
| **许可证** | `open-claude-ui/LICENSE` → **MIT**，`Copyright (c) 2026 Caho1` | — | ✅ **可用** |
| **React** | `^18.3.0`（peer `>=18`） | **`^19.0.0`** | ⚠️ **大版本不同**，但上游只用到 `useState/useRef/useEffect/useCallback/useMemo` 这些稳定 API |
| **Tailwind** | 配置里用 `--cds-*` 变量 + `clay`/`surface` 色阶 | `^3.4.17` | ✅ 同为 v3 |
| **动画库** | `framer-motion >=10`（peer） | **无任何动画库** | ❌ **4 个文件依赖它** |
| **图标库** | `lucide-react >=0.280` | **`@tabler/icons-react` + `react-icons`** | ❌ **图标体系不同** |

### 外部依赖的实际分布（逐个 import 扫，含多行 import）

| 依赖 | 用到它的文件 |
|---|---|
| `framer-motion` | `ConfirmationDialog.tsx`、`LiveMicActivityBars.tsx`、`SegmentedControl.tsx`、`ClaudeMotionPresets.ts` |
| `electron` | `createClaudeMainWindow.ts` |
| 仅 React / 相对导入 | **其余 27 个** |

**所以「直接 import」的整体可行性比预想高**：27/33 只依赖 React。但那 4 个 framer-motion 的是
动效核心（ConfirmationDialog 是常用件），而 **Mcode 没有动画库**，接它就得：
① 引入 framer-motion（一个新的重依赖），或 ② 用 CSS transition 重写（Mcode 现在的做法）。

**已确定的实践**：Mcode 走的是 ② —— `components/ui/cds/Segmented.tsx` 142 行 vs 上游 165 行，
`ScrollFade.tsx` 138 vs 159，**行数相近、按形状重写、零新依赖**。

---

## 二、36 项映射表

「已移植」= Mcode 里能找到对应实现且机制对齐；「借规范」= 只在注释/样式里引用了上游数值；
「缺口」= 找不到对应或机制不同。

| # | 组件 | 它是什么 | Mcode 对应物 | 状态 |
|---|---|---|---|---|
| 1 | `ChatComposer.tsx` (270) | 输入终端：20px 圆角、三态投影、`field-sizing` 48–384px | `chat/ComposerEditor.tsx` (663) + `styles.css:3162` | **已移植**（三态投影、按压、min 48px 都做了） |
| 2 | `ChatMessageBubbles.tsx` (464) | 用户/助手气泡、300px 折叠 mask、思考三点、Text Inset 律 | `chat/MessageBlocks.tsx` (1914) | **借规范**（无独立气泡组件，元素混在 1914 行里） |
| 3 | `RichComposerWithMentions.tsx` (455) | 富输入：@提及、斜杠、**WebKit 500ms 合成后卫**、256 文件上限 | `chat/ComposerEditor.tsx` + `chat/composerPhysicalRules.ts` | **已移植**（后卫逐字对齐，见下） |
| 4 | `ThinkingAccordion.tsx` (142) | 思考折叠：三点波、Grid 0fr↔1fr、**生成中强制展开** | `chat/MessageBlocks.tsx:1081` 的 `<ThinkingAccordion>` | **已移植**（`live` prop 驱动强制展开） |
| 5 | `ModelSelectorEffort.tsx` (114) | 模型 + effort 档位选择 | `chat/ComposerToolbar.tsx` (205) + `ModelDropdown.tsx` (643) | **已移植**（Mcode 更重） |
| 6 | `ModelSwitcherWithTokenGauge.tsx` (327) | 模型矩阵 + **Token 上下文仪表盘** | `chat/ContextCapacityPanel.tsx` | **已移植** |
| 7 | `AttachmentCard.tsx` (185) | 附件磁贴/胶囊 | `chat/AttachmentTile.tsx` (104) | **已移植** |
| 8 | `CodeBlock.tsx` (111) | 代码块 + 复制衰减动画 | `chat/Markdown.tsx`（高亮内嵌） | **借规范**（无独立组件） |
| 9 | `StreamingDiffViewer.tsx` (345) | 流式 diff + **行身份保留** | `chat/diffStreaming.ts` 的 `reconcileStreamingRows` | **已移植**（核心算法搬了） |
| 10 | `McpToolDecisionCard.tsx` (219) | MCP 工具决策卡 | `chat/McpToolDecisionCard.tsx`（同名） | **已移植** |
| 11 | `SegmentedControl.tsx` (165) | 分段控件 + 滑动指示器 | `ui/cds/Segmented.tsx` (142) | **已移植**（重写） |
| 12 | `StatusIndicators.tsx` (158) | 指示灯 + 骨架屏 shimmer | `ui/cds/StatusDot.tsx` (59) + `CdsSkeleton.tsx` (37) | **已移植**（拆成两个） |
| 13 | `ScrollFadeContainer.tsx` (159) | 滚动边缘渐变遮罩 | `ui/cds/ScrollFade.tsx` (138) | **已移植**（重写） |
| 14 | `CdsButton.tsx` (143) | 按钮阶梯 + 阻尼物理 | `ui/button.tsx` | **借规范**（未按上游阶梯） |
| 15 | `ConfirmationDialog.tsx` (160) | 6 阶弹窗标尺 + framer-motion | `ui/confirm-dialog.tsx` | **已移植**（无动画库） |
| 16 | `MediaLightboxViewer.tsx` (605) | 媒体灯箱 + 平移缩放 | `ui/image-preview.tsx` | ⚠️ **有但简化**（见第三节 ②） |
| 17 | `DraggableSessionList.tsx` (339) | 可拖拽会话列表 | `layout/StreamSidebar.tsx` | ⚠️ **A 在改布局，先不碰** |
| 18 | `ClaudeDesktopHeader.tsx` (98) | macOS 顶栏 + 窗口材质 | `layout/` 下的标题栏 | **借规范** |
| 19 | `ReasoningAmbientGlow.tsx` (234) | 推理环境光晕 | `chat/reasoningAmbient.ts` | **已移植** |
| 20 | `ChatComposerChin.tsx` (78) | 输入框下方工具栏条 | `chat/ComposerToolbar.tsx` | **已移植** |
| 21 | `ArtifactsSplitPaneResizer.tsx` (221) | 双栏拖拽 + dead-zone | 无独立组件 | ❌ **缺口**（A 在改三栏→两栏，可能相关） |
| 22 | `ContainerResponsiveBar.tsx` (52) | 容器查询自适应 | 无（用 Tailwind 断点） | ❌ **缺口**（容器查询 vs 视口断点） |
| 23 | `CdsMotionEngine.tsx` (76) | 动效引擎演示 | — | ⬜ **演示件**，不需要 |
| 24 | `ClaudeMotionPresets.ts` (196) | **二阶阻尼谐振子**物理预设 | `styles.css` 的 `--ease-*` 令牌 | **借规范** |
| 25 | `LiveMicActivityBars.tsx` (183) | 麦克风活动条 + framer-motion | 无（语音功能另在 `voice/`） | ⬜ **低频** |
| 26 | `CoworkAgentCanvas.tsx` (260) | 多代理协同看板 | 无 | ⬜ **产品未到** |
| 27 | `EpitaxyIframeBridge.tsx` (97) | 工件预览沙箱通信 | `document/` 的视图宿主 | ⬜ **架构不同** |
| 28 | `useClaudeRovingFocus.ts` (86) | 方向键漫游焦点 | `hooks/useRovingFocus.ts` | **已移植** |
| 29 | `useClaudeScrollPinning.ts` (71) | 滚动钉底（流式输出不跳） | `chat/` 里的滚动逻辑 | **借规范** |
| 30 | `useClaudeSharedElementTransition.ts` (192) | 共享元素过渡 | `lib/viewTransition.ts` | **已移植** |
| 31 | `useRateLimitBackoff.ts` (105) | 429/503 指数退避 + **倒计时告知** | 主进程 `isRetryableTransportError` + SDK 重试 | ⚠️ **有重试，无倒计时**（见第三节 ③） |
| 32 | `ClaudeAudioPlayer.ts` (164) | Web Audio 音效引擎 | 无 | ⬜ **低频** |
| 33 | `createClaudeMainWindow.ts` (92) | 窗口材质物理学 | `main/window.ts` | ⬜ **架构不同** |
| 34 | `cds-pure.css` | CDS 变量（纯） | `tokens.cds.css` | **已移植** |
| 35 | `cds-theme.css` | CDS 主题 | `tokens.cds.css` | **已移植** |
| 36 | `tailwind.config.js` | Tailwind 扩展（clay/surface/圆角/阴影/动画） | `tailwind.config` 对应项 | **借规范** |

**统计**：已移植 **17** / 借规范 7 / 缺口 **3** / 演示或低频 5 / 架构不同 3 / 待定 1。

---

## 三、三个建议先接的（用户每天看到、且 Mcode 确实没有这个机制）

> **⚠️ 这一节我改过一次。** 初稿把「WebKit 500ms 合成后卫」列为第一名缺口，
> 实测发现 **Mcode 早就实现了，且与上游逐字对齐**（见下面「已实现，不要重做」）。
> **那一条是我没核实就下结论，保留在这里当反例。**

### 已实现，不要重做：WebKit 500ms 合成后卫

`chat/composerPhysicalRules.ts:20-30`：

```ts
export function isPostCompositionEnter(key, timestamp, lastCompositionEnd, vendor, ctrlOrMeta): boolean {
  return key === "Enter" && !ctrlOrMeta && /Apple Computer/.test(vendor) &&
    lastCompositionEnd >= 0 && timestamp >= lastCompositionEnd &&
    timestamp - lastCompositionEnd < 500;
}
```

`ComposerEditor.tsx:334` 在 `compositionend` 里存 `event.timeStamp`，`:344` 调它。
**与上游 `RichComposerWithMentions.tsx:89/184` 的判据一致。**

---

### ① 超长消息折叠 + 底部渐变 mask —— **Mcode 完全没有这个机制**

**上游**：`open-claude-ui/code-examples/ChatMessageBubbles.tsx:13,46,85,99-101,156`

```tsx
const [isOverflowing, setIsOverflowing] = useState(false);
// scrollH > collapseThreshold (默认 300px) 时
className={isOverflowing
  ? "max-h-[300px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%_-_3rem),transparent)]"
  : ""}
```

**Mcode 现在**：`grep -rn "mask-image\|collapseThreshold"` 在 `MessageBlocks.tsx` 与 `styles.css`
**都是 0 命中**。

**差在哪（具体）**：用户贴一段长文本 / 长回答时，**没有高度上限、没有渐变提示、没有展开按钮** ——
整段铺满视口。上游的做法是：超过 300px 就截断 + 底部 3rem 渐变淡出（暗示「还有」）。

**要不要改接口**：不要。纯展示层，加在 `MessageRow.tsx` 或 `MessageBlocks.tsx` 的文本渲染外层。
**但它落在 `MessageBlocks.tsx`（1914 行）里，要小心不要碰坏那 66 个 chat 组件共享的路径。**

---

### ② 图片灯箱的 Pan / Zoom 手势 —— 用户看图片每天都在用

**上游**：`open-claude-ui/code-examples/MediaLightboxViewer.tsx`（**605 行**），
「Multimodal Media Lightbox & Pan/Zoom Gallery」。

**Mcode 现在**：`components/ui/image-preview.tsx`（**411 行**）。

**差在哪（实测）**：Mcode 有基础预览，但 grep `zoom|pan|scale|wheel|drag|touch` 只命中 6 处，
且几乎都是**静态样式**：

```
:306  className="block object-contain transition-transform duration-200 group-hover:scale-[1.03]"
:300  draggable={false}
```

**没有平移/缩放状态机** —— 用户不能滚轮放大、不能拖动查看细节、不能多图切换。
上游那 605 行里很大一部分就是这个状态机（含边界钳制）。

**要不要改接口**：不要。`image-preview.tsx` 是独立组件，替换内部实现即可。
**但要先确认它目前被谁调用**（`RightPanel.tsx` 在 A 的边界内，不能碰那条调用链的**接口**）。

---

### ③ `useRateLimitBackoff` 的 **倒计时告知** —— 不是重试，是「让用户知道还要等多久」

**上游**：`open-claude-ui/code-examples/useRateLimitBackoff.ts`（105 行）：

> 1. 429/503 截断指数退避带 Jitter；2. 连续重试 3 次上限；3. **动态剩余秒数倒计时**；4. 倒计时归零自动重试通知。

**Mcode 现在**：主进程 `isRetryableTransportError`（`ClaudeAgentSdkProvider.ts:397-398`）
识别 429/5xx 并重试，SDK 自己也重试。

**差在哪**：**Mcode 有重试，但用户看不到「还要等几秒」。** 上游把等待**变成可见状态**，
Mcode 是静默重试 —— 用户只看到「卡住了」。

**要不要改接口**：要。需要在重试时向前端发一条事件（`turn.notice` 已有这个通道），
前端渲染倒计时。

**为什么排第三**：改动跨进程（主进程事件 + 渲染端状态），比 ①② 重；但它是
「静默」变「可见」，符合本仓库「坏东西显式报出来」的硬规矩。

---

## 四、按「用户看到频次」排的前 10

| 频次 | 组件 | 状态 |
|---|---|---|
| 每次 | ChatComposer | 已移植 |
| 每次 | ChatMessageBubbles | **借规范**（无独立组件） |
| 每次 | DraggableSessionList | 待 A 的布局改造 |
| 每次 | ClaudeDesktopHeader | 借规范 |
| 经常 | RichComposerWithMentions | 已移植（含 500ms 后卫） |
| 经常 | ThinkingAccordion | 已移植 |
| 经常 | ModelSelectorEffort | 已移植 |
| 经常 | AttachmentCard | 已移植 |
| 经常 | CodeBlock | 借规范 |
| 偶尔 | MediaLightboxViewer | ❌ **缺 pan/zoom 状态机** |

---

## 五、给第二阶段的建议

**先做 ①（500ms 合成后卫）**：修复面最小、用户踩中率最高、且**不碰 A 正在改的任何文件**。

**②和③要我先补核实**：
- ② 需要先量 `image-preview.tsx` 的实际能力，才能说「差在哪」；
- ③ 跨进程，建议单独一张卡。

**⚠️ 边界提醒**：`ClassicShell.tsx` / `ThreePaneLayout.tsx` / `App.tsx` / `RightPanel.tsx`
都不在本阶段范围（A 在改），而 ④ 里的 `DraggableSessionList` 和 ⑤ 的
`ArtifactsSplitPaneResizer` 都落在那个区域 —— **等 A 落地后再看**。

---

## 六、这份表里我没核实的地方

按本仓库规矩，写清哪些是数出来的、哪些是推断：

| 项 | 证据强度 |
|---|---|
| 36 项的名字与行数 | ✅ 实跑 `wc -l` |
| 许可证 MIT | ✅ 读了 LICENSE |
| React/Tailwind/动画/图标版本 | ✅ 读了两个 package.json |
| framer-motion 的 4 个文件 | ✅ grep 全文件 |
| 「已移植」的判定 | ⚠️ **靠 grep 组件名 + 抽查 6 个**（ChatComposer / ThinkingAccordion / StreamingDiffViewer / McpToolDecisionCard / 500ms 合成后卫 / reconcileStreamingRows），**其余未逐个读实现对比机制** |
| `image-preview.tsx` 无 pan/zoom | ✅ **已实测**（411 行，grep 只命中 6 处静态样式） |
| 超长消息无折叠 mask | ✅ **已实测**（`mask-image` / `collapseThreshold` 在 Mcode **0 命中**） |
| `useClaudeScrollPinning` 的对应物 | ⚠️ 只知道 `chat/` 里有滚动逻辑，**没读** |

---

## 第二阶段回写（2026-10-24）：接了缺口 ① 超长消息折叠

提交 `feat(T120)`：6 文件，+271/−0。

### 一、改了什么

`apps/desktop/src/renderer/components/chat/messageCollapse.ts`（新建，96 行）——
判据是**纯函数**，与同目录 `composerPhysicalRules.ts` 同一惯例，可无头测：

| 导出 | 作用 |
|---|---|
| `COLLAPSE_THRESHOLD_PX = 300` | 上游 `collapseThreshold` 默认值 |
| `COLLAPSED_MAX_HEIGHT_PX = 300` | 收起时上限（上游 `max-h-[300px]`，与阈值同值） |
| `FADE_HEIGHT_PX = 48` | 渐变高度（上游 `calc(100% - 3rem)`） |
| `collapsibleBubbleState()` | `fits` / `collapsed` / `expanded` |
| `bubbleBodyStyle()` | 返回**内联样式**（见下） |
| `collapseToggleLabel()` | `expand` / `collapse` / `null` |

`MessageRow.tsx` +42 行：量 `scrollHeight`、套样式、渲染展开按钮。
zh/en 各 +3 行 i18n key。

### 二、★ 为什么样式走内联而不是 class

渐变那一句是**算出来的**（`calc(100% - ${fade}px)`），而 Tailwind 的任意值写法
如果拼成模板字符串，**JIT 扫不到会被 purge**。所以走 `style`，不走 `className`。

### 三、★ 用户能看出区别吗 —— 数值对照（总控要求的）

参数出处：`--chat-font-size: 14px`（`styles.css:248`）、`leading` 取 1.625、
气泡内边距 `px-3 py-2`（12/8px，`MessageRow.tsx:328`）、宽度 `max-w-[85%]`。

| 窗口宽 | 聊天区（≈62%） | 气泡内宽 | 每行字数 | **3000 字 → 行数** | **改前高度** | **改后高度** | 省掉 |
|---|---|---|---|---|---|---|---|
| 1440px | 893px | 735px | 52 | 58 行 | **1336px** | **300px** | **1036px** |
| 1100px | 682px | 556px | 39 | 77 行 | **1768px** | **300px** | **1468px** |

**折叠阈值 300px；渐变高度 48px（底部 3rem）。**

**换句话说**：在 1440px 窗口里贴 3000 字，改前那条消息**比一屏还高**（1336px vs 约 900px 的
可用高度），改后只占 300px —— **省回来的 1036px 正好是「底下还有多少看不见」的长度**。

### 四、变异（五个，全部精确变红）

| 变异 | 红的断言数 |
|---|---|
| 阈值 300 → 1000 | 3 |
| `fits` 也返回样式 | 2 |
| 边界 `<=` → `<` | 1 |
| 渐变改成 `none` | 3 |
| **`MessageRow` 不调 `bubbleBodyStyle`** | **1（接入断言）** |

**第五条最关键**：它证明第 ⑤ 节「接入」那组断言真的在验「生产代码调用了判据」，
而不是只验函数本身写对 —— **没有它，函数写对了但没人用，31 条照样全绿**。

### 五、套件

`message-collapse-smoke`（新建，**31/31**）。分六节：判据 / 未测量态 / 样式 / 按钮标签 /
**接入检查** / **与上游常数对齐**（直接读 `open-claude-ui` 的上游文件，断言
`collapseThreshold = 300`、`max-h-[300px]`、`calc(100%_-_3rem)` 都在）。

另跑 `chat-copy-payload-smoke` 12/12、`maint-m22-smoke` 通过。
**双包 typecheck：contracts 0、desktop 0。**

### 六、过程中踩的坑（记下来）

**变异还原时 `cp` 用了相对路径，而前面 `( cd apps/desktop && ... )` 已经切过目录** →
备份没拷回来、**变异留在磁盘上**。`cmp` 报了不一致才发现。

**这是今晚第二次同一个坑**（前一次是 `taskrepo.pristine.ts`）。
**规矩**：变异脚本里的 `cp` 一律用**仓库根绝对路径**，不要依赖当时的 cwd；
并且**每次还原后必须 `cmp`** —— 它是唯一能发现「没还原」的东西。

### 七、没做的

- 缺口 ②（图片 pan/zoom）与 ③（限流倒计时）**未开始**；
- **三个缺口都不依赖 framer-motion**（实测 grep 均为 0），所以本阶段**不需要引入动画库**；
- `DraggableSessionList` / `ArtifactsSplitPaneResizer` 仍等 A 的布局改造。
