# UI 重构交接（2026-10-27）

> **状态：代码已落盘，但仓库被另一条线的改动阻断，无法验证。**
> 本文如实写清「做了什么、没做什么、被什么卡住、怎么解」。

---

## 一、已完成（代码已写入，可独立复核）

### 1.1 外观基准换成用户本机 Claude

| 项 | 之前 | 现在 |
|---|---|---|
| token 源 | `open-claude-ui/code-examples/cds-theme.css`（第三方 2.x 逆向） | **本机 Claude 3.1623.4.0** 的 `ion-dist/assets/v1/*.css` |
| 色阶 | gray + orange 两系（70 个） | **9 系 × 35 档 = 317 个** |
| 几何 token | 手工列 22 个 | **151 个**（含 `--cmp-*` composer 全套） |
| 语义链 | 无 | `--cds-neutral-*` / `--surface-*` / `--text-*` / `--fill-*` 整条 |
| 暗色 | 手工写两套值 | **语义链反转**（Claude 的真实机制） |
| 密度档 | 无 | `html[data-density="compact"]` |

- 生成器：`apps/desktop/scripts/gen-cds-tokens.mjs`（可重跑，`--check` 已通过）
- 产物：`apps/desktop/src/renderer/tokens.cds.css`（859 行，括号平衡已验）

### 1.2 外壳结构换掉

| 文件 | 作用 |
|---|---|
| `components/shell/chatColumn.ts` | Claude 的 `data-chat-column` 列覆盖模型（project/thread/loading） |
| `components/shell/paneTiles.ts` | Claude 的 pane tile 递归树（`tile`/`stack`、`flex`、开/关/校验） |
| `components/shell/ClaudeShell.tsx` | 新外壳：列覆盖 + tile 树，保 PTY/Monaco 不卸载 |
| `components/shell/TilePane.tsx` | 递归渲染 tile 树（`data-pane-root` / `data-pane-title`） |
| `components/shell/ClaudeSidebar.tsx` | Claude 侧栏：Pinned / Projects / Recents，288px，28px 行高，分支徽章 |
| `components/shell/ClaudeTitlebar.tsx` | Claude 顶栏：48px 标题行 + PageHeader + `⋯` 溢出菜单 |
| `components/shell/ClaudeShellMount.tsx` | 装配层：把 store 与新外壳接起来 |
| `components/shell/paneContent.tsx` | tile id → 现有面板（文件/Git/终端/预览/任务/扩展） |

接线：`App.tsx:314` 渲染 `ClaudeShellMount`（旧 `ClassicShell` 不再由 App 使用）。

### 1.3 尺寸与排版对齐 Claude（这是「看起来不像」的真正原因）

| 项 | 之前 | 现在（Claude 真实值） | 差异 |
|---|---|---|---|
| 正文字号 | **15px** | **12.24px** | −23% |
| 正文行高 | 1.625 | **1.5378** | — |
| 侧栏宽 | 百分比（12–40%） | **288px 固定** | — |
| 侧栏行高 | 未定 | **28px** | — |
| composer 圆角 | **20px** | **13.18px** | −34% |
| 表面层级 | 2 级（surface / muted） | **4 级**（surface-0..3） | 新增 |
| 轮次间距 | 写死 0.625rem | `body × leading × .75` **相对公式** | 字号变则自动跟 |
| 轮内间距 | 写死 0.9375rem | `body × leading × .5` | 同上 |
| 助手正文缩进 | 4px | **0px** | — |
| 字重档 | 400/500/600 | **400/500/580** | — |

### 1.4 验收工具改指本机 Claude

- `arc005-visual-baseline/compare.mjs`：上游参照从第三方 CSS 换成本机 Claude 安装包，
  用 PowerShell 查 Appx 拿路径（`WindowsApps` 不允许列目录）。找不到就显式失败。
- 探针兼容标记已补：新壳沿用 `data-ui-shell-variant="workspace"` /
  `[data-testid='workspace-sidebar']` / `[data-ui-center-pane]` / `[data-cds-aside]`，
  **探针本身不用改**。

---

## 二、没做（如实）

| 项 | 状态 |
|---|---|
| 主列：思考块 / 工具卡四态 / 审批卡三钮 | **未改**（现有实现功能完整，只差视觉对齐） |
| composer 的 chin 行与附件条 | **未改**（token 已备齐，组件未接） |
| 空态（project 列起点卡） | **未改** |
| 右侧 pane 拖拽分栏 / 弹出窗口 | **未做**（tile 树支持，但未接拖拽交互） |
| 设置页 107 个文件 | **未改** |
| 命令面板 / 对话框 / toast | **未改** |
| Office / 扩展 / 工作流三线接入 | **未接**（`paneContent.tsx` 留了分支，指向现有面板） |
| 删旧 `ClassicShell` / `open-claude-ui` | **未删**（仍被 54 套 smoke 引用） |

---

## 三、被什么卡住（这是当前最大问题）

**仓库当前不可构建**，原因是另一条并行线（扩展系统合并）的改动没收尾：

```
packages/contracts/src/ipc.ts:137        export * from "./ipc/modules.js"      ← 文件已删
packages/contracts/src/nodeType.ts:1     from "./moduleCapability.js"          ← 文件已删
packages/contracts/src/runtime.ts:9      from "./moduleCapability.js"          ← 文件已删
packages/contracts/src/moduleClient.ts:1 from "./modules.js"                   ← 文件已删
apps/desktop/src/renderer/components/... from "@contracts/modules"             ← 模块已删
```

来源提交：`85611357 refactor(extensions): one extension system — Theia plugin host + Mcode bridge`
（24 分钟前）。它把 `modules.ts` / `moduleCapability.ts` / `modulePermissions.ts`
暂存删除（`git status` 显示 `D `），但**引用没清完**。

**证据链**：`packages/contracts/src/ipc/theia.ts` 的头注释写着「本文件从原来的
`ipc/modules.ts` 里把 Theia 那部分原样搬出来 —— 其余内容……已随 ModuleHost 一起删除」。
说明这是**有意的合并**，只是收尾漏了几处 import。

**我已修的一处**：`ipc.ts:137` 的 `./ipc/modules.js` → `./ipc/theia.js`。
其余三处（`nodeType.ts` / `runtime.ts` / `moduleClient.ts`）依赖被删文件里的
**工作流节点能力契约**（`MODULE_CAPABILITY_RUNNER_KIND` / `ModuleWorkflowCallSchema` /
`ModuleWorkflowExecutionInput`），不属于 Theia，**删错了**，需要那条线自己把
这几个类型搬到新位置。

**这不在我的范围，也不该由我恢复** —— 按 CLAUDE.md 第 23/24 条，别人正在改的文件
不碰。恢复会让两条线冲突。

---

## 四、解除阻塞后要跑什么

```bash
# 1. 确认契约断链已由扩展线修好
node -e "require('fs').existsSync('packages/contracts/src/moduleCapability.ts')"

# 2. 双包类型检查
npx tsc --noEmit -p packages/contracts/tsconfig.json
npx tsc --noEmit -p apps/desktop/tsconfig.json

# 3. token 生成物与 Claude 一致
node apps/desktop/scripts/gen-cds-tokens.mjs --check

# 4. 真 Electron 截图（这是唯一能看「像不像」的手段）
node apps/desktop/scripts/arc005-visual-baseline/build.mjs
node apps/desktop/scripts/arc005-visual-baseline/compare.mjs
# 产物：.tmp/arc005-visual/*.png + diff.md

# 5. 全量套件
pnpm test:all
```

**已知会红的套件**（都因为外壳结构变了，需要跟着迁移夹具）：
`arc005-pane-docking-smoke`、`arc005-editor-keepalive-smoke`、`workspace-shell-smoke`、
`settings-layout-smoke`，以及所有断言 `[data-testid='workspace-sidebar']` 之外的旧壳标记的套件。

---

## 五、判断「像不像」的方法

**不能用套件绿来证明。** `arc005-visual-baseline/README.md` 自己写着：48 张图两轮
连跑只有 12 张逐字节相同，PNG 不是判据。

唯一可靠的判据是：**同尺寸、同主题、同 DPI 下，Mcode 截图与 Claude 截图逐屏并排看。**
当前已有的对照物：`.tmp/arc005-visual/*.review.jpg`（上一轮浅色/深色/窄窗）。

要看新壳，必须先解除第三节的阻塞。
