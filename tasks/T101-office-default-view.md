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
