# T07｜文档 / Node-RED 同壳整合

| 项目 | 值 |
|---|---|
| 编号 | T07 |
| 类型 | ARC-005 + ARC-007 交叉（用户要求「同一个 Shell 的视觉整合」） |
| 优先级 | 中 |
| 建议并发 | **阻塞** —— 等 T02（Pane 模型）与 T05（Docs 能力）完成后再开 |
| 预计规模 | 中 |

---

## 前置条件（不满足就不要开工）

- **T02 已完成**：自由 Pane 模型（`paneLayout.ts`）已落地并能持久化。
  没有它，文档/Node-RED 面板只能挤在现有的单一右栏里，整合会变成又一次特例。
- **T05 已完成**：Docs 的全功能迁移已完成，`docs-vendor-parity-smoke` 全绿。
- **T03 已完成**：Gate D 的 owner 注册表已落盘（Node-RED 面板要显示"这条 flow 归谁"）。

如果这三项里任意一项没完成，**读到这里就停**，在回写区写「阻塞：等待 T0x」，
不要再往下做。

---

## 为什么做这个任务

用户的要求原话是：

> 「原生 GenOffice/Node-RED 在同一个 Shell 的视觉整合」

现状：

- GenOffice Docs 是 `WebContentsView`（独立的原生视图），浮在三栏布局之上，
  有自己的 bounds/focus 管理。
- Node-RED 编辑器是 iframe（在右栏的 flow tab 里）。
- 两者**都不在 Pane 模型里** —— 它们不能被拖动、不能进底部、不能和编辑器并排。

T02 做完之后，Pane 模型有了 `PaneId` 的概念，但 `document` 与 `flow` 还是"特殊面板"。
本任务把它们变成**一等公民**。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `docs/planning/arc007-genoffice-native-integration-map.md`（T05 更新后的版本）。
3. T02 产出的 `apps/desktop/src/renderer/components/layout/paneLayout.ts`。
4. `apps/desktop/src/main/document/documentViewHost.ts` —— **重点**：
   `WebContentsView` 的 bounds 是怎么跟着布局算的。它现在是按"右栏矩形"算的，
   进 Pane 之后要改成按"pane 矩形"算。
5. `CLAUDE.md` 环境事实：「主进程里没有 cookie 的 HTTP 请求做不到」、
   「原生视图 z-order/bounds」。

---

## 执行内容

### 1. Pane 类型扩展

在 T02 的 `PaneLayout` 里增加两种 pane 内容类型（不是新 `PaneId`，是 `PanePlacement`
上的一个 `content` 字段）：

```ts
type PaneContent =
  | { kind: "builtin"; id: "chat" | "files" | "git" | "terminal" }
  | { kind: "document"; documentId: string }
  | { kind: "flow"; flowId: string };
```

### 2. `WebContentsView` 跟随 Pane

- `documentViewHost` 的 bounds 改为从 **pane 的 DOM 矩形**读取，不再是"右栏矩形"。
- 拖拽切换停靠边时，`WebContentsView` 必须跟着移动且**不重建**（内容不丢）。
- 应用窗口 resize、Pane 分割线拖动时同样跟随。
- **焦点**：当用户点在文档上时，焦点应进入 WebContentsView；点回聊天时退出。
  这条已有实现，确认它在 Pane 模型下仍然成立。

### 3. Node-RED iframe 跟随 Pane

- 从"右栏的 flow tab"改成"可以放进任何 pane 的 iframe"。
- **不要**让 iframe 重载（Node-RED 编辑器重载会丢失未部署的改动）。
  这意味着它必须在停靠切换时保持挂载 —— 与 PTY/Monaco 同一条硬约束。

### 4. 视觉整合

- 文档面板与 Node-RED 面板的**边框、圆角、头部**与其它 pane 一致
  （用 T01 已经建立的 token）。
- 文档面板自己的工具栏（GenOffice 原厂 UI）**不强行改皮肤** —— 那是上游的。
  要改的是**外围**：pane 的边框、分隔线、焦点环。
- Node-RED 面板的外围同理。

### 5. 测试

- 真 Electron 探针：把文档 pane 从右拖到左 → `WebContentsView` 的 bounds 跟着变，
  且文档内容没重载（用 `documentViewHost` 的会话 id 或类似判据）。
- Node-RED iframe：拖动后 iframe 的 `contentWindow` 身份不变（证明没重载）。
- 布局恢复：持久化一个带 document/flow 的布局 → 重启 → 恢复且内容正确加载。

---

## 边界（不要碰）

- **不要**改 GenOffice 上游源码（`genoffice/`）。只改外围。
- **不要**改 Node-RED 上游源码。
- **不要**改 T02 已经定型的 `paneLayout.ts` 接口（只允许加字段）。
- 不要改工作流执行逻辑（T03 的领域）。

---

## 验收判据

1. 文档 pane 可以停在 left / right / bottom 三个位置，`WebContentsView` 跟随且不重建。
2. Node-RED iframe 可以停在任意 pane，拖动后不重载。
3. 布局持久化能记住 document/flow pane，重启后正确恢复。
4. 现有 `document-view-*` 四套 + `arc005-pane-*` 六套全绿。
5. 双包 tsc 干净。
6. **变异验证**：撤掉 bounds 跟随 → 拖动断言变红；撤掉 iframe 保活 → 重载断言变红。

---

## 你要在回写区回答的问题

- `WebContentsView` 在 Pane 模型下有没有出现"位置对但裁剪错"的情况？
- Node-RED iframe 拖动时有没有丢未部署改动？（这是最危险的一条）
- 有哪些 GenOffice 原厂 UI 元素与 Mcode 的视觉语言冲突？列出，但**不要**擅自改上游。

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
