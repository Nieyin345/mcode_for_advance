# T17｜把还没用的逆向件接进 UI（第二批）

| 项目 | 值 |
|---|---|
| 编号 | T17 |
| 类型 | ARC-005 UI（复用 `open-claude-ui` 的逆向成果） |
| 优先级 | 高 —— 这是「UI 做成 Claude 桌面端效果」的直接落点 |
| 建议并发 | 只改渲染端，可与 T05a 并行 |
| 预计规模 | 中大 |

---

## 目标

`open-claude-ui/code-examples/` 里还有 **6 个逆向件没接进来**。这批就是把它们接上。

**原则**：照抄它的物理规则与几何常量，只把颜色/文案换成 Mcode 的 token 与 i18n。
**不要重新设计，不要"改进"，不要引入 framer-motion**（仓库没有，且这些都能用
CSS 或已有依赖实现）。

---

## 六个件，按价值排序

| # | 逆向件 | 接到哪 | 它能带来什么 |
|---|---|---|---|
| 1 | **`DraggableSessionList.tsx`** | 左栏会话列表（`LeftBarParts` / `StreamSidebar`） | 会话拖拽排序、置顶区与未置顶区互拖、4px 死区、拖拽幽灵（-1.5° 倾斜 + 模糊 + 发丝阴影）、落点导轨、`Alt+Up/Down` 键盘重排 |
| 2 | **`StreamingDiffViewer.tsx`** | `chat/DiffView.tsx` + `ide/GitDiffDialog` | 流式高亮（代码边生成边高亮）、行内 diff 的更细粒度渲染 |
| 3 | **`ModelSwitcherWithTokenGauge.tsx`** | `chat/ModelDropdown.tsx` | 模型矩阵选择 + **Token 上下文仪表盘**（当前用量/上限的可视化） |
| 4 | **`ReasoningAmbientGlow.tsx`** | 思考态（`MessageBlocks.ThinkingAccordion`） | 推理进行中的环境光效 |
| 5 | **`McpToolDecisionCard.tsx`** | `MessageBlocks` 里 MCP 工具调用卡 | 交互式工具调用与 MCP 决策卡片 |
| 6 | **`ContainerResponsiveBar.tsx`** | Composer 底部工具条 | 4 阶流体压缩（576/480/384/320px） |

**每接一个单独提交**，不要憋一个大的。

---

## 开工前必读

1. `open-claude-ui/AGENTS.md` —— 设计令牌、4 个弹簧预设、输入法守卫、
   150ms 滚动钉住冷却、iframe 沙箱规则。
2. 你要接的那个逆向件**全文**。
3. **Mcode 已有的对应实现**（下表的「接到哪」列）—— 先读懂它现在的行为，
   确认替换后**不会丢功能**。
4. `apps/desktop/src/renderer/styles.css` 的 token 段 —— 逆向件里写死的
   `--cds-*` 要映射到 Mcode 的语义 token。
5. `CLAUDE.md` 硬规矩第 7 条 —— 新代码读数据走 `useRpc`；空状态/错误/加载
   用 `components/ui/` 的现成件。

---

## 每个件的接法（统一套路）

### 第 1 步：映射 token

逆向件用的是 `--cds-surface-0` / `--cds-text-primary` / `--cds-clay` 这些名字。
Mcode 有对应语义层：

| 逆向 | Mcode |
|---|---|
| `--cds-surface-0/1/2` | `--surface` / `--surface-muted` / `--surface-hover` |
| `--cds-text-primary/secondary` | `--content` / `--content-muted` |
| `--cds-border` | `--edge` |
| `--cds-clay` | `--accent`（**只在运行中/需要注意时用**） |

### 第 2 步：抄物理规则，不抄依赖

- `framer-motion` → 用 CSS `transition` / `@keyframes`；弹簧用 `linear()` 采样
  （Mcode 的 `--ease-*` 词表已有）。
- `react-icons` → 仓库有 `@tabler/icons-react` + `react-icons`。
- 任何 `lucide-react` 之类没装的 → 换等价图标，**不要为它加依赖**。

### 第 3 步：接上真实数据

逆向件是**静态演示**（写死的会话、写死的消息）。接通时要：
- 用真实 store 数据；
- 用 `useRpc` 读后端；
- 用 i18n 的 key，不硬编码文案。

### 第 4 步：保住现有行为

替换前先跑一遍相关 smoke，记下当前断言。替换后**那些断言必须仍然绿**。
如果某个现有行为逆向件没有，**保留它**，不要因为"照抄"而丢功能。

---

## 边界（不要碰）

- **只改渲染端**（`apps/desktop/src/renderer/**`）。
- 不改主进程、contracts、document、modules、workflowEngines。
- **不加新依赖**（`@dnd-kit`、`@tabler/icons-react`、`framer-motion` 都不加；
  最后一个仓库本来就没有，也不许为它加）。
- 不改 `open-claude-ui/`（只读参考）。
- 不动 T02 刚落地的 `paneLayout.ts` / `ThreePaneLayout.tsx`。

---

## 验收判据

1. 六个件**逐个**接入，每个单独提交，提交信息写清「抄了哪些物理规则」。
2. 每个件都有一条**行为断言**（不是"源码里有没有这个字符串"），
   例如拖拽后顺序真的变了、Token 仪表盘的百分比与 store 一致。
3. **现有相关 smoke 全绿**（尤其是左栏、Diff、模型选择、思考块对应的那些）。
4. 双包 tsc 干净。
5. **变异验证**：每个件至少一条——撤掉它的核心行为，断言必红。
6. 如果某个件接进来会**丢现有功能**，该件跳过并在回写区说明，
   不要为了凑数硬接。

---

## 回写区要回答

- 六个件各接了没有？没接的为什么？
- 每个件抄了哪些物理规则？哪条改了、为什么？
- 有没有哪个件抄进来之后发现和 Mcode 现有设计冲突？
- 有没有为了接它而丢掉的现有行为？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
