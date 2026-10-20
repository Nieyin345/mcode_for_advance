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
