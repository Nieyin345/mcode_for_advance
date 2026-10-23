# T83｜`slidesAddSlide` 有通道、零渲染端调用：可视化编辑的断点

- Status: ready-for-agent
- Category: **产品缺陷（能力已造好但接不上）**
- Priority: **P0** —— 用户抱怨「AI 改 Word/PPT 很烂」，而人自己也不能编辑
- Depends on: ARC-007（`documentView:*` 七条通道）、T40（渲染端 registry）
- Exclusive writable files: **只读 + `.tmp/` 探针**。**不改产品代码**（先核清楚再决定要不要开施工卡）。

## Required Skills
- `mcode-smoke`：无头验证。
- `codebase-design`：判断「断在哪一层」。

## 背景：这是今天第二次「能力造好了但接不上」

**第一次**（T73）：`checkDeckPatterns` 纯函数、22/22 全绿、**`src/` 里零调用**。

**这一次**：

```bash
$ grep -rn "slidesAddSlide" apps/desktop/src/ --include=*.ts --include=*.tsx
main/document/slidesBridge.ts:12      ← 文档注释
main/ipc/documentView.ts:322          ← handler 注册
（渲染端：零）
```

而渲染端的文档面板**自己写着**：

```ts
/**
 * 【ARC-007】**GenOffice 文档面板**（用户可达的只读/结构化视图）
 * ...
 * 它**不是**完整编辑器 —— 可视化编辑要等方案 A（受控 WebContentsView）接上；
 * 本面板的作用是让"打开文档 → 看见真实结构 → **知道为什么还不能编辑**"这条链
 * 先可达、可诊断。
 */
// apps/desktop/src/renderer/components/ide/GenofficeDocumentPane.tsx:1-9，共 123 行
```

**这个注释是诚实的。** 但现在要回答：**它诚实地描述了一个断点，还是诚实地描述了「做了一半」？**

## 任务

### 第一步：摸清 `documentView:*` 七条通道各是什么

```bash
grep -n "documentView\." apps/desktop/src/main/ipc/documentView.ts | head -20
```

**逐条列出**：通道名、做什么、**渲染端有没有调用**。

**产出一个表**：

| 通道 | 主进程做什么 | 渲染端有无调用 | preload 有吗 |
|---|---|---|---|

**这一张表就是本卡最重要的产出**——它告诉你断在哪一层（主进程 / preload / 渲染端）。

### 第二步：判断断点在哪一层

三种可能，含义完全不同：

| 断点 | 含义 | 修复成本 |
|---|---|---|
| **preload 没暴露** | 契约有、主进程有、桥没有 | 一行 |
| **渲染端没调用** | 能力齐全，UI 没接 | 一个组件 |
| **UI 根本没有编辑入口** | 需要设计交互（谁选页、怎么确认、撤销怎么办） | **一个方案** |

**要看 `packages/contracts` 的 `documentView` 契约 + preload 白名单 + 渲染端调用点三层。**

### 第三步：回答一个具体问题

**用户现在能不能在 Mcode 里给一个 PPT 加一页？**

- 打开文件 → 看到页列表 → 点「加一页」→ 真的加了 → 保存 → 重新打开还在？

**逐环节确认**。如果任何一环断了，**说清断在哪**。

### 第四步：`GenofficeDocumentPane` 那条注释，是真的吗

它说「可视化编辑要等方案 A（受控 WebContentsView）接上」。

**去查**：方案 A 是指什么？有没有对应的施工卡？**如果 `slidesAddSlide` 已经能工作，那这句注释就过期了。**

**这就是今天反复出现的「注释里的断言没人验」。**

## 验收判据

1. **`documentView:*` 七条通道的完整表**（通道 / 主进程 / 渲染端 / preload）。
2. **断点在哪一层的判断**（preload / 渲染端 / 需要设计）。
3. **「能不能加一页」的明确答案**（逐环节）。
4. **`GenofficeDocumentPane` 那条注释是否过期**的判断。
5. **不改产品代码**。

## 边界

- **只读 + `.tmp/` 探针**；
- **不改产品代码**（这一轮只核清楚；要施工另开卡）；
- 不跑全量、**不起 Electron**；
- 不碰 B 的 `documentToolRuntime.ts`、不碰 A 的扩展线文件。

## 遇到问题先检索

`GenofficeDocumentPane` 的注释提到「方案 A（受控 WebContentsView）」，先 `grep` 找方案 A 的文档或卡，**不要凭猜**。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T83-slides-add-slide-gap.md` 末尾追加 `## 结果回写（2026-10-23）`：
七条通道的表、断点判断、「能不能加一页」、注释是否过期、提交 SHA。

## 结果回写（2026-10-23，E 会话）

### 一、`documentView` 通道全表（12 条，不是 7 条）

基础 8 条：

| 通道 | 主进程做什么 | preload | 渲染端调用 |
|---|---|---|---|
| `documentView:open` | 建 `WebContentsView` 并 `addChildView` | ✅ | ✅ `GenofficeViewHostPane:291`、`EngineRuntimePanel:232` |
| `documentView:openPath` | 宿主准备 `pendingOpen` → 推 `slides:opened` | ✅ | ✅ `GenofficeViewHostPane:323` |
| `documentView:bounds` | `setBounds`（含屏幕外 park） | ✅ | ✅ `GenofficeViewHostPane:348/415`、`EngineRuntimePanel:161/259` |
| `documentView:show` | `contentView.addChildView` + `applyBounds` | ✅ | ✅ `GenofficeViewHostPane:416` |
| `documentView:hide` | `parkOffscreen`（移到 -9999） | ✅ | ✅ `GenofficeViewHostPane:320/411` |
| `documentView:focus` | `live.view.webContents.focus()` | ✅ | ✅ `RightPanel:348` |
| `documentView:close` | 摘除并销毁视图 | ✅ | ✅ `GenofficeViewHostPane:225`、`EngineRuntimePanel:117` |
| `documentView:list` | 列出活动视图 | ✅ | ✅ `GenofficeViewHostPane:430` |

**这 8 条：三层全通。**

slides 专用 4 条（`mcode:document-view:slides-*`）：

| 通道 | 主进程做什么 | preload | 渲染端调用 |
|---|---|---|---|
| `slides-add-slide` | 校验 docId/sender → `slides.addSlide(webContentsId, docId, sourceIndex, before)` | **❌ 无** | **❌ 无** |
| `slides-edit-text` | 同上 → `slides.editText(...)` | **❌ 无** | **❌ 无** |
| `slides-read-opened` | 从宿主 `pendingOpenFor` 拉取已解析的 `OpenResult` | **❌ 无** | **❌ 无** |
| `slides-save` | 写盘（`savePptxToFile`） | **❌ 无** | **❌ 无** |

**这 4 条：主进程齐全、preload 一行没暴露、渲染端零调用。**

### 二、断点在哪一层

**断在 preload（表层）——但真正的断点在更下面，见第四节。**

单看表，`slides-*` 四条的断点是最便宜那一档（「preload 一行」）。**但那个判断是错的**，因为：

**主进程这 4 条通道要求「该 webContents 有一个活的 slides 会话」**（`slides.addSlide` 第二行就 return `slides 视图会话不存在`），而**会话只能由 `openDeck` 建立**，`openDeck` 又只能由宿主调。宿主要先能打开 PPT。

**所以 preload 那 4 行即使补上，用户还是加不了页** —— 卡在「打不开 slides」。

### 三、用户现在能不能给 PPT 加一页？—— **不能，第一环节就断了**

| 环节 | 状态 |
|---|---|
| 1. 打开 `.pptx` | ❌ **断在这里** |
| 2. 看到页列表 | 不可达 |
| 3. 点「加一页」 | 不可达（且 UI 无此按钮） |
| 4. 真的加了 | 不可达 |
| 5. 保存 | 不可达 |
| 6. 重开还在 | 不可达 |

**断因不在 Mcode 侧没写代码，在 vendor 结构**（`GenofficeViewHostPane.tsx:34-70` 已逐条论证，我核过每一条引用）：

- `menu:command` **只有 docs 订阅**；sheets/slides 渲染端 grep 不到订阅者；
- slides 的渲染端只认 `slides:menu`，而 `MenuCommand` 联合里**只有 `'open'`（弹文件对话框）**，没有带路径的命令；
- `slides:consume-pending-open` 读的 `pendingByWc` **只由 vendor 主进程的 `createSlidesView` 填充**（`slides-main.ts:343`/`:5064`），Mcode 宿主无从写入。

**这三条我逐条核过源码位置，全部仍成立。**

### 四、⚠️ 那条注释：**过期了，但过期的不是它说的那件事**

`GenofficeDocumentPane.tsx:8`：

> 它**不是**完整编辑器 —— 可视化编辑要等**方案 A（受控 WebContentsView）**接上

**「方案 A（受控 WebContentsView）」已经接上了 —— 就是 `GenofficeViewHostPane.tsx`（559 行）。**

证据：

- 它把真实 GenOffice 编辑器页（`genoffice/apps/<module>/out/renderer/index.html`）挂进 IDE 中栏；
- 8 条 `documentView.*` 全部接线（open / bounds / show / hide / focus / close / list）；
- `FileEditor.tsx:262` 在 `effectiveMode === "genoffice-view"` 时渲染它。

**所以「要等方案 A」这句话是假的。** 真正的限制是**另一个**：slides 打不开（vendor 没有带路径的打开通道）。

**这条过期注释的危害**：下一个读到它的人会以为「可视化编辑还没做，等方案 A」，于是不去接 `slides-*` 那四条 preload——**而实际上那四条的主进程已经写好了**。**注释把一个「vendor 结构限制」误传成了「Mcode 侧未完工」。**

**建议**（不在本卡边界内）：

```diff
- * 它**不是**完整编辑器 —— 可视化编辑要等方案 A（受控 WebContentsView）接上；
+ * 它**不是**完整编辑器。可视化编辑已经在 `GenofficeViewHostPane`（受控
+ * WebContentsView，已接线）。**本面板不编辑器，是因为 docs 之外的格式打不开**：
+ * slides/sheets 的打开通道长在 vendor 主进程里（见 GenofficeViewHostPane 文件头
+ * 的逐条论证），Mcode 宿主没有对端。
```

### 五、`slides-*` 四条值不值得接 preload

**先别接。** 理由：

1. **接了也用不了**（会话建立不了），只会让 `slides.addSlide` 永远返回「slides 视图会话不存在」；
2. **`slides-read-opened` 依赖 `pendingOpenFor`**，而那条只在 `openPath` 成功之后才有值；
3. **真正的前置是「让 slides 能打开」** —— 那是另一张卡，且要决定：伪造 `OpenResult`？还是 fork vendor 的 `createSlidesView`？

**如果将来接，`slides-read-opened` 是唯一现在就有意义的**（它读宿主缓存，不依赖会话）—— 但它的消费者是 vendor 页面 preload（`apps/slides/src/preload/index.ts:149/150`），不是 Mcode 渲染端。**所以这条 preload 暴露也不该加在 Mcode 的 preload 里。**

### 六、未做 / 边界

- **没改任何产品代码**（全部只读 + `.tmp/` 探针）；
- 没跑全量、没起 Electron；
- 没碰 `documentToolRuntime.ts`（B 在改 T79）。

### 七、提交

（见下方 SHA）
