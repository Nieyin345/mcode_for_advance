# T21｜顶栏与附件磁贴（第四批逆向件）

| 项目 | 值 |
|---|---|
| 编号 | T21 |
| 类型 | ARC-005 UI（复用 `open-claude-ui`） |
| 优先级 | 中 |
| 建议并发 | 只改渲染端，可与 T05c / T19 / T20 并行 |
| 预计规模 | 中 |

---

## 两个件

| 件 | 行数 | 现状差距 |
|---|---|---|
| **`ClaudeDesktopHeader.tsx`** | 98 | Mcode 的 `Titlebar.tsx` 有 481 行，但**没有 macOS 红绿灯物理避让**与缩放补偿 |
| **`AttachmentCard.tsx`** | 185 | Mcode 的附件显示是简单 chip，**没有磁贴形态、中间截断、类别徽章** |

---

## 第 1 件：顶栏的 macOS 深度融合

### 逆向件的四条规则

1. **74px 红绿灯物理避让槽**（macOS 左上角三个按钮占位）
2. **逆缩放补偿**：`Math.round(74 / Math.min(zoomFactor, 1))` —— 用户放大时避让槽反而要缩小
3. **全屏感知**：macOS 全屏时红绿灯消失，避让槽要回缩
4. **45px 全局拖拽带** + `.draggable-none` 交互隔离

### 现状

读 `Titlebar.tsx:126` 会发现 Mcode **已经有** `isMac && !(leftOpen && !isSettings) && "pl-[78px]"`——
用了 78px 硬编码，没有缩放补偿，没有全屏感知。

### 要做

- 把 78px 换成 74px + 逆缩放补偿
- 加全屏感知（`document.fullscreenElement` 或 Electron 的 `isFullScreen`）
- 确认拖拽带高度（Mcode 现在是多少？对照逆向件的 45px）
- **只在 macOS 上生效**，Windows/Linux 不受影响

⚠️ **本机是 Windows**，macOS 分支无法真机验证。要在回写区明确写「macOS 未实测」，
并用源码断言覆盖逻辑分支。

---

## 第 2 件：附件磁贴

### 逆向件的六条规则

1. **7.5rem 正方形磁贴**（`calc(7.5rem * scale)`）
2. **同心圆角**（`--radius-card`）
3. **双层阴影**
4. **文件名中间截断**（保留头 + 扩展名，中间省略号）
5. **浮动移除按钮**（`-end-2 -top-2 size-5 rounded-full`）
6. **类别大写徽章**（TS / PY / PDF / CSV）

### 现状

Mcode 在 `ChatPane.tsx` 里有 `tags` / `pendingImages` 的 chip 显示，
以及 `ContentTagChip.tsx`。它们是**横条 chip**，不是磁贴。

### 要做

- 新增磁贴形态用于**图片与文件附件**（聊天里的非文本附件）
- 照抄中间截断算法（这是个真有用的细节：长文件名不丢扩展名）
- 类别徽章按扩展名映射
- **保留现有 chip**（文本 tag 用 chip，文件/图片用磁贴，两者并存）

---

## 开工前必读

1. 两个逆向件**全文**。
2. `apps/desktop/src/renderer/components/layout/Titlebar.tsx` **全文**（481 行）——
   现有顶栏，看它已处理了什么。
3. `apps/desktop/src/renderer/components/chat/ChatPane.tsx` 的附件段（搜 `tags` /
   `pendingImages`）。
4. `apps/desktop/src/renderer/components/chat/ContentTagChip.tsx`。
5. `apps/desktop/src/renderer/components/ui/` —— 已有 `Badge` 等原语，能用就别新写。

---

## 边界（不要碰）

- 只改渲染端。
- 不改 `ThreePaneLayout.tsx`（T02 刚落地）。
- 不改 `ComposerEditor.tsx`（T18 刚改）。
- 不引入 framer-motion。
- 不改主进程。

---

## 验收判据

1. **第 1 件**：macOS 避让槽按 `74 / min(zoom, 1)` 计算（有源码/行为断言）。
2. **第 1 件**：全屏时回缩（有断言，macOS 分支用条件模拟）。
3. **第 1 件**：Windows/Linux 完全不受影响（有断言）。
4. **第 2 件**：中间截断算法有单测（长文件名保留扩展名）。
5. **第 2 件**：磁贴与既有 chip 并存，不丢现有功能。
6. 现有 `workspace-shell-smoke`、`ui-interaction-smoke`、`leftbar-render-smoke` 全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉逆缩放补偿 → 断言红；撤掉中间截断 → 断言红。

---

## 回写区要回答

- Mcode 顶栏原来的 78px 是哪来的？改成 74px + 补偿后差异多大？
- macOS 分支怎么验证的？（本机是 Windows）
- 磁贴与 chip 的分工是什么？什么时候用哪个？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
