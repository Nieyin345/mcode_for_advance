# T02｜自由 Pane 停靠（**直接抄 `open-claude-ui` 的逆向成果**）

| 项目 | 值 |
|---|---|
| 编号 | T02 |
| 类型 | ARC-005 核心缺口 |
| 优先级 | 高 |
| 建议并发 | **不要与任何改 `sessionStore.ts` 的任务并行**（7510 行） |
| 预计规模 | 中 |

---

## 头号规则：这个仓库里已经有逆向好的实现，**不许自己设计**

`open-claude-ui/`（MIT，REA 对 Claude 桌面端的取证）里有：

| 文件 | 它能直接给你的 | 怎么用 |
|---|---|---|
| **`code-examples/ArtifactsSplitPaneResizer.tsx`** | **双栏分割的完整物理规则**：4px 移动死区、Escape 撤销、双击 50/50 吸附、边缘折叠门限（<18% / >82%）、最小宽度钳制（左 380 / 右 420）、拖拽期间 iframe 护盾（`data-pane-dragging` + `pointer-events:none` 遮罩） | **逐条照搬**这些常量与状态机，只把落点从「左右两向」扩到「三向」 |
| `code-examples/DraggableSessionList.tsx` | 侧栏拖放的 4px 死区、拖拽幽灵（-1.5° 倾斜 + 模糊 + 发丝阴影）、落点导轨、Alt+Up/Down 键盘重排 | 会话列表如果也要拖，抄这个 |
| `code-examples/useClaudeRovingFocus.ts` | 漫游焦点 | 已在用（`hooks/useRovingFocus.ts`） |
| `code-examples/ScrollFadeContainer.tsx` | 7 档非线性滚动羽化 | 已在用（`ui/cds/ScrollFade.tsx`） |

**仓库里另外已经有的**（也要复用，不许重写）：

| 能力 | 现成的 | 位置 |
|---|---|---|
| 拖拽引擎 | `@dnd-kit/core` + `sortable` | 已装，6 个组件在用 |
| 分隔条 | `Divider.tsx`（指针捕获 / 键盘 / IME / ResizeObserver） | `components/layout/` |
| 落点几何 | `dockSideAtPoint` | `components/layout/paneDock.ts` |
| 不重建树 | `dockFlexOrder`（注释写明了原因） | 同上 |
| 尺寸写入队列 | `paneWidthWriteQueue.ts` | `stores/` |
| 首帧恢复 | `parseSavedPaneLayout` | `stores/paneLayoutPrefs.ts` |

**唯一需要新写的**：把「两向 dock」扩成「三向 + 多 pane 分配」的那点纯函数。
其它全部复用或照抄。

---

## 开工前必读

1. `open-claude-ui/code-examples/ArtifactsSplitPaneResizer.tsx` **全文**（约 200 行）——
   这是本任务的主要来源。
2. `open-claude-ui/AGENTS.md` 的「Physics」与「Input & Viewport Guards」两节
   （4 个弹簧预设、IME 守卫、150ms 滚动钉住冷却）。
3. `apps/desktop/src/renderer/components/layout/paneDock.ts`（57 行）与 `Divider.tsx`。
4. `apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx`（248 行）。
5. `apps/desktop/scripts/arc005-pane-*` 六套 smoke —— 先全跑一遍确认基线。

---

## 要做什么

### 1. 纯函数层 `paneLayout.ts`（新增，不改 `paneDock.ts`）

```ts
export type PaneId = "left" | "right" | "bottom" | "editor";
export type DockSide = "left" | "right" | "bottom";
export interface PanePlacement { id: PaneId; side: DockSide; order: number; sizePct: number; }
export interface PaneLayout { version: 1; placements: PanePlacement[]; }

export function parsePaneLayout(input: unknown): { layout: PaneLayout; repaired: string[] };
export function movePane(layout: PaneLayout, id: PaneId, side: DockSide, order: number): PaneLayout;
export function clampLayout(layout: PaneLayout): PaneLayout;
```

**损坏输入矩阵**（每条都要断言）：null / 旧格式 / 重复 id / NaN / sizePct 越界 /
缺字段 → 返回合法默认布局 + `repaired` 说明改了什么，**绝不抛错**。
反向正控：合法输入 `repaired` 必须为空。

### 2. 拖拽物理（照抄 `ArtifactsSplitPaneResizer`）

逐条实现它的六条规则，**常量一模一样**：

- 4px 移动死区（防单击微颤与右键误触）
- 拖拽中按 Escape → 回滚到拖拽前比例
- 双击 → 50/50 吸附
- 折叠门限 18% / 82%
- 最小宽度：左 380px / 右 420px
- **iframe 护盾**：拖拽期间根容器加 `data-pane-dragging="true"`，
  并对文档/浏览器面板叠加 `pointer-events:none` 遮罩 —— 这条对 Mcode 尤其重要，
  因为文档面板是真的 `WebContentsView`，鼠标划进去会丢指针捕获。

扩到三向时，`dockSideAtPoint` 的几何要扩展成「按相对位置判三区」，不要另起一套。

### 3. 持久化（复用现有件）

- setting key `ui.paneLayout`，走 `SettingRepo`。
- 写盘走 `createCoalescedPaneWriter`（已有）。
- 首帧恢复走 `parseSavedPaneLayout`（已有），只加字段。

### 4. 测试

- 纯函数损坏矩阵。
- 源码接线：`ThreePaneLayout` 真用了 `DndContext`、真读了新字段。
- 真 Electron 探针：拖动后 PTY 会话 id 不变、Monaco 模型数不变。
- 折叠门限、Escape 回滚、双击吸附各有断言（这些是照抄来的规则，**要证明你真的实现了**）。

---

## 边界（不要碰）

- **不要改 `paneDock.ts`**（6 套 smoke 依赖）。只新增 `paneLayout.ts`。
- **不要改 `Divider.tsx`**（它已处理好指针/键盘/IME）。
- **不要改 `sessionStore.ts` 的既有结构**，只新增一个 key。
- 不要碰 document / mobile / modules / workflowEngines。
- 不要引入新依赖（`@dnd-kit` 已装）。
- **不要改 `open-claude-ui/`**（只读参考）。

---

## 验收判据

1. 现有 6 套 `arc005-pane-*` smoke **全部仍 PASS**。
2. 六条物理规则各有断言（死区 / Escape / 双击 / 折叠 / 最小宽 / iframe 护盾）。
3. 解析器损坏分支全覆盖，`repaired` 反向正控成立。
4. 真 Electron：拖动后 PTY / Monaco 未重建。
5. 布局文件损坏 → 默认布局 + 可见提示，不白屏不崩溃。
6. 双包 tsc 干净。
7. **变异验证**：撤掉折叠门限 → 断言必红；撤掉 iframe 护盾 → 拖拽断言必红。

---

## 你要在回写区回答的问题

- `ArtifactsSplitPaneResizer` 的六条规则，你**逐条**实现了吗？哪条改了、为什么？
- 三向落点怎么从它的两向几何扩展的？
- 复用清单里有没有哪一项你忍不住重写了（如实说）？
- 旧字段与新 `paneLayout` 是什么关系？有没有两处都能写的路径？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜路径不匹配，按任务模板停工

- 用户派发路径：`tasks/T02.md`；实际检查 `agent_read_file` 返回 ENOENT。`tasks/README.md` 指明任务文件必须使用磁盘中的完整文件名，错误简写时应停工；实际磁盘文件为 `tasks/T02-free-pane-grid.md`。本记录仅记载阻塞，不将本文件擅自视作已授权的执行路径。
- 本轮只读取资料并核实工作树；**未修改产品/测试源码、未运行 6 套 smoke、未运行双包 tsc 或 Electron、未做变异验证，验收 1–7 均未执行**。
- 指令冲突/处理：`tasks/_PROMPT_TEMPLATE.md` 要求文件不存在时停止且记录原因；故不进行任务实现，不声明任何验收通过。
- 复核命令/输出：`agent_read_file(tasks/T02.md)` → ENOENT；`agent_list_dir(tasks)` → 存在 `T02-free-pane-grid.md`；`git status --short` → 4 处既有其他对话未提交文件（本轮未碰）。
- 改动文件：仅 `tasks/T02-free-pane-grid.md`（阻塞记录）；不涉及修复源码。无 PASS/FAIL 测试计数、无测试日志、无变异验证/cmp 结果。剩余风险：T02 全部功能与验收尚未开始，需用准确任务路径重新派发。


### 2026-10-21｜正式执行 T02（正确路径）｜自验与交接

- **执行范围**：仅 T02。新增 `components/layout/paneLayout.ts`、`scripts/arc005-pane-free-grid-smoke/{main.ts,run.sh}`；修改 `ThreePaneLayout.tsx`、`ClassicShell.tsx`、`sessionStore.ts`、`sessionStoreTypes.ts`、`paneLayoutPrefs.ts`、`packages/contracts/src/ipc/{settings.ts,settingsSync.ts}`、四份 zh/en layout/store 词典。未改 `paneDock.ts`、`Divider.tsx`、`open-claude-ui`，未碰 document/mobile/modules/workflowEngines；未修改/提交他人既有脏工作树。
- **实现与复用答复**：`ArtifactsSplitPaneResizer` 六项逐条映射：① 4px 左键死区（`PointerSensor` + split 纯函数）；② Escape 取消本地预览，Store 尚未写盘即回滚；③ 双击按 0.5 目标吸附；④ 18% / 82% 边缘折叠判定；⑤ 左 380 / 右 420 的像素钳制（窗口不足 800px 则优先保住可用视口）；⑥ 根 `data-pane-dragging` + iframe/浏览器内容 `pointerEvents:none` 以及透明遮罩。物理常量来自既有 `ArtifactsSplitPaneResizer.tsx`，`Divider` 原件不动。对照差异：参考组件代码本身未实际过滤 4px、未实现左侧折叠，本次抽为可测纯函数补上；50/50 目标仍可能受现存 rightWidth 640px 最大限制，不能声称所有视口都达到精确 50/50。
- **三向落点**：顶部 2/3 直接使用 `dockSideAtPoint` 左右中点，底部 1/3 选择 `bottom`；`movePane` 统一管理 4 个 PaneId 在各 side 的位置与连续 order，不复制旧 `paneDock.ts` 的计算规则。只对右栏接了 DndKit 真正拖拽把手，其余 pane 目前仅有结构性分配能力（仍非全部面板可直接拖动）。右栏在 `ThreePaneLayout` 中保持原一棵 React aside 及 center/PTY/editor 子树，DOM flex 调整停靠位置，兼容历史两向 rail 手柄。
- **复用清单**：直接使用既有 `@dnd-kit/core`、`Divider`（不改源文件）、`dockSideAtPoint`、`dockFlexOrder`、`createCoalescedPaneWriter` 与 `parseSavedPaneLayout`（扩字段），没有重写各自逻辑；新 `paneLayout.ts` 仅新增三向几何与规范化函数。
- **旧新字段关系**：`ui.paneWidths` 只在首帧读作迁移来源，`ui.paneLayout` 是唯一定向写盘入口，通过原 400ms 防抖 + single-flight `createCoalescedPaneWriter`；新键同时保存规范化 placements 与旧宽度镜像，旧 dock 操作更新同一份 PaneLayout 以免生成第二条写路径；设置走原 SettingRepo IPC。损坏新布局读入时使用合法默认布局并向 toastStore 发可见告警（E2/E1 纯解析，尚无 U1 故障注入截图）。
- **基线**：首次调用 `node apps/desktop/scripts/run-smokes.mjs arc005-pane-dock-keys-smoke arc005-pane-docking-smoke arc005-pane-first-paint-smoke arc005-pane-layout-edges-smoke arc005-pane-write-race-smoke arc005-panel-rail-smoke` → **6 PASS / 0 FAIL**；原始日志目录 `apps/desktop/.tmp/smoke-runs/1792538600335-29676-EAC2uZ/`。
- **最终无头 E1**：`node apps/desktop/scripts/run-smokes.mjs arc005-pane-free-grid-smoke arc005-pane-dock-keys-smoke arc005-pane-docking-smoke arc005-pane-first-paint-smoke arc005-pane-layout-edges-smoke arc005-pane-write-race-smoke arc005-panel-rail-smoke arc005-editor-keepalive-smoke arc005-right-pane-keepalive-smoke` → **9 PASS / 0 FAIL**；新套件 **23/23 条断言**（损坏矩阵、合法正控、三向几何、六项物理规则的纯函数/源码接线等），日志 `apps/desktop/.tmp/smoke-runs/1792539986517-36752-ppHoRn/`。
- **变异 E1**：`node .tmp/t02-mutate-verify.cjs`，撤回折叠常量 → **RED 1**；撤回 iframe shield → **RED 2**；撤回 4px 死区 → **RED 1**；破坏正控 `repaired=[]` → **RED 1**；破坏底部落点 → **RED 1**。五次恢复均做 SHA256 与 Buffer 字节级 `cmp`：**BYTE IDENTICAL**，恢复后 smoke **1 PASS / 0 FAIL**，输出 `.tmp/t02-mutation-results.txt`。仅操作自己的新代码并 finally 恢复，未使用 git reset/checkout。
- **类型门禁**：`pnpm typecheck` → **3 tasks successful / 0 failed**（contracts tsc、contracts build、desktop tsc）。
- **真 Electron**：`node apps/desktop/scripts/arc005-visual-baseline/build.mjs` → **39/39 CAPTURED、0 DATA_MISSING**，`.tmp/arc005-visual/{run.log,result.json}`；这是原有全 App 视觉夹具，不含真实拖动后的 **PTY session id** 或 **Monaco model count** 保活断言，不能充当第 4 条通过证明。额外 `node scripts/arc005-visual-baseline/compare.mjs` (cwd `apps/desktop`) → exit 2；**637 一致 / 247 已登记差异 / 13 未登记暗色 --edge 差异**，详 `.tmp/arc005-visual/diff.md`。不将这项额外比较冒充 PASS，也不在 T02 越界调整 theme。
- **未达成/剩余风险**：验收 **第 4 条未达成**（必须在真实 Electron 中拖动并记录 PTY 会话 ID、Monaco 实际模型数不变；目前只做了静态 keepalive + 39/39 视觉场景）；**第 5 条仍缺真实 Electron 损坏布局注入的可见提示/U1 证据**（只有 parser 和源码接线测试）；第 2 条静态 DOM 断言未替代完整的真 Electron 手势实测，实际双击 50/50 仍受旧 store 最大宽度钳制，亦未覆盖所有 PaneId 的真实拖拽分配。不可申报 T02 全量交付、ARC-005 总体完成或全仓 `test:all` 绿。风险证据等级：纯函数/隔离 E1、源码 E2、真 Electron 视觉 U1（非拖拽）。
- **源码提交 SHA**：`8e4867578a97768357dce9d28c9f515b3b74c1c4`（`feat(T02): wire versioned three-way pane docking`）；后续回写记录独立文档提交。
