# O5｜删掉 OnlyOffice，六格式全部走 GenOffice：契约层语义变更

- Status: **ready-for-agent**（**分三批，不要一次做完**）
- Category: **Office / 架构裁决落地**
- Priority: **P0 —— 用户明确要求「OnlyOffice 删掉，不要了」「之前的全部都不要了，现在的 office 还有 md 全部走 genoffice 这一条线」**
- 独占写入边界（**本卡横跨四层，必须按批次串行**）：
  - 批一（契约层）：`packages/contracts/src/**`
  - 批二（主进程 + preload）：`apps/desktop/src/main/**`、`apps/desktop/src/preload/**`
  - 批三（渲染端）：`apps/desktop/src/renderer/**`
  - **不得改** `genoffice/**`（vendor 上游，只读）

## Required Skills

- `mcode-smoke`：契约变更要跑全链路
- `systematic-debugging`：134 处删除会暴露隐藏依赖

## 一、用户裁决（原话，不是我的推断）

> 「**OnlyOffice删掉，不要了**」
> 「我说的是only office这个不要了，这个不是用的api做的吗，我不要了」
> 「**之前的全部都不要了，现在的office还有md全部走genoffice这一条线**」
> 「默认啊，而且要把 office 的 ui 契合现在的 ui」
> 「嵌入到现在的 mcode 里面」
> 「就像是打开 md 文件一样丝滑」

**OnlyOffice 是外部 Document Server**（用户自己部署），`onlyoffice.detectLocal` → 加载 `api.js` → `new DocsAPI.DocEditor`。**删掉是正确方向。**

## 二、规模（我数的，不是估的）

**134 处，21 个文件，跨四层：**

| 层 | 文件 |
|---|---|
| 契约 | `ipc/onlyoffice.ts`、`ipc/rpcMap.ts`、`appPermission.ts`、`documentKind.ts` |
| preload | `preload/index.ts` |
| 主进程 | `onlyoffice/{OnlyOfficeBridge,localInstall}.ts`、`appControl/{policy,apiCatalog.generated,commandOutcome}.ts`、`ipc/index.ts`、`lib/{dialogText,secretKeys}.ts`、`settings/settingsTransfer.ts` |
| 渲染端 | `components/ide/OnlyOfficeEditorPane.tsx`、`components/settings/{OnlyOfficeConfigCard,ToolchainSection}.tsx`、`lib/webApi.ts`、`i18n/{zh,en}/settings.ts` |

## 三、★ 先看这条：一个语义陷阱

`packages/contracts/src/documentKind.ts:26` 原文：

> `office` 种类目前由 OnlyOffice 承载；ARC-007 的 GenOffice 迁移会逐格式换上新的

**而 `:65` 写的是**：

> Office 可编辑扩展名 → 文档类型。与 `ipc/onlyoffice.ts` 的 `ONLYOFFICE_EDITABLE` 对齐

**所以 `documentKind` 返回的 `"office"` 这个值，语义是「OnlyOffice 能编辑的格式」，不是「Office 格式」。**

删 OnlyOffice 时有两个选择，**必须明确选一个并写进注释**：

- **A. 保留 `"office"` 这个 kind，但改语义为「GenOffice 能编辑的格式」** —— 改动小，但**同一个字符串换了含义**，是这个仓库明令禁止的「名字与含义脱钩」；
- **B. 换名**（例如 `"genoffice"`）—— 改动大，但语义干净。

**我倾 B，但本卡不强制。执行者必须选一个，并在 `documentKind.ts` 顶部注释里写明新的语义 + 为什么。**
**不许悄悄改语义而不改注释。**

## 四、批次

### 批一：契约层（必须先做完、先绿，再动批二）

1. 删 `packages/contracts/src/ipc/onlyoffice.ts`，清 `rpcMap.ts` 里的登记；
2. `appPermission.ts` 里 OnlyOffice 的权限档位——**确认哪些是「只服务 OnlyOffice」的，哪些是共用的**（后者不能删）；
3. `documentKind.ts`：按第三节选 A 或 B，并改注释；
4. **`apiCatalog.generated.ts` 是生成物**，文件头写明来源与重生成命令：

   ```
   // ⚠️ 生成文件,别手改。来源:packages/contracts/src/ipc/rpcMap.ts + src/preload/index.ts
   // 重新生成:在 apps/desktop 下 `node scripts/gen-app-api-catalog.mjs`
   ```

   **而且它还有下游**：`scripts/gen-module-permission-map.mjs:8` 读它当输入。
   所以删除顺序是 **`rpcMap.ts` → 重生成 catalog → 重生成 permission map**，
   手改任何一环都会在下一轮重生成时被冲掉。

**批一验收**：`npx tsc --noEmit -p packages/contracts/tsconfig.json` exit=0，且相关套件绿。

### 批二：主进程 + preload

1. 删 `main/onlyoffice/`；
2. 清 `main/ipc/index.ts` 的注册；
3. **`lib/secretKeys.ts` 里的 OnlyOffice 凭据键** —— 删之前想清楚：用户已存的凭据要不要迁移/清理？**删键名会让已存值变成孤儿**，这是数据卫生问题，不是代码整洁问题；
4. `settingsTransfer.ts` 的导入导出要同步；
5. `appControl/policy.ts` 的权限档位。

### 批三：渲染端

1. 删 `OnlyOfficeEditorPane.tsx`、`OnlyOfficeConfigCard.tsx`；
2. `ToolchainSection.tsx` 里的入口；
3. `webApi.ts`（**手机端独立组件树，漏一项会整棵卸载**，见 CLAUDE.md）；
4. **i18n zh/en 双词典** —— 两边的 key 都要删，**只删一边会让 `maint-m37-smoke` 红**（typecheck 不红）。

## 五、★ 默认模式（「默认啊」）

`FileEditor.tsx:178` 现在：

```tsx
const defaultMode: FileViewMode = markdown || office ? "wysiwyg" : ...
```

`"wysiwyg"` 是 OnlyOffice 的档。**删掉 OnlyOffice 后，office 文件必须默认落在 GenOffice。**
而 `genofficeViewForOffice`（`:170`）已经存在 —— **说明 GenOffice 路径已接了一半。**

**判据**：六格式文件打开时，**第一次就落在 GenOffice 原生视图**，不需要用户切模式。
**不许**「先显示一个『选择编辑器』再切」。

## 五之二、★ 改默认时必须判能力，不能无条件改成 GenOffice

`FileEditor.tsx:171` 已有：

```tsx
const genofficeViewForOffice = isGenofficeViewAvailableFor({
  office, nativeViewReady, host: genofficeHostForFile, hosts: genoffice.data?.hosts,
});
```

而 `fileEditorKinds.ts:43-62` 的实现是（我读过，不是听说的）：

```ts
if (!office || !nativeViewReady || host === undefined) return false;
// 这条出口只服务 Office 文档；pdf/markdown/html 走它们自己的默认档，不在这里。
if (host === "pdf" || host === "markdown" || host === "html") return false;
if (host === "docs") return true;
if (host === "sheets") return hosts?.sheets === true;
return hosts?.slidesNative === true || hosts?.slides === true;   // slides 两条路
```

**两条必须守的**：

1. **`defaultMode` 必须判 `genofficeViewForOffice`**，不能无条件写死 GenOffice ——
   否则能力不齐（比如安装版缺某格式资源）时会**打开一个降级面板**，而不是明确报「不可用」。
2. **入参 `office` 现在传的是 `isOnlyOfficeSupportedPath(filePath)`**（`:44` 注释原文）。
   删 OnlyOffice 后这个入参**必须换成 GenOffice 的扩展名判定**，否则
   `office` 恒 false → `genofficeViewForOffice` 恒 false → **默认模式永远到不了 GenOffice**。
   **这是删 OnlyOffice 最容易漏的一处：删了判定函数，入参就悬空了。**

## 六、★ 格式覆盖：**不要照抄 upstream，这一步上游没有**

**（这条纠正一个流传中的错误依据）**

有人会说「GenOffice 上游自己认得 `docm/dotx/xltx/pptm/potx`」，依据是
`genoffice/packages/cli/src/limits.ts` 的 `FAMILY` 表。

**那个表是「解压时的体积限额分族」，不是路由。** 真正的路由在
`genoffice/apps/shell/src/main/app-routing.ts`，正则与我们
`packages/contracts/src/genofficeFileRoute.ts` **逐字一致**：

```ts
const DOCX_RE = /\.(docx|odt|ott)$/i      // 无 docm/dotx
const PPTX_RE = /\.(pptx|odp|otp)$/i      // 无 pptm/potx
```

**所以：上游自己也不路由这五种。** 补它们是**我们自己的扩展**，且
`genoffice-file-routing-smoke` 会动态比对两边实现，**改了会让它红** —— 那时要同步改那个套件的比对预期，并写明「我们有意扩展」。

**而且要先实测**：即使我们把文件路由到 docs，**vendor 页面自己的另存/重命名 gate 也不认这五种**
（`renameStaysInApp` 用的是同一套正则）。**这意味着用户可能能打开但存不回去。**

**所以本卡对格式覆盖的要求是**：
1. 先做一个**实测**：五种格式各拿一份真文件，走 GenOffice 打开 → 看能不能渲染；
2. 能渲染的登记；不能的**明确报「不支持」**，不做假的兜底；
3. **不许**因为「用户说全走 GenOffice」就把它们硬路由过去然后静默失败。

## 七、变异要求

1. **把 `defaultMode` 改回 `"wysiwyg"`** → 五节判据必须红；
2. **删掉某格式的路由项** → 该格式的打开必须报「不支持」，不是白屏；
3. **i18n 只删 zh 不删 en** → `maint-m37-smoke` 必须红。

## 八、不要做的事

- **不要改 `genoffice/**`**。那是 vendor 上游。
- **不要手改 `apiCatalog.generated.ts`**。找生成脚本。
- **不要一次做完三批**。契约层没绿就动主进程，会让后面每个错误都看起来像「层间不匹配」。
- **不要为了「全走 GenOffice」而静默降级**。不能打开的格式要明确报错。

## 八之二、UI 决定（已与 UI 总控确认）

- **Office 面板圆角用 `--radius-panel`（10px）**，边框 `border-edge-panel`。
  右栏那两处 `rounded-md`（6px）是旧账，UI 总控会改成 10px，两边统一。
- `GenofficeViewHostPane.tsx` 从本卡起**归 Office 线**，UI 总控不再碰。
- **两个已知的 UI 侧故障**（不修好前不要依赖）：
  - `cn()` 会丢自定义字号档位（`twMerge("text-caption text-content")` → caption 丢了），T140 在修；
  - `arc005-visual-baseline` 写死 39 格而实际 51 格，token 比对从没跑过，T141 在修。
  **在它们修好之前：字号改动不要用 `text-caption` 这类档位；视觉基线只能看图，不能采信它的结论。**

## 九、结果回写区

（执行会话按批次追加：每批的红绿、选 A 还是 B 及理由、五种格式的实测结果、变异记录、提交 SHA）
