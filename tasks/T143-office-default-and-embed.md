# T143｜Office 文件默认用原厂编辑器，并嵌入现有 UI

- Status: ready-for-agent
- Category: **P0 产品主线（Office + UI）**
- Priority: **P0** —— 用户明确要求：「默认啊，而且要把 office 的 ui 契合现在的 ui」「嵌入到现在的 mcode 里面」
- Depends on: T117/T118（资源已能打包）、T136（视觉基线）

## 一、现状（我核实的，不是猜的）

### 资源齐了

```
editorsBundled: true
editors: docs, sheets, slides, pdf, markdown, html
nativeSidecar: xlsx-sidecar.exe
```

### 但默认不是它

`FileEditor.tsx:178`：

```tsx
const defaultMode: FileViewMode = markdown || office
  ? "wysiwyg"          // ← office 默认走 wysiwyg = OnlyOffice
  : isPdfFile(filePath)
    ? "preview"
    : "edit";
```

而 GenOffice 可视化视图要显式切换：

```tsx
// :152
const useGenofficeView = nativeViewReady && viewModePref === "genoffice-view";
```

**所以用户打开 .docx 看到的是 OnlyOffice（或 Monaco），要手动切两次才能到原厂编辑器。**

## 二、任务一：默认改成原厂编辑器

**`defaultMode` 对 Office 文件应该是 `"genoffice-view"`**，而不是 `"wysiwyg"`。

**⚠️ 但有三个前提必须先判：**

1. **`genofficeViewForOffice` 为 true 才切** —— 否则会打开一个降级面板：
   ```tsx
   const genofficeViewForOffice = isGenofficeViewAvailableFor({
     office, nativeViewReady, host: genofficeHostForFile, hosts: genoffice.data?.hosts,
   });
   ```
   **如果它 false，应该回落到 `"wysiwyg"`，不是硬切。**

2. **`documentDocked` 时不能切** —— 文档被拖到右栏时，`genoffice-view` 分支显示「文档已移到右栏」。**那个分支是对的**（视图是 OS 级子视图，不能在两个容器里同时显示），**但默认值不该让它触发。**

3. **用户的显式选择仍然优先** —— `viewModePref ?? defaultMode` 那个顺序不能动。

**所以改法：**

```tsx
const defaultMode: FileViewMode =
  genofficeViewForOffice
    ? "genoffice-view"           // 能力齐 → 原厂编辑器
    : markdown || office
      ? "wysiwyg"                // 能力不齐 → 回落 OnlyOffice
      : isPdfFile(filePath)
        ? "preview"
        : "edit";
```

**⚠️ `genofficeViewForOffice` 在上面已经定义了（`:171`），但 `defaultMode` 在 `:178`。顺序没问题。要确认。**

## 三、任务二：Office 编辑器契合现有 UI（**这是更难的一半**）

**用户原话：「把 office 的 ui 契合现在的 ui」「嵌入到现在的 mcode 里面」**

### 问题在哪

`GenofficeViewHostPane.tsx:438` 渲染的是：

```tsx
<div className="flex h-full min-h-0 flex-col">
```

**零样式容器。** 而 `WebContentsView` 盖在上面，所以：

- **没有边框**（其他面板都有 `border-edge-panel`）
- **没有圆角**（其他面板是 `--radius-panel` 10px）
- **没有阴影**

**结果**：Office 编辑器是一块「无边框的裸区域」，嵌在别的有边框面板中间。

### 但这里有一个硬约束（Office 总控已经指出）

`WebContentsView` 是 **OS 级子视图**，它**精确覆盖**占位 div 的矩形：

```ts
// measureBounds()
x: clamp(r.left, 0, 16384),
width: clamp(r.width, 1, 16384),
```

**所以给 div 加 `border` 是无效的** —— 视图会盖住边框那一圈。

**唯一可行**：**让 stage 内缩 1px**，边框画在它的父容器上。

**⚠️ 这有代价**：内缩会让编辑器内容少 2px 宽高。**对 slides 这种按容器宽度算缩放比例的，会改变渲染。**

### 所以这一半要和 Office 总控配合

**分工建议**（我在交接里已经发过）：

| 谁 | 改什么 |
|---|---|
| **Office 总控** | `measureBounds` 减 1px（行为） |
| **本卡** | 父容器的 `border` + `rounded`（样式） |

**⚠️ 必须串行，不能并行。**

**而且 Office 总控还指出一个更好的顺序**：

> 你先加样式（border + rounded 在父容器上），我先不动 `measureBounds`。
> 加了 border 但还没内缩时，**border 会被 WebContentsView 盖住** —— 这正好给我一个**天然的负控**。

**所以顺序：本卡先加样式（看不到效果）→ Office 总控加内缩（边框出现）。**

## 四、⚠️ 还有一个更深的问题：工具栏

**如果原厂编辑器是默认，那它自己的工具栏（GenOffice 的）会和 Mcode 的 UI 冲突。**

**需要确认**：
1. 原厂编辑器的工具栏长什么样？（截图或代码）
2. 它和我们 `--radius-panel` / `border-edge-panel` 的面板风格一致吗？
3. **`editorOnly` 那个参数**（`EngineRuntimePanel` 用过的模式）—— GenOffice 有没有类似的精简模式？

**如果原厂工具栏和我们的差太远，可能要：**
- 接受差异（Claude 的 artifacts 也是独立工具栏）；
- 或者隐藏它的工具栏，用我们的外框包。

**⚠️ 这条要看过实际界面才能决定。先跑一次视觉基线拍 Office 场景。**

## 五、验收

1. **打开 .docx / .xlsx / .pptx，默认是原厂编辑器**（不是 Monaco，不是 OnlyOffice）。
2. **能力不齐时回落到 `wysiwyg`**，不是降级面板。
3. **用户手动切换过的文件，仍然记住他的选择**。
4. **Office 面板有边框和圆角**（和其他面板一致）。
5. **视觉基线新增 `office-host` 场景**（T136 已经提过要加，还没加）。

## 六、边界

**可以改**：
- `components/ide/FileEditor.tsx`（`defaultMode`）
- `components/ide/GenofficeViewHostPane.tsx`（**只加父容器的 border/rounded，不动 `measureBounds`**）
- `arc005-visual-baseline/`（加 `office-host` 场景）

**不许碰**：
- `measureBounds`（那是 Office 总控的，要串行）
- `main/document/documentViewHost.ts`
- `components/settings/workflows/`

## 七、⚠️ 第一步不是改代码

**先拍一张 Office 编辑器现在长什么样的截图。**

```bash
# 如果基线里没有 office 场景，先加一个
grep -n "office" apps/desktop/scripts/arc005-visual-baseline/probe.ts
```

**如果没有，加一个 `office-host` 场景**（用 fixture 打开一个假 .docx）。

**理由**：用户说「契合现在的 UI」，但**没人看过它现在长什么样**。**不看就改，是猜。**

## 八、回写

1. **Office 编辑器现在的截图**（或者为什么拍不出来）
2. `defaultMode` 改了什么、回落逻辑怎么写的
3. **在真机上默认是否变成了原厂编辑器**（headless 验不了这个，要说明）
4. 边框/圆角加了什么、能不能看见（多半看不见，因为视图盖住）
5. 工具栏怎么处理的
6. 套件数字、提交 SHA
7. 有没有觉得不对但没改的

---

## 九、用户追加的三条要求（2026-10-24）

**原话：**

> **「默认啊，而且要把 office 的 ui 契合现在的 ui」**
> **「嵌入到现在的 mcode 里面」**
> **「就像是打开 md 文件一样丝滑」**
> **「OnlyOffice 删掉，不要了」**

### 9.1 md 为什么丝滑 —— 这是核心洞察

**md 走的是 `MarkdownEditorPane`（Milkdown / Crepe），那是渲染端内的 React 组件。**

```
md:       React 组件 → 在 DOM 里 → 切换即时
Office:   WebContentsView → 独立进程 → 算 bounds、等加载、同步滚动
```

**所以「丝滑」不是速度优化能解决的，是架构差异。**

**这让「像 md 一样丝滑」变成一个需要判断的问题：**

| 做法 | 能否达到「丝滑」 |
|---|---|
| **A. 优化 WebContentsView 的创建/切换** | 只能减少卡顿，**不能到「零延迟」** |
| **B. 用 iframe 而不是 WebContentsView** | **可能更丝滑**（同进程），但失去进程隔离 |
| **C. 接受差异，只做「不卡」** | 诚实但没满足用户 |

**⚠️ 这条必须先回答，再决定改法。**

**核实 B 的可行性**：
- GenOffice 的渲染端产物（`apps/*/out/renderer/`）能不能在 iframe 里跑？
- 它们需要哪些 Electron API（如果依赖 `electron` 的 node 集成，iframe 就跑不了）？

```bash
grep -rn "require('electron')\|window.electron\|ipcRenderer" \
  genoffice/apps/docs/src/preload/ 2>/dev/null | head
```

**如果渲染端只依赖 preload 暴露的 API，那 iframe + 自己的 preload 桥是可行的。**

### 9.2 OnlyOffice 删掉

**用户明确：「OnlyOffice 删掉，不要了」**

**这是一次大删除。要清的地方**：

```bash
grep -rn "OnlyOffice\|onlyoffice" apps/desktop/src/ --include=*.ts --include=*.tsx | wc -l
```

**至少包括**：
- `FileEditor.tsx` 的 `wysiwyg` 分支（`OnlyOfficeEditorPane`）
- `isOnlyOfficeSupportedPath` / `isOnlyOfficeViewOnlyPath`
- `defaultMode` 里的 `office ? "wysiwyg"` 回落
- 相关 IPC / 配置 / UI 入口
- `OnlyOfficeEditorPane.tsx` 整个文件

**⚠️ 但「删掉」有一个前提**：**GenOffice 必须能覆盖 OnlyOffice 现在覆盖的格式。**

`FileEditor.tsx:160` 的注释原文：

> OnlyOffice 认 `.docm/.dotx/.xltx/.pptm/.potx`，GenOffice 只认 `docx|odt|ott` 等（`contracts/genofficeFileRoute.ts` 是唯一路由表）

**所以 `.docm` / `.dotx` / `.xltx` / `.pptm` / `.potx` 这五种格式，OnlyOffice 能开而 GenOffice 不能。**

**删掉 OnlyOffice = 这五种格式打不开了。**

**必须先回答**：
1. GenOffice 能不能支持这五种？（改路由表？还是根本不行？）
2. 如果不能，这五种文件怎么办？（显示「不支持」？还是用别的？）

**这条不回答就删，会造成「某些文件打不开」的功能倒退。**

### 9.3 检查顺序

**这三条有依赖关系，不能并行：**

```
① 先答：GenOffice 能不能覆盖 OnlyOffice 的格式？
       ↓ 能
② 删 OnlyOffice + 默认改成 genoffice-view
       ↓
③ 再解决「丝滑」（iframe vs WebContentsView）
       ↓
④ 最后调 UI（边框/圆角）
```

**⚠️ ③ 如果在架构上做不到，要诚实告诉用户「做不到零延迟，能做到什么」。**

**不能假装做到了。**
