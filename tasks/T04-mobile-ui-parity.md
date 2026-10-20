# T04｜手机远程全量 UI 对齐

| 项目 | 值 |
|---|---|
| 编号 | T04 |
| 类型 | ARC-005（用户明确要求「包括手机远程也是」） |
| 优先级 | 中高 |
| 建议并发 | 可与 T01/T02/T03 并行（文件边界不重叠） |
| 预计规模 | 中 |

---

## 为什么做这个任务

手机端（`AppMobile.tsx` + `components/mobile/*`，约 4200 行）是**独立组件树**，
走无 preload 的 HTTP 桥（`webApi.ts`）。它和桌面端共用一部分组件（`ChatPane`、
`Segmented`、`Dialog`），但自己实现了抽屉、Git、文件、设置四个屏。

桌面端刚刚完成了一轮「CDS 视觉语言」重构（品牌色语义收窄、圆角/阴影 token、
分段控件、安全区、状态点）。手机端**只跟了一部分**：

- 已跟：`MobileSessionDrawer` 的视图切换、Git 的变更/暂存切换、配对页二选一、
  四张底部抽屉的安全区、卡片圆角。
- **没跟**：`MobileFilesScreen`、`MobileDomainPanel`、`MobileFileViewer`、
  `MobileGitScreen` 的其余部分（约 12 处 `rounded-lg`、自写按钮组、状态色）、
  `PairingScreen` 的输入框与提交按钮、`MobileSettingsSheet` 的其余分组。

而且手机端**从未做过真机/窄视口验收** —— 所有断言都是源码级（E2）。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `CLAUDE.md` 的「环境事实」——特别是：手机端是**独立组件树**，共用组件里每加一个
   RPC 都要在 `webApi.ts` 补一项，漏了会同步抛错、React 19 整棵卸载。
3. `apps/desktop/src/renderer/AppMobile.tsx` 文件头注释（它写明了与桌面的差异清单）。
4. `apps/desktop/src/renderer/components/ui/cds/` 下全部组件（这是要对齐的目标语言）。
5. `apps/desktop/scripts/mobile-api-surface-smoke/main.ts` —— 现有的 RPC 覆盖率检查。

---

## 执行内容

### 1. 补齐视觉 token（不改行为）

逐个文件把以下三类收口，**每改一处都要能说出它原来的语义是什么**：

- `rounded-lg` / `rounded-xl` / `rounded-2xl` → `--radius-card` / `--radius-btn-md` /
  `--radius-dialog`（按语义选，不是一刀切）。
- 自写按钮组 / 高亮底 → 复用 `Segmented`（如果语义是"二选一/多选一"）或
  中性 `surface-hover + ring-edge/70`（如果语义是"选中项"）。
- 裸 Tailwind 色阶（`text-red-500` / `bg-emerald-500`）→ `--danger` / `--success` /
  `--warning`。
- 品牌色淡底（`bg-accent/10`、`bg-accent/15`）→ 按同一判据判断：
  **运行中/需要注意保留 accent，选中/开关已开改中性**。

**判据不是我的偏好，是已经落地并被 design-tokens-smoke 门禁住的规则。**
先读 `apps/desktop/scripts/design-tokens-smoke/main.ts` 里 `ACTIVE_ACCENT_ALLOWED` /
`TINT10_ALLOWED` 两个白名单及其注释。

### 2. 复用而非重写

- 手机端的「空状态 / 错误提示 / 加载态 / 表单行 / 状态徽标」必须先看
  `components/ui/` 的 `EmptyState` / `ErrorNote` / `Spinner` / `Skeleton` / `Field` / `Badge`，
  **没有再造**（这是 `CLAUDE.md` 硬规矩第 7 条）。
- 如果手机端的用法和桌面确实不同（例如 44px 触控目标），**在调用处给 className 覆盖**，
  不要 fork 一份组件。

### 3. 真视口验收

新增 `apps/desktop/scripts/mobile-viewport-smoke/`：

- 用现有 Chrome smoke 脚手架（参考 `ui-interaction-smoke` / `settings-layout-smoke`
  怎么在假 DOM 或真浏览器里跑），在 **375×812（iPhone 竖屏）** 与 **768×1024（平板）**
  两个视口下：
  - 断言抽屉打开/关闭后无横向滚动条（`documentElement.scrollWidth <= clientWidth`）；
  - 断言底部抽屉的底部内边距 ≥ 安全区值；
  - 断言触控目标高度 ≥ 44px（逐个列出哪些不达标）。
- 这些断言要在**改之前先跑一遍**，把不达标项记录下来（这是"旧红"），改完再跑（"新绿"）。

### 4. 手机端专属回归

`mobile-api-surface-smoke` 会检查共用组件用到的 RPC 是否都在 `webApi.ts` 里有。
本次如果新增了任何共用组件的调用，**必须同步补 `webApi.ts`**，否则手机端会整棵卸载。
这条要有一条显式断言（你可以复用该套件已有的机制）。

---

## 边界（不要碰）

- **不要**改桌面端组件（`components/layout/`、`components/chat/` 等）。
  **例外**：如果你在共用组件里发现"手机端传入的 className 被丢弃"这类缺陷，
  可以修，但要在回写区单独列出。
- **不要**改 `apps/desktop/src/main/mobile/**`（HTTP 服务、配对、隧道）。
- **不要**改 `webApi.ts` 的既有方法签名（只允许新增）。
- 不要引入新的 UI 依赖。

---

## 验收判据

1. 375×812 与 768×1024 两个视口下无横向滚动、触控目标达标（不达标的要列出并说明原因）。
2. 手机端所有"选中/开关"类视觉不再用品牌色（用与桌面同一套扫描逻辑自查一次）。
3. `mobile-api-surface-smoke` / `mobile-pairing-smoke` / `ui-interaction-smoke` /
   `design-tokens-smoke` 全绿。
4. `pnpm test:all` 全绿，双包 tsc 干净。
5. **变异验证**：撤掉任意一处安全区 → 对应断言必须变红。

---

## 你要在回写区回答的问题

- 手机端还有哪些**功能**（不是视觉）与桌面不一致？逐条列（这决定下一步派什么任务）。
- 触控目标 44px 这条，有多少个不达标？是设计取舍还是遗漏？
- 你实际在什么环境下验的？（真机 / 浏览器视口模拟 / 只是源码级）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 T04 执行结果

- **触及范围**：`apps/desktop/src/renderer/components/mobile/` 11 个组件与新建的 `apps/desktop/scripts/mobile-viewport-smoke/`。无主进程、webApi 签名、桌面共享组件或新 UI 依赖改动。
- **CDS 语义**：按钮、输入及卡片按用途分别使用 `--radius-btn-md`、`--radius-card`；配对页使用共享 `Input` 和已有 `Segmented`；文件页空状态、加载态改用共享 `EmptyState`、`Spinner`；隧道成功信号改为 `success`，Git 当前分支由 accent 改为中性选中态。保留 Git added 类型色、实际运行/关注提示用 accent。针对 `components/mobile` 的扫描仅剩 `MobileGitScreen.tsx` 的 Git added 合法白名单与 `PatchView.tsx` 的历史色阶**注释**。
- **旧红**：真实 Chromium 几何夹具在 375×812、768×1024 两种尺寸初次执行，配对页 4、设置页 2、文件页 3、Git 页 12、分支弹层 3，共 **24 个不同的可见触控目标高度低于 44px**（两个视口均复现；按项目语义为遗漏而非有意设计）。补充操作路径覆盖后又发现重命名弹层取消/保存 **2** 个、活动弹层抓手 **1** 个，共累计识别并修复 **27 个**不同触控目标。修复后通过本套几何扫描，不再出现低于 44px 的可见输入/按钮。
- **新绿**：`node scripts/mobile-viewport-smoke/main.mjs`，真实 Windows Chromium CDP，两视口共 **96 断言通过、0 失败**；场景覆盖配对、设置、会话抽屉开关、行操作弹层、重命名、文件、Git、分支切换、文件预览、移动预览、活动弹层；检查水平溢出、可见控件几何尺寸、底部安全区 CSS 计算值及 React 异常。这是**真实浏览器视口模拟**，并非 iPhone/iPad 物理真机验收，也不是仅源码 grep；尚不能代表 iOS Safari 原生安全区及软键盘行为。
- **变异验证**：`set MCODE_T04_MUTATE_SAFE=1&& node scripts/mobile-viewport-smoke/main.mjs`（Windows cmd，`apps/desktop`），仅临时测试 bundle 把设置弹层 `pb-[calc(1.5rem+var(--safe-bottom,0px))]` 改为 `pb-0`，375×812 和 768×1024 的 `settings safe-area padding >=24px` 各失败一次，**exit 1 / 96 断言中 2 红**，原源码不动。其他三个安全区弹层按场景分别要求探针必须存在且 computed padding 达标。
- **手机专属回归**：`node scripts/run-smokes.mjs mobile-viewport-smoke mobile-api-surface-smoke mobile-pairing-smoke ui-interaction-smoke design-tokens-smoke` 全绿（5 pass，0 fail）。其中特意重跑 `mobile-api-surface-smoke` 作为手机 RPC 覆盖的显式检查；本任务未新增 RPC。
- **双包类型**：仓库根执行 `pnpm typecheck`，3 turbo tasks successful、退出码 0，包含 contracts/desktop。
- **全量回归（验收判据 4 未达成）**：仓库根 `pnpm test:all` **退出 1**；脚本自身 12 tests passed，497 套 smoke 中 **485 通过、12 失败**：`maint-m22-smoke`、`collaboration-commit-audit-smoke`、`document-router-smoke`、`executor-owner-identity-smoke`、`executor-ownership-smoke`、`flow-migration-smoke`、`html-preview-electron-smoke`、`maint-m07-smoke`、`maint-m35-smoke`、`automation-smoke`、`release-readiness-smoke`、`updater-tools-smoke`。其中能直接识别的外因包括缺失 `build/collaboration-commit-audit.cjs`、其他领域断言失败和 Windows/Electron bundle dynamic require 问题。这些失败不在 T04 文件边界，按任务要求没有越界修改。完整日志：`apps/desktop/.tmp/smoke-runs/1792532476323-31316-Z20lvs`；五套定向全绿日志：`apps/desktop/.tmp/smoke-runs/1792533105605-29920-JlgqM4`。
- **尚存手机端功能差异（并非本任务视觉范围）**：独立网页认证配对和 HTTP/SSE 传输，不是桌面 preload；没有 Electron 标题栏/三栏工作区、右侧 IDE、终端和内嵌浏览器；文件页以只读查看替代桌面的 Monaco/LSP 编辑；手机设置仅保留主题/标签模式/配对管理；手机抽屉不支持本机文件夹选项目、分组拖拽排序；会话显示仅挂载当前活动聊天面板，不保活桌面那样的多后台 pane。这些由 `AppMobile.tsx` 与移动壳实现刻意保留，未在 T04 引入行为修改。
