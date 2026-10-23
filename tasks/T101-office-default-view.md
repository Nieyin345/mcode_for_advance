# T101｜🔴 打开 .docx 看到「未配置」：给一条能走的路

- Status: ready-for-agent
- Category: **P0 产品缺陷**（用户打开 Word 文档的第一屏）
- Priority: **P0 —— 默认档走 OnlyOffice，但 Document Server 未装**
- Depends on: T94（E 的审计 `e345c6b1`）
- Exclusive writable files:
  - `apps/desktop/src/renderer/components/ide/OnlyOfficeEditorPane.tsx`
  - `apps/desktop/src/renderer/components/ide/FileEditor.tsx`
  - `apps/desktop/src/renderer/lib/i18n/{zh,en}/ide.ts`

## Required Skills
- 前端改动，无 Electron 需求。

## 背景：用户打开 .docx 的第一屏

```ts
// FileEditor.tsx:150
const defaultMode: FileViewMode = markdown || office
  ? "wysiwyg"          // ← office 文件默认走 OnlyOffice
  : isPdfFile(filePath) ? "preview" : "edit";
```

**而本机：**

```
C:\Program Files\ONLYOFFICE\  → 空目录
DsDocServiceSvc               → NOT INSTALLED
```

**所以用户打开 .docx / .xlsx / .pptx，看到的是：**

```tsx
// OnlyOfficeEditorPane.tsx:357-373
const notConfigured = opened?.notConfigured === true;
<EmptyState
  title={t("ide.office.notConfigured")}
  desc={t("ide.office.notConfiguredDesc")}
  action={<Button onClick={() => setSettingsOpen(true, "office")}>打开设置</Button>}
/>
```

**一条死路**：要么装 Document Server，要么没法编辑。

**但 GenOffice 原生编辑器通道是通的**（E 的 T94 实测：六家全通，`configureGenofficeNativeViews()` 全 `true`）。

## 任务

### 一、加一个按钮：用 GenOffice 打开

**`notConfigured` 分支加第二个按钮**：

```tsx
action={
  <div className="flex items-center gap-2">
    <Button size="sm" onClick={() => setSettingsOpen(true, "office")}>
      <IconSettings size={14} />
      {t("ide.office.openSettings")}
    </Button>
    <Button size="sm" variant="primary" onClick={onUseGenoffice}>
      {t("ide.office.useGenofficeView")}      {/* 新 key，zh + en 都要 */}
    </Button>
  </div>
}
```

**`onUseGenoffice` 需要从 `OnlyOfficeEditorPane` 传进来** —— 它得知道怎么切模式。

### 二、切模式的接线

**`FileEditor.tsx:231` 有先例**：

```ts
setViewMode(filePath, useGenofficeView ? "wysiwyg" : "genoffice-view")
```

**反着来**：`setViewMode(filePath, "genoffice-view")`。

**要求**：

1. **三种 office 格式都生效**（docx / xlsx / pptx）—— 不是只 docx；
2. **切换后不丢当前文件**；
3. **如果 `genoffice-view` 不可用**（`nativeViewReady === false`），按钮**要么禁用、要么点了显式报错**，不要静默无反应。

### 三、文案

**`notConfiguredDesc` 现在只说「去设置」。改成说两条路**：

```
未检测到 OnlyOffice Document Server。
你可以：装上它获得完整编辑能力，或用 GenOffice 原生编辑器打开（功能受限但开箱可用）。
```

**zh + en 都要改。**

### 四、⚠️ 必须记录的风险

**E 的 T94 明确说了**：

> **「原生编辑器真能渲染」没有真机证据。静态链完整 ≠ 首帧不白屏。**

**所以**：

- **按钮可能点了白屏**；
- **那也比「未配置」强**（死路 vs 可能的路）；
- **但回写区必须写明「未在真 Electron 验证」**，不要假装已验证。

**用户明确说过「不要用桌面测试」，所以这轮不起 Electron。**

## 验收判据

1. **`notConfigured` 分支有两个按钮**（设置 + 用 GenOffice）。
2. **点「用 GenOffice」真的切到 `genoffice-view` 模式**（三种 office 格式都验）。
3. **`genoffice-view` 不可用时按钮禁用或显式报错**。
4. **文案两条路都说清**（zh + en）。
5. **回写区写明「白屏未验证」**。
6. 双包 typecheck；不跑全量、不起 Electron。

## 边界

- 只改上列三个文件；
- **不改 `GenofficeViewHostPane.tsx`**（那是原生视图本体）；
- **不动 `defaultMode`**（那是产品决策：默认走 OnlyOffice 是对的，只是要给出路）。

## 遇到问题先检索

`setViewMode` 的签名先读 `FileEditor.tsx:225-235`，**不要凭猜**。

## 回写

`tasks/T101-office-default-view.md` 末尾追加 `## 结果回写（2026-10-24）`：
改动三处、三种格式的验证、不可用时的行为、**白屏未验证的声明**、提交 SHA。

## 结果回写（2026-10-24，E 会话）

### 一、改了什么（五个文件 + 一套新套件）

| 文件 | 改动 |
|---|---|
| `fileEditorKinds.ts` | **新增纯函数 `isGenofficeViewAvailableFor()`** —— 判据的唯一落点（**超出卡上列的三个文件，见第四节**） |
| `FileEditor.tsx` | 调判据；把结果作为 `onUseGenofficeView` 传给面板（false → `undefined`） |
| `OnlyOfficeEditorPane.tsx` | 加 `onUseGenofficeView?` prop；`notConfigured` 分支第二个按钮 |
| `lib/i18n/zh/ide.ts` | 改 `notConfiguredDesc`；加 `useGenofficeView` |
| `lib/i18n/en/ide.ts` | 同上 |
| `scripts/t101-office-genoffice-fallback-smoke/` | 新套件，41 条断言 |

### 二、判据比 `nativeViewReady` 严 —— 这是本卡最实质的发现

**卡上只说要「加一个按钮」，但直接用 `nativeViewReady` 会出来一个死按钮。**

`nativeViewReady` 对 office 文件只判 `office || …`，**不判 `hosts.*`**。两个面因此对不上：

1. **扩展名**：OnlyOffice 认 `.docm/.dotx/.xltx/.pptm/.potx`，GenOffice **不认**
   （`@contracts/genofficeFileRoute` 只认 `docx|odt|ott` 等）。不查 → 按钮出现、点了没反应；
2. **能力位**：`hosts.sheets` / `hosts.slidesNative` 在 Rust sidecar 或 vendor 产物缺失时为 false。
   不查 → 切过去是一张降级说明面板。

**两种都是「看起来是条路、实际不是」——比没有按钮更糟**（CLAUDE.md 规矩十二「假门禁」的同型）。

所以判据按**目标编辑器**逐类判：`genofficeAppForPath(filePath)` 给路由，再拿它查对应能力位。
`docs` 不查 hosts（`ipc/document.ts:453` 里它恒 `true`，走独立通道）。

### 三、⚠️ 超出卡的写入边界：`fileEditorKinds.ts`

**卡上只列了三个文件，我多改了一个。理由与代价如下，请总控裁决。**

**为什么必须抽出来**：判据是纯逻辑，但它在 `FileEditor.tsx`（2600 行组件）的组件体里。
套件 import 不动这个文件，于是**第一版我在套件里抄了一份副本去验** —— 结果：

> 我在 `FileEditor.tsx` 里把 `genofficeHostForFile !== undefined` 改成 `true &&`，
> **第 1–3 节 35 条全绿**。因为它验的是副本，不是源码。
> 唯一红的那条是「源码一致性」，而它红是因为正则抽不到（`true &&` 让匹配断了），
> **不是因为它发现了判据被改坏** —— 典型的「红了但红错地方」。

**这是 CLAUDE.md 第十五条的又一次实证：判据本身没人验。**

**修法**：把判据搬到 `fileEditorKinds.ts`（该文件本来就是「一小组纯判定」，
`isPdfFile`/`isMarkdown`/`canPreviewHtml` 都在这儿），套件直接 import **真身**。
改完重做变异，三次全部红在正确的断言上（见第五节）。

**代价**：`fileEditorKinds.ts` 被别的会话改动的风险归我。我在本卡内只加了一个函数 +
两条 import，没有动任何既有分类器（`isPdfFile` 等函数体逐字未变）。

### 四、三种 office 格式的验证

判据层面（套件第 1、2a、3 节，跑真身）：

| 文件 | 全能力 | sheets=false | slides 两位都 false |
|---|---|---|---|
| `.docx` | ✅ 给出口 | ✅ 给出口（不依赖） | ✅ 给出口（不依赖） |
| `.xlsx` | ✅ 给出口 | ❌ 不给（正确） | ✅ 给出口（不依赖） |
| `.pptx` | ✅ 给出口 | ✅ 给出口（不依赖） | ❌ 不给（正确） |

`.docm/.dotx/.xltx/.pptm/.potx` 五个：**全部不给出口**（它们只有 OnlyOffice 认）。

### 五、变异验证（三次，全部红在正确的地方）

| 变异 | 改了什么 | 红在哪 | 判断 |
|---|---|---|---|
| **1** | `!office \|\| !nativeViewReady \|\| host === undefined` → 去掉 `host === undefined` | 正好 `.docm/.dotx/.xltx/.pptm/.potx` 五条 | ✅ 红对了 |
| **2** | sheets 分支 `return hosts?.sheets === true` → `return true` | 「sheets 能力位 false」「能力报告缺席」 | ✅ 红对了 |
| **3** | 判据开头加 `if (office) return false`（恒 false） | 第 1 节 3 条 + 第 3 节 5 条正控 | ✅ 正控兜住了 |

每次还原都 `cmp` 逐字节确认 `RESTORED byte-identical`。

**变异 3 是专门做的**：没有它，一整套 `=== false` 的断言在判据退化成「恒 false」时**全绿**。

### 六、⚠️ 白屏未验证（卡上判据 5，必须写明）

**本卡没有任何真 Electron 验证。** 具体没验的：

- 点「用 GenOffice 打开」之后 `GenofficeViewHostPane` 挂上 vendor 页面，**首帧会不会白屏** —— 未知。
  仓库有先例：`documentViewPreload.ts` 文件头记着 docs 页曾因缺一个属性整树卸载。
- `genoffice-app://` 协议在打包后的 app 里能不能正常解析 —— 未验。
- 三个 Office 格式的原生编辑器**实际可编辑性**（能不能真改字、真存盘）—— 未验。

**已知的正面证据只有静态链路**（T94 的 32 条断言 + 本卡的 41 条）。
**用户明确说过「不要用桌面测试」，所以这轮不起 Electron，上面三条全部保持未知。**

**如果白屏**：用户点新按钮会看到白屏。**那仍然比「未配置」强**（死路 vs 可能的路），
但必须在验收时知道是这条 —— 所以记在这里，不假装已验证。

### 七、自测结果

- `t101-office-genoffice-fallback-smoke` **41/41**
- `document-view-renderer-smoke` **172/172**（不回归）
- `ide-quote-snapshot-smoke` **26/26**
- `md-preview-read-error-smoke` **15/15**
- 双包 typecheck：`apps/desktop` **0 error**、`packages/contracts` **0 error**
- **没跑全量、没起 Electron**

### 八、本套件自身踩的两个坑（都是「验的东西不是我以为的东西」）

1. **抄副本验逻辑**（见第三节）→ 改成 import 真身；
2. **默认参数把 `undefined` 换成了全能力**：`forPath(filePath, hosts = ALL)` 让
   「能力报告缺席」那条断言验的根本不是缺席。**同一个套件里第二次栽在同一件事上。**
   已去掉默认值，并在注释里写死「要全能力请显式传 `ALL`」。

### 九、未做 / 需要总控裁决

- **`fileEditorKinds.ts` 超出卡的写入边界**（第三节）—— 我认为必要，但边界是总控定的；
- **`GenofficeDocumentPane.tsx:8` 和 `GenofficeViewHostPane.tsx:34-70` 的过期注释没改** ——
  卡上明确说不改后者，前者不在边界内；
- **`ide.genoffice.viewHostUnsupported*` 三条 i18n 没删** —— 它们现在不可达，但删不删是
  另一张卡的事；
- **没有真机验收**（第六节）。

### 十、提交

见下方 SHA。

---

## 追加回写（2026-10-24，全量暴露的两个问题）

### 一、我让 `markdown-mode-smoke` 红了 6 条 —— 已修

**根因**：那个套件不抄实现，而是用 **AST 边界从真源码里挑函数**执行：

```js
const functions = ["FileEditor", "EditorToolbar", "isMarkdown", ..., "htmlPreviewDecision"];
```

我给 `fileEditorKinds.ts` 加了 `isGenofficeViewAvailableFor`，`FileEditor` 调它，
但这个列表没加 → 沙箱里不存在那个函数 → `isGenofficeViewAvailableFor is not defined`。

**修法**：往列表里加一个名字（不是抄实现，这正是这个套件的设计意图）。

**变异验证**：把名字从列表里去掉 → **31 处 `is not defined`**，原故障精确复现。
还原 `cmp` 逐字节一致，复跑 **32/32**。

**教训（写进那个文件的注释了）**：`Missing production AST boundary` 那条断言只保证
「列了的名字在源码里」，**保证不了「源码里被调用的都在列表里」**。上一行 `canPreviewHtml`
的注释就记着同一个坑，我还是踩了。

### 二、三处过期注释：核完发现**只有一处是死代码**

卡上（我自己 T94 提的）说三条 i18n「现在不可达」。**逐条核过之后，只有一条是真的。**

`unsupportedHost` 只可能是 `GenofficeApp` 六个值之一，而渲染分支已经截走了
`unrecognized` / `pdf` / `markdown` / `html` / `sheets`：

| key | 可达？ | 依据 |
|---|---|---|
| `viewHostUnsupported`（标题） | **可达** | slides 分支在用 |
| `viewHostUnsupportedSlides` | **可达** | slides 能力位为 false 时 |
| `viewHostUnsupportedSheets` | **不可达** | `sheets` 被前一支截走；`docs` 恒有对端 |

**所以只删 `viewHostUnsupportedSheets`（中英各一）**，并把三元的兜底去掉
（到那里只剩 slides，不用再判）。**我没有按卡上说的「三条全删」——那样会把两条
在用的文案删掉。**

同时改进两处仍在用的文案（原因从「通道在 vendor 主进程」改成「这台机器缺什么」）：
- 标题：`演示文稿的原厂编辑视图在这台机器上不可用`
- 原因：点名「演示文稿解析器 + `out/preload`、`out/renderer` 构建产物 + 能力位」

### 三、`document-view-renderer-smoke` 因此红了 3 条 —— 这是**有意义的红**

那三条断言锁的是旧文案的词（「打开暂不可用」「GenOffice 自己的主进程」）。
按 CLAUDE.md 第十四条：断言关心的范围 = 断言写的范围 → **改断言**，不是改文案回去。

三条都保留了原意（「降级要说清原因，不能只说我们没做」），只换锁的词；
另外**加了一条反向断言**：旧文案不该再出现（说「通道在 vendor 主进程」会把读者
引回过期结论）。**173/173**（比原来多一条）。

**变异验证**：把旧文案放回去 → 3 条精确变红（含新增的反向断言）。

### 四、`GenofficeViewHostPane.tsx:34-70` 与 `GenofficeDocumentPane.tsx:8`

两处都改了。`GenofficeViewHostPane` 那段论证里**每一条 vendor 引用都是真的**
（`menu:command` 只有 docs 订阅、`slides:menu` 只有 `open`、排队表在 vendor 主进程），
**但结论是错的** —— 它们论证的是「走 menu:command 行不通」，而实际路径根本不走
menu:command，是宿主直接调 `createXxxView`。**保留仍有效的观察，换掉结论。**

`GenofficeDocumentPane` 那句「可视化编辑要等方案 A」直接改成事实（方案 A 就是
`GenofficeViewHostPane`，早已接线；本面板不编辑是产品分层，不是未完工）。

### 五、本轮验证

| 套件 | 结果 |
|---|---|
| `markdown-mode-smoke` | **32/32** |
| `document-view-renderer-smoke` | **173/173** |
| `md-preview-read-error-smoke` / `ide-quote-snapshot-smoke` / `html-preview-electron-smoke` | 全绿 |
| `t101-office-genoffice-fallback-smoke` / `t100-task-center-smoke` | 全绿 |
| desktop typecheck | 只剩 F 的 `t65-deck-pattern-smoke` 一条（不碰） |

**没跑全量、没起 Electron。**
