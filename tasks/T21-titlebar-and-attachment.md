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

### 2026-10-21｜T21 执行回写（开发自验，E1/E2）

- **代码提交 SHA**：`bd7edb7cc24f37352e0fa8261978e7d5116ae79d`，未推送。基于在飞共享工作树，仅 stage 自己的 7 个文件，其它对话未提交改动未触碰。
- **复用层级**：L2 上游薄适配。`open-claude-ui/code-examples/ClaudeDesktopHeader.tsx`（74px/缩放/全屏/45px 拖拽带）和 `AttachmentCard.tsx`（7.5rem/同心圆角/双层阴影/智能截断/类别徽章/浮动删除）已全文阅读；无新 UI 框架，无主进程/IPC 修改。
- **改动文件**：`apps/desktop/src/renderer/components/layout/Titlebar.tsx`、`apps/desktop/src/renderer/components/layout/trafficLights.ts`、`apps/desktop/src/renderer/components/chat/AttachmentTile.tsx`、`apps/desktop/src/renderer/components/chat/ChatPane.tsx`、`apps/desktop/src/renderer/lib/contentTag.ts`、`apps/desktop/scripts/t21-smoke/main.tsx`、`apps/desktop/scripts/t21-smoke/run.sh`。
- **顶栏细节**：旧 `pl-[78px]` 是旧 Mcode 顶栏自身的固定避让值，左栏另外以 `pl-[70px]` 使操作按钮起点约 x78、绕开交通灯终点约 x72；非上游公式。新 `Math.round(74 / Math.min(zoom, 1))` 在 zoom=1 时为 74px（比旧少 4px），zoom=0.8 时为 93px（比旧多 15px），zoom=0.5 时为 148px；zoom=1.25 时仍 74px。macOS 沿用有侧栏时侧栏自身承接避让槽的规则；无侧栏/设置使用顶栏避让槽，DOM 全屏时为 0。仅 macOS 顶栏从 40px 增为 45px 拖拽带，保留全部交互按钮的 `no-drag`；Windows/Linux 仍 40px、右侧 138px 避让逻辑不变。
- **macOS 验证方法**：Windows 主机无法运行真 macOS 环境，**macOS 未实测**。在隔离 smoke 直接注入 mac/windows/linux、fullscreen=true/false、zoom=0.5/0.8/1/1.25、sidebarOwns=true/false，断言所有分支，并用源码断言确保 Titlebar 调用了共享公式、监听 DOM `fullscreenchange` 与 `resize`。渲染端不具备现成 Electron native `isFullScreen/getZoomFactor` IPC，本片依据允许的 `document.fullscreenElement` + display-mode 媒体查询检测全屏；zoom 改变根据初始 devicePixelRatio 和 visualViewport scale 推断。
- **附件与 chip 分工**：拖入项目文件引用（`kind=file`）与待发送图片（`pendingImages`）展示 7.5rem 磁贴；`paste` / `quote` / `element` / `library` 保留 `ContentTagChip`，原有 popover/移除/编辑/发送映射原样保留。为保留外部路径临时文件对应的**原始文件名和扩展名**，ContentTag 可选新增 `fileName`，不改变 prompt 的 `@path` 内容、发送结构或文件权限。
- **测试**：`node apps/desktop/scripts/run-smokes.mjs t21-smoke workspace-shell-smoke ui-interaction-smoke leftbar-render-smoke` → **4 pass / 0 fail**，T21 自有细项 **36/36 PASS**，日志：`apps/desktop/.tmp/smoke-runs/1792551259965-34708-eirRQa/`（`t21-smoke.log` 含所有断言）。`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json && pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` → **双包 0 errors**。`git diff --cached --check` → clean。
- **变异验证（E1）**：先将 `trafficLights.ts` 的 `Math.round(74 / Math.min(zoom, 1))` 改为恒定 `74` → `t21-smoke` **34/36 PASS、2 FAIL**（`apps/desktop/.tmp/smoke-runs/1792551198507-31492-OsOP8L/`）；将 `AttachmentTile.tsx` 的 `const ext = fileName.slice(dotIndex)` 改为 `const ext = ""` → **33/36 PASS、3 FAIL**（`apps/desktop/.tmp/smoke-runs/1792551218234-26236-VAESNA/`）。两次都用原件 copy 还原，`fc /b` 显示**找不到差异（逐字节一致）**；恢复时 git blob SHA 分别是 `8205b8a73f9161cf2081362b3bcfbf9a626d0125` 与 `7813e74e4aecf0a161de5cd4a134165025a0eeb9`，再跑全套得 4/4 绿。
- **未做/未验**：受用户禁止改主进程的边界约束，没有新增 Electron 原生 fullscreen/zoom IPC；没有真 macOS U1、人手切系统原生全屏、窗口预设缩放/跨显示器 DPR 的实机证据。没有运行全量 `test:all`（该任务仅指定 3 套既有回归 + 自有 suite），没有宣称整个 ARC-005 已验收。
- **剩余风险**：`document.fullscreenElement` 和 `(display-mode: fullscreen)` 不一定覆盖 Electron 原生 macOS 全屏，初始 DPR 比值也不等于原生 `webContents.getZoomFactor()` 的绝对值；需要下一轮允许宿主接线时单独补真机证据。本任务的 8 条**源码/模拟/指定 smoke/tsc/变异**验收判据均达成；上面的未实测限制不得解读为 U1 验收。
