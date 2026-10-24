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

## 四点五、★ 删 `onlyoffice.ts` 会撞的两份表对账（我读出来的，不是猜的）

`packages/contracts/src/ipc/onlyoffice.ts` 的注释原文（`:88-97`）：

> **【ARC-007】文档种类的唯一判据在本文件之上层（`@contracts/documentKind`）。**
> 这三条 DS 判据保留原签名（既有调用方不改），但内部改走 `documentKindOf`。
> ⚠️ 依赖方向：本文件（叶子）不 import `documentKind`（那会形成循环）。
> 所以这三条**保留自己的字符串判断**，而 `documentKind.ts` 里的
> `OFFICE_EDITABLE` / `OFFICE_VIEW_ONLY` 与它们是**两份表** ——
> 由 **`document-router-smoke` 逐项对账，漂了即红**。

**所以：**

1. **`ONLYOFFICE_EDITABLE` / `ONLYOFFICE_VIEW_ONLY` 不只是「OnlyOffice 的东西」** ——
   它们是「哪些扩展名是 Office 文档」的**历史来源之一**；
2. **`documentKind.ts` 已经有独立的一份**（ARC-007 迁移时建的 `OFFICE_EDITABLE` / `OFFICE_VIEW_ONLY`）；
3. **`document-router-smoke` 会逐项对账两份表** —— **你删掉一份，它会红**。

**这不是障碍，是提示**：删掉 `onlyoffice.ts` 的那两份表之后，
**`document-router-smoke` 的对账段要跟着改**（从「两份表比」变成「只剩一份」）。

**⚠️ 不要为了让套件绿而把 `documentKind.ts` 的表也删掉** ——
那是唯一的判据了。**要改的是套件的对账段，不是判据本身。**

**判据**：

```bash
grep -c "ONLYOFFICE_EDITABLE\|ONLYOFFICE_VIEW_ONLY" packages/contracts/src/ipc/onlyoffice.ts   # 删完应文件不存在
grep -c "OFFICE_EDITABLE\|OFFICE_VIEW_ONLY" packages/contracts/src/documentKind.ts              # 必须还在
pnpm test:smoke document-router-smoke                                                             # 必须绿
```

## 五之零、★ 一条可验的收尾判据：生成物里不该再有 onlyoffice

**现状（2026-10-24 22:30 实测）**：

```
$ grep -c "onlyoffice" apps/desktop/src/main/appControl/apiCatalog.generated.ts
20
```

**这 20 处在批一应该消失** —— 但不是靠手删，是靠重生成：

1. 从 `rpcMap.ts` 删掉 onlyoffice 的 8 条方法定义；
2. `node scripts/gen-app-api-catalog.mjs`（重生成 catalog）；
3. `node scripts/gen-module-permission-map.mjs`（重生成 `appPermission.ts`，它读 catalog）。

**收尾判据**：

```bash
grep -c "onlyoffice" apps/desktop/src/main/appControl/apiCatalog.generated.ts   # 期望 0
grep -c "onlyoffice" packages/contracts/src/appPermission.ts                     # 期望 0
```

**⚠️ 这两条不是「顺便检查」**：它们是**唯一能证明你没漏掉生成链某一环**的判据。
**手删 catalog 那 20 行也能让 grep 变 0，但下次重生成会加回来** ——
所以**必须由「改了源头 + 重生成」得到 0，不是「手改产物」得到 0。**

**怎么区分这两者**：提交前把生成物 `git checkout` 到 HEAD 再重跑一次生成脚本，
`git diff` 应该**只显示你预期的变化**，不显示「20 行又回来了」。

## 五之一、⚠️ 两个桩文件已被 O4 改过，不要改回旧形态

`fa6eb917`（O4）把这两个文件里的 `ipcMain.on` 从 `notHere(...)` 抛错桩改成了记录式：

```
apps/desktop/scripts/memory-codex-smoke/stubs/electron.ts
apps/desktop/scripts/t40-renderer-registry-smoke/stubs/electron.ts
```

**原因是**：那两套桩按「当时总注册表里没有任何一条 `ipc.on`」校准；O4 修好
`createDbGuardedIpc.on` 之后，生产装配**真的**会注册 `close-check-result` 监听器 ——
桩的前提被合法推翻，导出面跟着重新校准。

**⚠️ 你删 OnlyOffice 的 8 条 IPC 时，如果你也要动这两个桩，先 `git log -- <文件>` 看最新版，
不要把它们改回 `notHere`。**

**补充事实（O4 的执行会话替你核过）**：`onlyoffice.ts` 的注册器是
`registerOnlyOfficeHandlers(ipcMain: IpcMain)`，**只用 `ipcMain.handle`，没有 `ipc.on`** ——
所以 O5 不涉及 O4 修的 `on` 面。

**这两个套件里没有一处提到 ONLYOFFICE**（grep 0/0），它们只验「总注册表装得起来 + 表里每条都有 handler」。
删通道会改变数量，但不会改它们的断言对象 —— **除非你动了它们的桩。**

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

## 五之六、⚠️ 三批分层的代价：中间态会让**别的线**的套件变红

**2026-10-24 23:xx，工作流总控报**：`workflow-ui-smoke` 构建失败
（`FileEditor.tsx:13` import 已删的 `isOnlyOfficeSupportedPath`）。

**他们花时间做了单文件回滚对照才确认「不是我的」。**

**这是三批分层的必然副作用，不是事故**：

| 批 | 完成前，哪些套件会红 |
|---|---|
| 批一后（契约已删、渲染端未改） | 所有 import 已删契约的套件 —— `workflow-ui-smoke`、`document-view-*`、`installers-ipc`、`updater-tools`、`markdown-mode`、`t101` |
| 批二后（主进程已改、渲染端未改） | 同上，少掉 preload 那部分 |
| 批三后 | 应该全绿 |

**⚠️ 这意味着：「在批三完成之前，任何动 `apps/desktop/src/renderer/**` 的其他会话，
都会看到一个红的必跑套件，而那不是他们的。」**

### ⚠️⚠️ 范围比「几个套件」大得多 —— 2026-10-24 实测更正

**我最初只报了 `workflow-ui-smoke`。那是说小了。**

**准确的判据是「打不打包渲染端」，不是「提到不提到 onlyoffice」**：

```bash
$ npx tsc --noEmit -p apps/desktop/tsconfig.json > /tmp/tsc.txt 2>&1
$ grep -cE "^apps/desktop/src/(main|preload)/" /tmp/tsc.txt    # 批二落地后 = 0
$ grep -cE "^apps/desktop/src/renderer/" /tmp/tsc.txt          # 批三落地前 = 38
```

**批二落地后，`main/` 和 `preload/` 已经是 0 条错误，只剩渲染端 38 条。**

**所以受影响的是**：
- **所有 U1 套件**（`t7` / `t29` / `t30` / `t46` / `o0` / `o4`）—— 它们打真渲染端；
- **所有渲染端组件套件**；
- **而只打 `src/main/**` 的套件不受影响**（主进程已干净）。

**报范围时说「所有打渲染端的套件」，不要说「几个套件」** ——
**前者让别人能自己判断，后者只能靠猜。**

### ⚠️ 判别命令：不要用 `grep onlyoffice`，用 `renderer` 的错误数

**工作流总控实测**：38 条渲染端错误里，**只有 36 条含 `onlyoffice` 字样**。
剩下 2 条是：

```
renderer/lib/webApi.ts(852,10): error TS7006: Parameter 'input' implicitly has an 'any' type.
renderer/lib/webApi.ts(855,11): error TS7006: Parameter 'input' implicitly has an 'any' type.
```

**机理**：`Api["onlyoffice"]` 这个类型不存在了 → 整个对象字面量的类型上下文变成 `any`
→ `input` 参数推断不出来 → 报 `implicitly has an 'any' type`。
**它是「上一条错误的二次效应」，报错文本里不含关键词。**

**所以判别用这个（不依赖措辞）**：

```bash
cd apps/desktop
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.txt 2>&1; echo "EXIT=$?"
echo "main/preload: $(grep -cE '^apps/desktop/src/(main|preload)/' /tmp/tsc.txt)"
echo "renderer:     $(grep -cE '^apps/desktop/src/renderer/' /tmp/tsc.txt)"
```

**批三完成后 `renderer` 应为 0。**

**「`renderer` 有错误」证明「有人在改渲染端」，那不需要看错误文本。**
**这是「判据 vs 清单」的第三层：连「代码形状」都不依赖，只依赖「哪里出错」。**

### 派活时该做的

**开工前通知相关线**：「O5 三批进行中，`FileEditor.tsx` / `preload/index.ts` 会在 2–4 小时内报
`isOnlyOffice*` 未导出，那不是你的。」

**给他们一条区分命令**：

```bash
# ⚠️ 不要用管道取退出码（CLAUDE.md 第二十二条）—— 先重定向，再分别看
cd apps/desktop
node scripts/run-smokes.mjs <你的套件> > /tmp/o 2>&1; echo "EXIT=$?"
grep -c "isOnlyOffice\|onlyoffice" /tmp/o
# grep 命中 > 0 → 是 O5 在途；= 0 → 是你自己的
```

### 完成时该做的

**主动通知**：「O5 三批全部落地，不再有 `isOnlyOffice*` 未导出，你的套件应该绿了。」

**不要让他们盯着。** 报红的那个线欠「什么时候会好」这个答案。

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

### 批一（契约层）回写 —— 2026-10-24，提交 `bd7c8cd5`

**范围**：只动 `packages/contracts/src/**` + 两个其主体就是契约的套件；batch 二/三 的
`apps/desktop/src/main/**`、`preload/**`、`renderer/**` 一行未改。

**§三 的选择：A（保留 `"office"`，改语义并写注释）**。理由（写在 `documentKind.ts` 顶部）：

- `DocumentKind` 回答「这是什么**种类**的文档」，不回答「用哪个引擎打开」。引擎选择在
  `genofficeFileRoute.ts` 的 `genofficeAppForPath`（`GenofficeApp` 轴）与
  `isGenofficeViewAvailableFor`（能力轴）。改名为 `"genoffice"` 会把引擎名烧进种类轴。
- `"office"` 一词从未指 OnlyOffice；`ONLYOFFICE_EDITABLE` 只是**当时**那张表的来源。
- 集合**保持原样，没有收窄到 GenOffice 路由集合**：收窄会让 `docm/dotx/xltx/pptm/potx`
  掉进 `text`（用文本编辑器打开二进制）。「是 Office 格式」与「GenOffice 能否打开」是
  两件事 —— 前者归本文件，后者归路由 + 能力位；打不开时上层必须明确报不支持。
  **负控**：`document-router-smoke §3` 现在钉住 12+6 个扩展名与
  「清单外不落 office 两档」，收窄或私加一个都会红。

**删掉的契约面（逐项）**：

1. `packages/contracts/src/ipc/onlyoffice.ts` 整文件（244 行）：`OnlyOfficeConfigSchema` /
   `DEFAULT_ONLYOFFICE_CONFIG` / `parseOnlyOfficeConfig` / `ONLYOFFICE_CONFIG_SETTING_KEY` /
   `ONLYOFFICE_EDITABLE` / `ONLYOFFICE_VIEW_ONLY` / 三个 `isOnlyOffice*Path` /
   `OnlyOfficeOpenSchema|Result` / `OnlyOfficeSession(State)` / `OnlyOfficeStatusResult` /
   `OnlyOfficeSetConfigSchema` / `OnlyOfficeLocalDetectResult` / `OnlyOfficeInstallPhase|Progress`。
2. `ipc.ts` 的 `export * from "./ipc/onlyoffice.js"`。
3. `rpcMap.ts`：`onlyoffice.open|forceSave|sessionState|close|status|getConfig|setConfig|detectLocal`
   八条 RpcMap 方法（含 JSDoc）+ 八条 `ONLYOFFICE_*` 通道常量。
4. `runtimes.ts`：`TOOLCHAIN_TOOL_IDS` 去掉 `"onlyoffice"`（工具链里的编辑器后端）。
5. `genofficeFileRoute.ts`：文件头把「OnlyOffice capability check」改成「editor-capability check」。

**生成链（三步都跑了，产物非手改）**：

```
rpcMap.ts 删 8 条后：
  node scripts/gen-app-api-catalog.mjs        → wrote 451 entries（459 − 8）
  node --experimental-strip-types scripts/gen-module-permission-map.mjs
                                              → 451 RPC methods, 79 blocked
```

**收尾判据（§五之零 的两条 grep，实测 0/0）**，并按卡要求做了「重置生成物→重生成」对照：

```
git checkout HEAD -- <两个生成物> && 重跑两步生成
  → 输出与提交内容逐字节一致（cmp 通过）
  → 证明不是手改产物
grep -c onlyoffice apiCatalog.generated.ts → 0
grep -c onlyoffice appPermission.ts        → 0
```

`appPermission.ts` 的 diff 里另有 `modules.installVsix` / `task.*` 的重排 —— 那是**开工前
就在工作区的生成输出**（对应已提交的 rpcMap 变化），重生成确认一致后一并提交。**不是手写。**

**因契约删除必须跟着改的套件（两个，都是「主体就是契约」）**：

- `document-router-smoke`：§3「两表对账」的第二张表已不存在 → 改为「documentKind 集合 =
  期望清单」（12 可编辑 + 6 只读 + 清单外不落两档）。
- `settings-export-secrets-smoke`：`onlyoffice.config` 不再从
  `ONLYOFFICE_CONFIG_SETTING_KEY` 取（常量已删），改由 `SECRET_SETTING_KEYS` 覆盖该键；
  覆盖没有降低（见该文件注释）。

**验证**：

```
npx tsc --noEmit -p packages/contracts/tsconfig.json   exit=0
pnpm test:smoke document-router-smoke                  PASS（103/103）
pnpm test:smoke file-routing-contract-smoke            PASS
pnpm test:smoke genoffice-file-routing-smoke           PASS
pnpm test:smoke app-control-smoke                      PASS（rpcMap 漂移检测用集合比较，删8条不影响）
pnpm test:smoke capability-smoke                       PASS
pnpm test:smoke settings-export-secrets-smoke          PASS
pnpm test:smoke t150-smokes-for-contracts-smoke        PASS
```

**`apps/desktop` tsc 现在是红的 —— 这是分层切割的预期形态，不是破损**：全部错误落在
批二/批三 文件里（`main/onlyoffice/**`、`main/ipc/onlyoffice.ts`、`main/env/**`、
`preload/index.ts`、`renderer` 的 OnlyOffice 面板、以及驱动它们的套件如
`installers-ipc-smoke` / `updater-tools-smoke` / `markdown-mode-smoke` / `t101-*`）。

**未做 / 留给后续批次判断的**：

- `documentKind.ts` 里 `OFFICE_EDITABLE` 集合**未收窄**（理由见上）。是否收窄到 GenOffice
  路由集合属于批二的能力路由问题，且 §六 要求先做五格式实测 —— 批一不做。
- `t101-office-genoffice-fallback-smoke` 的前提（「OnlyOffice 未配置时的第二条路」）随
  OnlyOffice 删除整体作废；它 import 了已删的 `isOnlyOfficeSupportedPath` —— 批三重写
  `fileEditorKinds.ts` / `FileEditor.tsx` 时一并处置（要么改造为 GenOffice-only 判据，
  要么删除并说明）。
- `markdown-mode-smoke` 读 `packages/contracts/src/ipc/onlyoffice.ts` 的 AST 段（为在 vm 沙箱
  执行真判据）现在 ENOENT。它断言的是「office 文件落在 OnlyOfficeEditorPane」—— 批三改
  `FileEditor.tsx` 时一并重写（届时这条判据本身要被 GenOffice 取代）。
- `app-control-smoke` 里「onlyoffice 域」的几条（凭据族 / MC-066）仍引用 `policy.ts` 的
  onlyoffice 档位，批二删 `policy.ts` 条目时一并处理。
- 工作区里 `packages/contracts/src/conditionBridge.ts`（未跟踪）是**工作流线**的新文件，
  与本卡无关，**未动**。
