# T54｜原厂 sheets/slides 的 Pane 外 IPC 围栏 + T42 报的红项

| 项目 | 值 |
|---|---|
| 编号 | T54 |
| 类型 | **安全 + 回归**（T29/T42 遗留） |
| 优先级 | **高** —— 12 类越出 Pane 的操作没有任何围栏 |
| 建议并发 | 改 `main/document/` + `genoffice/apps/sheets` preload 的 Mcode 侧；**先完成 T53** |
| 预计规模 | 中到大 |

---

## 前置条件（不满足就不要开工）

- **T53 已完成**（它先验功能，本卡再收紧边界；反过来会让 T53 反复改断言）
- **T42 已完成**：`9d390a7e`
- **T29 已提交**：`dc974b2c`

---

## 问题一：12 类越出 Pane 的 IPC（T29 回写提出）

T29 的回写区原文：

> 原厂声称的 155 条未完成逐条枚举核算。已静态发现**至少 12 类/处**含 Pane 外
> 副作用或入口：打开/另存文件对话框、字体本机安装、插入图片/媒体文件对话框、
> 导出目录/PDF 文件选择、图片保存、打印、PDF 导出新 BrowserWindow、全屏、
> 系统 shell 打开外链、屏幕采集/录制等。它们的 sender/路径围栏应另经原厂 IPC
> 独立安全验收；这次**不声称 155 条已安全迁移**。

**这意味着**：用户在 sheets/slides 里点「另存为」，会弹出原厂的文件对话框，
**绕过 Mcode 的工作区围栏**。

### 要做的

**不是**把所有 12 类都堵死 —— 那会让 sheets/slides 变成残废。

**要做的是分三类**：

| 类别 | 例子 | 处理 |
|---|---|---|
| **A. 必须围栏** | 打开/另存文件、导出目录、图片保存 | 路径必须过 `findContainingWorkspaceRoot` |
| **B. 必须拦截** | 屏幕采集/录制、字体本机安装 | 明确拒绝并告知原因 |
| **C. 可以放行** | 打印、全屏、系统 shell 打开外链（限 http/https） | 保留，但记录 |

**判据是「能不能写到工作区外面」和「会不会采集屏幕」**，不是「跟原厂功能一一对应」。

### 实现方式

原厂这些 IPC 的 handler 在 `genoffice/apps/sheets/src/main/sheets-main.ts` 与
`slides-main.ts` 里。Mcode 不能改上游（除了已有的 patches）。

**两条路**：

- **A（推荐）：在 preload 层拦截**
  Mcode 已经有自己的 `documentViewPreload.ts`。原厂视图用的是原厂 preload
  （T28 的做法）。所以要在**原厂 preload 与本进程之间**加一层。

  T28 的 `patches/genoffice/0010-*` 已经给 pdf/markdown/html 做了 AI 桥的
  scoped 注入。本卡照同样的模式，给 sheets/slides 做一个 **path-scoped preload**。

- **B：主进程层拦截**
  原厂 `registerSheetsIpc()` 注册的 handler 在主进程。Mcode 在
  `genofficeViewFactories.ts` 装配时，可以在调用 `configureSheetsRuntime` **之前**
  包一层。

  **但 `registerSheetsIpc()` 内部直接调 `ipcMain.handle`，没有注入点。**

**所以走 A。** 这符合 T28 已建立的模式。

---

## 问题二：T42 报的红项

T42 回写原文：

> **现存独立红项**：`node-red-e2e-smoke` 105/106，仅 T47 编辑器主页注入
> CSS 链接断言失败（实际主题 CSS 响应 200）；`packages/contracts` tsc 通过；
> `apps/desktop` 全包 tsc 被 `scripts/document-view-renderer-smoke/main.ts:564`
> 非 T42 的 `slidesNative` 类型错误阻断。

两条：

### 2a. `node-red-e2e-smoke` 105/106

断言期望「编辑器主页注入了 CSS 链接」，但实际主题 CSS **响应 200**（说明链接在，只是断言方式不对）。

**先判断谁对**：
- 主题真的注入了吗？（`curl` 一下引擎的 `GET /`，看 HTML 里有没有 `<link>`）
- 如果注入了 → 断言过期，修断言
- 如果没注入 → T47 的改动没生效，修 T47

### 2b. `document-view-renderer-smoke/main.ts:564` 的 `slidesNative` 类型错误

这是 T29 引入的。**一行类型问题**，顺手修掉。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `tasks/T29-genoffice-sheets-slides.md` 的回写区 —— 12 类清单的原文。
3. `patches/genoffice/0010-feat-pdf-markdown-html-scoped-mcode-ai.patch` ——
   **本卡要照抄的模式**（path-scoped preload）。
4. `genoffice/apps/sheets/src/preload/index.ts`（66 条 IPC）与
   `genoffice/apps/slides/src/preload/index.ts`（155 条）。
5. `genoffice/apps/sheets/src/main/sheets-main.ts` 与
   `slides-main.ts` —— 找出那 12 类的 handler。
6. `apps/desktop/src/main/document/genofficeViewFactories.ts` —— 怎么装配。
7. `apps/desktop/src/main/lib/pathGuard.ts` 的 `findContainingWorkspaceRoot`。
8. `apps/desktop/scripts/node-red-e2e-smoke/` —— 105/106 的那条断言在哪。

---

## 执行内容

### 第 1 步：静态列出 12 类，逐条定性

对着 `sheets-main.ts` 与 `slides-main.ts` 的 `ipcMain.handle/on`，
把 T29 提到的 12 类找出来，每条标注：

```
| # | channel | 原厂 handler 位置 | 会做什么 | 类别(A/B/C) | 依据 |
```

**这一步的产出是回写区的一张表，不是代码。**

### 第 2 步：A 类加围栏

照 `patches/genoffice/0010-*` 的模式：

- 在 `genoffice/apps/sheets/src/main/mcode-sheets-scoped.ts`（新文件）里
  包一层 handler
- 路径参数必须过 Mcode 的围栏
- sender 必须从 `DocumentViewHost` 反查（T28 的做法）

**产出 `patches/genoffice/0011-*`。**

### 第 3 步：B 类明确拒绝

屏幕采集/录制、字体本机安装 —— 这些在 Mcode 里没有对应能力，
明确拒绝并返回可读原因（不要让用户以为「点了没反应」）。

### 第 4 步：修 T42 报的两条红

- `node-red-e2e-smoke` 105/106
- `document-view-renderer-smoke/main.ts:564` 的类型错误

---

## 边界（不要碰）

- **不改 `genoffice/` 上游的核心逻辑**，只加 scoped 包装层（与 patch 0001–0010 同一模式）。
- 不改 T47 的主题代码（只修它的断言）。
- 不改 T42 的节点包。
- 不改 `documentViewHost.ts` 的既有语义。
- 不改 `components/settings/`。

---

## 验收判据

1. 12 类（或实测的更多）逐条定性，写成表，每类都有 A/B/C 判定与依据。
2. A 类每条都有围栏断言：工作区内放行、工作区外拒绝（各一条）。
3. B 类每条都有拒绝断言 + 可读原因。
4. C 类在回写区说明为什么可以放行。
5. `node-red-e2e-smoke` 106/106。
6. `document-view-renderer-smoke` 的类型错误消失，套件全绿。
7. 现有 `genoffice-native-view-smoke` / `document-view-*` / `arc005-pane-*` 全绿。
8. 三包 tsc 干净。
9. **变异验证**：撤掉 A 类的围栏 → 越界断言红；撤掉 B 类的拒绝 → 采集断言红。

---

## 回写区要回答

- 12 类里实际有几类？T29 说的「至少 12」准不准？
- 有没有 A 类操作**不走 IPC**、而是走别的路（比如渲染端直接调）？
- 屏幕采集那条，原厂怎么实现的？Mcode 能不能换成自己的能力（比如工件的裁剪截图）？
- `node-red-e2e-smoke` 那条断言，是断言错了还是 T47 没生效？
- 加了 scoped preload 之后，sheets/slides 的性能有影响吗？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
