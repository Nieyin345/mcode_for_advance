# T66｜sessionStore 按域切片（7603 行 → 多个小 store）

| 项目 | 值 |
|---|---|
| 编号 | T66 |
| 类型 | **技术债**（优化方向标「仍是一个大文件，还在涨」） |
| 优先级 | **最高** —— 所有改 store 的任务都被它拖慢 |
| 建议并发 | **不要与任何改 `stores/` 的任务并行** |
| 预计规模 | **大** |

---

## 前置条件

- **无前置**，但**必须单独派** —— 它改的是所有人的共同依赖。
- 开工前 `git status --short apps/desktop/src/renderer/stores/` 必须干净。

---

## 现状（实测，2026-10-21）

```
apps/desktop/src/renderer/stores/sessionStore.ts        7,603 行
```

**145 个动作**，按语义分组：

| 组 | 动作数 | 例 |
|---|---|---|
| Git | 9 | `setGitDiffDialog` 等 |
| Project | 7 | `setActiveProject` 等 |
| Browser | 7 | `setBrowserTab` 等 |
| Right（右栏） | 6 | `setRightPanelTab` 等 |
| Plan | 5 | `setPlanDraft` 等 |
| Ide | 5 | `setIdeActiveFile` 等 |
| File | 5 | `openFile` / `closeFile` 等 |
| Custom（自定义面板） | 5 | |
| Tab | 4 | |
| 其余 20+ 组 | 各 1–3 | |

**文件里已经有三个分片**：

```
sessionStore.ts          7,603 行  ← 主体
sessionStoreTypes.ts               ← 类型
sessionStoreHelpers.ts             ← 常量与纯函数
sessionStoreBlocks.ts              ← 块相关
```

**说明拆分已经开始过，但主体还是太大。**

---

## 为什么这条重要

`tasks/README.md` 与多张卡里都写着：

> **不要与任何改 store 的任务并行**

**这句话每次都要写，是因为它真的挡路。** 12,000 行时是这样，7,603 行时还是这样 ——
任何两个人同时改 store 就必撞。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/renderer/stores/sessionStore.ts` **全文**（7,603 行，分几次读）。
3. `sessionStoreTypes.ts` / `sessionStoreHelpers.ts` / `sessionStoreBlocks.ts` ——
   **看看已经拆出去的三个文件是怎么拆的**，照它的模式。
4. `apps/desktop/src/renderer/stores/customUiStore.ts` / `libraryStore.ts` /
   `toastStore.ts` / `fileViewStore.ts` —— **这些是已经独立的 store**，看它们的边界。
5. `apps/desktop/scripts/session-store-smoke/` —— 现有回归网。
6. `CLAUDE.md` 硬规矩 7 —— 渲染端读数据走 `useRpc`。

---

## 执行内容

### 第 1 步：先补测试（**仓库硬规矩 1**）

> **先补测试，再动刀。大重构前给要改的路径写断言。**

`session-store-smoke` 现在覆盖什么？**不够的部分先补**。

**要覆盖的**：
- 每个组的关键动作（读 → 写 → 读回）
- 跨组的交互（比如切项目时打开的文件怎么变）
- 持久化（哪些字段进 `localStorage` / `SettingRepo`）

**判据**：补完之后，把 `sessionStore.ts` 里任意一个动作**故意改坏**，
测试要红。

### 第 2 步：按域分组，先拆最独立的

**不要一次拆完。** 按「独立性」排序：

| 优先 | 组 | 为什么 |
|---|---|---|
| 1 | **Browser**（7 个动作） | 浏览器状态与其它几乎不交互 |
| 2 | **Git**（9 个） | diff 对话框状态是独立的 |
| 3 | **Custom / CustomUi**（5 个） | 已经有 `customUiStore.ts`，可能是重复 |
| 4 | **Plan**（5 个） | 计划草稿是局部的 |
| 5 | **Workflow**（2 个） | |
| … | … | … |

**先做前两组**，提交一次，跑回归，再往下。

### 第 3 步：拆的方式

```ts
// stores/browserStore.ts
export const useBrowserStore = create<BrowserState>((set, get) => ({ ... }));
```

**跨 store 的读取怎么处理**：

- 同一个组件里读两个 store → 直接调两个 hook
- 一个 store 的动作要读另一个 store 的状态 → `useOtherStore.getState()`
- **不要**为了「保持一个 store」而把别人的状态拖进来

### 第 4 步：修正所有引用

```bash
grep -rn "useSessionStore" apps/desktop/src/renderer/ | wc -l
```

每个引用点都要检查：它读的是哪个组的状态？换成对应的 store。

**这一步最花时间**，而且最容易漏。

### 第 5 步：最后剩下的主干

拆完几组之后，`sessionStore.ts` 应该只剩「会话本身」的状态：

- `sessionsByProject`
- `activeSessionId`
- `messages` / `blocks`
- `queuedPrompts` / `composerDrafts`
- 消息相关动作

**如果还是太大**（比如 > 3,000 行），再考虑把消息子系统单独拆出去 —— 但那要另开卡。

---

## 边界（不要碰）

- **不改任何 store 的语义** —— 这是纯重构，行为必须一模一样。
- 不改 storage key（`UI_*_SETTING_KEY` 之类）—— 改了用户数据就丢。
- 不改 `sessionStoreTypes.ts` 的既有类型形状。
- 不改 `useRpc` 的用法。
- **不与其他任何任务并行**。

---

## 验收判据

1. **重构前后行为完全一致**：所有现有测试全绿，且**没有改任何断言的语义**。
2. `sessionStore.ts` 行数**降到 3,000 以下**（或说明为什么降不到）。
3. 至少拆出 **3 个独立 store**（Browser / Git / 一个自选）。
4. 所有 `useSessionStore` 引用点都检查过（有清单）。
5. 持久化 key 一个没变（有断言）。
6. 双包 tsc 干净。
7. **变异验证**：把拆出去的一个 store 的某个动作改坏 → 现有测试要红
   （证明测试真的覆盖到了新位置）。

---

## 回写区要回答

- 拆出了哪几个 store？各多少行？
- `sessionStore.ts` 从 7,603 行降到多少？
- 跨 store 的读取怎么处理的？有没有出现循环依赖？
- 多少个引用点要改？`grep` 的结果是多少？
- 有没有哪个组**拆不动**？为什么？
- 持久化 key 有没有一个变？（必须一个没变）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### T66 执行回写（2026-10-21）

- **独立 store**：`browserStore.ts` 92 行（10 个动作）、`gitStore.ts` 100 行（10 个动作）、`customCommandsStore.ts` 34 行（4 个动作）；另有 `sessionStoreDomainBridge.ts` 65 行（兼容旧入口）。
- **主文件**：`sessionStore.ts` 从开工读取的 7,604 行缩到 7,456 行（命令 `python -c "len(...splitlines())"`）。**未降到 3,000 行**：此次卡限定先拆 Browser、Git 和一个自选域，余下大部分是会话消息/回合、初始化、IDE、布局、模型等仍直接相互依赖的主干；任务书明确说拆消息子系统须另开卡；为保证纯重构语义，未越界硬拆。接受判据 2 的“或说明原因”，但绝不宣称完成 3,000 行目标。
- **跨 store 与循环依赖**：域 store 内部使用自身的 `getState()`，跨域（浏览器触发右栏、Git 需要活动项目）由 session 层注入回调；互相不运行时反向 import；`sessionStoreDomainBridge` 保留旧调用方 `useSessionStore` 和已有 `setState` 兼容（从独立域向主 store 同步、旧写入也能同步回域），不修改既有 `SessionState` 类型形状。无新增显式运行时循环依赖。
- **引用清点**：迁移前 renderer 下 **138 文件 / 1,066 处** `useSessionStore` 字面引用；先自动迁移纯域读取 **43 处（12 文件）**，后手动处理复合 selector、Git 动作及浏览器待处理 URL；重扫为 **138 文件 / 1,017 处**。各文件逐一静态巡检清单见 `tasks/T66-reference-audit.md`，简单的单字段旧域 selector 检查遗留 **0 处**。剩余属于会话/布局/复合读取及旧兼容行为，没有作为独立域重复管理。
- **不可进一步独立的组**：消息/回合与 init、项目切换及编辑器布局有实际跨组依赖，当前刻意保留会话主 store，并用兼容 bridge 支持历史消费者；`customUiStore.ts` 原本为自定义 UI 独立实现，与本次按项目的“自定义命令”不是同域，不重复拆它。
- **持久化**：未更改任何设置 storage key、`localStorage` 键或既有类型形状。模拟 `setting.set` 的断言验证 `ui.gitDiffOpenMode`、`ui.gitCollapsedRepos`、`ui.customCommandsByProject` 原键仍写入；IDE/其他存储位置未迁移。
- **护栏 / 变异**：先给 `session-store-smoke` 加 Browser、Git、CustomCommands 行为和 key 断言；主 store 变异 `setBrowserTabCount` 删除负数钳制，观察到 **322/323**（FAIL）；恢复后绿。迁出后对 `browserStore.ts` 同一动作再变异，观察到 **329/332**（FAIL，3 条红断言）；恢复后 `node scripts/run-smokes.mjs session-store-smoke` PASS（332/332）。
- **类型检查**：`pnpm typecheck` 双包通过（contracts + desktop，3/3 turbo tasks）。
- **全量现有回归**：`pnpm test` 的 critical 17 套中 **16 PASS、1 FAIL**，失败为 `mcp-endpoint-smoke` 的 esbuild 构建（单独重跑同样失败；测试所涉主进程文件正在被其他并行任务修改，本任务未修改该套件）。所以**判据 1 的“所有现有测试全绿”未达成**；不能以 session-store-smoke 全绿冒充整体全绿。
- **并行工作树保护**：开工时 `stores/` 干净；其他人对主进程/hooks 等有未提交工作，本提交只暂存 T66 所列文件，不清理不覆盖他人改动。
