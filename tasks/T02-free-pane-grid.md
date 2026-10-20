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
