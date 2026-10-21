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

- **T02 + T23 已完成**：自由 Pane 模型（`paneLayout.ts`）已落地、能持久化、能拖比例、有预设。
  证据：`8e486757` / `12dfd270` / `161583a1` / `ed2e3b02` + T23 回写区；
  7 套 `arc005-pane-*-smoke` 全绿。
- **T05a / T05b / T05c + T22 已完成**：Docs 的全功能迁移。
  证据：`apps/desktop/scripts/document-view-host-smoke` /
  `document-view-open-smoke` / `document-view-electron-smoke` /
  `document-view-vendor-page-smoke` / `document-view-renderer-smoke` **五套**全绿
  （T22 回写区记录 5/5 通过）；T22 的 `mutate-t22.mjs` 与 T05b 的 `mutate-t05b.mjs`
  两个变异脚本可用。

  > ⚠️ **不存在 `docs-vendor-parity-smoke`，也不要去找它。** 那是写 T05 卡时凭空
  > 提出的套件名，T05 实际拆成 T05a/b/c 后用的是上面五套 `document-view-*`。
  > T07 早期版本把它写成硬前置，导致一轮执行对话误判阻塞——已修正。

- **T03 + T10 已完成**：Gate D 的 owner 注册表已落盘
  （证据：`14880ae` 原派活 + T10 增量；Node-RED 面板要显示"这条 flow 归谁"）。

如果这三项里任意一项没完成，**读到这里就停**，在回写区写「阻塞：等待 T0x」，
不要再往下做。

> **本文件路径**：`tasks/T07-doc-nodered-shell-integration.md`。
> 派发时请给完整文件名，`tasks/T07` 这类简写会 ENOENT。

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
4. 现有 `document-view-*` **五套** + `arc005-pane-*` **七套**全绿。
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

### 2026-10-21｜前置条件未满足，按 T07 第 13–21 行停工

- **阻塞：等待 T05**。`tasks/README.md` 标注原 T05 已拆成 T05a/T05b/T05c，三张切片虽标完成，但原 T05 的结果回写区为空；T07 要求的 `apps/desktop/scripts/docs-vendor-parity-smoke/` 不存在，无法证明「T05 全功能迁移已完成，docs-vendor-parity-smoke 全绿」。此硬前置条件尚未满足，依照 T07 明文要求不进入实现。
- **任务路径提示**：本次派发的是 `tasks/T07`，实际文件为 `tasks/T07-doc-nodered-shell-integration.md`；直接读取简写路径返回 ENOENT。依据 `tasks/README.md` 和 `_PROMPT_TEMPLATE.md`，任务路径应使用磁盘上的完整文件名。本次仅在实际 T07 文件记录阻塞事实。
- T02 有 `8e4867578a97768357dce9d28c9f515b3b74c1c4` 实现记录，索引标完成；T03 有 `14880aeff0aba3067c8d5735d2cf5ee69d3386cf` 原派活完成记录，owner 落盘增量 T10 索引标完成。未将这些已有记录当作本轮复测。
- **本轮操作**：只读 T07、T02、T03、T05、`tasks/README.md`、`tasks/_PROMPT_TEMPLATE.md`、`audit-ledgers/README.md`，核对 `git status --short`、提交记录及缺失的 `docs-vendor-parity-smoke` 目录。仅追加本任务文件，不修改业务/测试源码、GenOffice/Node-RED 上游或其他任务文件，不 push。
- **验收判据 1–6：均未执行，全部不能声明达成**；无 Electron 探针、无 smoke PASS/FAIL 结果、无双包 tsc、无变异红/绿与 cmp 数据（前置阻塞，未开工）。剩余风险是 T05 原验收证据缺失；解除硬前置后才能启动 T07 的验证。
- **阻塞记录提交 SHA**：`5e1c2e9e639188dda657a70f5b3969a2f442efb6`（仅任务回写；未提交任何业务/测试实现）。
