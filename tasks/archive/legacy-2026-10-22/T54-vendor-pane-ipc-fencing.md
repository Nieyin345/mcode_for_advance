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

**注意**：T24 的回写区也独立报告了同一条（它判据 4 就是被这一行阻断的）。
两个任务独立撞到同一个错误，说明它是**当前唯一的 tsc 阻断**，
优先级比 T54 卡里其它内容都高 —— **先修它**，否则所有任务的「双包 tsc 干净」
判据都过不了。

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

### 2026-10-21｜T54 实施与验收回写（E2 静态调用链 + E1 隔离动态）

**源码锚点**：GenOffice 集成分支 `mcode/integration`，vendor SHA `aba076cc9b292461cc419288ee555e524f6250e1`；根仓库 `patches/genoffice/0011-security-sheets-slides-scoped-ipc.patch` 为对应 `format-patch -1`。Mcode 主进程从 `documentViewHost.docIdForSender` / `editorOf` 验证发起方，路径使用原有 `findContainingWorkspaceRoot`（含物理路径/工作树/文献库边界），**拒绝来自非本宿主的 webContents**。仅 Mcode 作为宿主时启用，原厂单独运行没有此围栏。

#### 1. 静态核实：T29 所称“至少 12 类”成立；按实际副作用拆为 26 组

下表“主文件”对应 `genoffice/apps/sheets/src/main/sheets-main.ts`（S）和 `genoffice/apps/slides/src/main/slides-main.ts`（P）；局部行号以本次 vendor SHA 为准。独立 IPC / 浏览器权限入口合并统计的是 **26 组风险或可接受副作用**，并非声称完成原厂 155 条全部 IPC 的枚举；其中明确列出 6 组 B/C 和多个附加路径入口。无论是渲染端传入的路径，还是原生对话框返回的路径，均须在读/写前验。

| # | channel／入口 | 原厂 handler／位置 | 实际副作用 | A/B/C | 判定依据与措施 |
|---|---|---|---|---|---|
| 1 | `workbook:select`, `workbook:select-for-merge` | S:2882, 2971 | 原生对话框读取 XLSX/CSV | A | 选择结果逐路径围栏 |
| 2 | `workbook:reopen`, `workbook:open-for-merge` | S:2894, 2981 | 按外部参数读任意文件 | A | 传入路径／数组逐项围栏 |
| 3 | `workbook:save` | S:3363 | 保存或另存到文件，含显式 `targetPath` | A | 显式目标围栏＋对话框结果围栏；原厂会话仍持有 CAS |
| 4 | `workbook:export-csv` | S:3246 | 写 CSV；可不经对话框传 `targetPath` | A | 显式目标及选择结果双检查 |
| 5 | `workbook:export-pdf` | S:3222；`sheets/src/main/pdf-export.ts` | 隐形 PDF 打印窗，导出 PDF 文件 | A | `outPath` 与保存对话框结果验；PDF 模块共享 AsyncLocalStorage 范围 |
| 6 | `workbook:create-document` | S:3305 附近 | 无对话框自动生成 CSV/XLSX | A | Mcode 模式使用已授权文档所在工作区目录，拒绝无持有者路径 |
| 7 | `shell:read-local-image` | S:3116 | 读取本地图片，原厂还支持 `~/` | A | 仅接受工作区内绝对路径；无法解析的 home 简写 fail-closed |
| 8 | `sheets:files-pick`, `sheets:files-add`, `sheets:files-read-image` | S:3687, 3701, 3741 | 图片／附件本地读取 | A | 原生对话框返回与显式路径均验 |
| 9 | `sheets:capture-screen-sources` | S:3134 | `desktopCapturer.getSources` 列举所有显示器及窗口缩略图 | B | 用户未提供专门屏幕采集审批，明确抛可读原因 |
| 10 | `sheets:capture-screen-source` | S:3170 | `desktopCapturer` 采集全尺寸屏幕/窗口 | B | 明确拒绝，不能只隐藏按钮 |
| 11 | `workbook:print`, `workbook:list-printers` | S:3230, 3235 | 系统打印及打印机查询 | C | 用户主动打印，非写任意文件；记录审计 |
| 12 | `shell:open-external` | S:3676 | 系统浏览器打开外链 | C | 仅允许 URL 为 HTTP/HTTPS，审计；禁止 `file:` 等 |
| 13 | `slides:open`, `slides:open-path` | P:1453, 1467 | 本地 PPTX/ODP 文件读取／转换 | A | 选择、显式参数及转换另存结果验 |
| 14 | `slides:save`, `slides:save-as` | P:4583, 4622 | PPTX 保存、原生另存；无路径时创建草稿 | A | 原厂会话对应 Mcode 授权初始文档；草稿改落该工作区而非原厂全局草稿目录 |
| 15 | `slides:edit-background`, `slides:edit-image-fill` | P:2412, 2501 | 文件对话框读图片并写入 PPTX 内容 | A | 对话框结果围栏，原业务逻辑不改 |
| 16 | `slides:pick-picture-file`, `slides:insert-image` | P:2558, 2576 | 本地图片读入 | A | 对话框返回路径围栏 |
| 17 | `slides:insert-media`, `slides:insert-model3d` | P:3940, 4041 | 文件对话框读取视频、音频、GLB | A | 所选路径围栏 |
| 18 | `slides:add-media-bytes`（附带 `path` 分支） | P:4017 附近 | 由渲染端提供磁盘路径直接 `readFile(op.path)` | A | 额外补入显式路径围栏，base64 纯字节仍允许 |
| 19 | `slides:pick-export-dir`, `slides:export-images` | P:4654, 4665 附近 | 选目录后批量写 PNG | A | 目录和每张 `join(dir, baseName-序号.png)` 目标都检查，防 `../` 文件名穿越 |
| 20 | `slides:pick-export-pdf-path`, `slides:export-pdf` | P:4684, 4714 | 保存 PDF，原厂内部建隐藏 BrowserWindow | A | 路径围栏后允许隐藏打印窗；不视作独立屏幕采集 |
| 21 | `slides:save-picture` | P:4690 附近 | 原生对话框选择后写 PNG | A | 所选目标围栏 |
| 22 | `slides:font-install-local`, `slides:font-download` | P:1413, 1404 | 本机安装/缓存字体、修改字体环境 | B | 不提供 Mcode 字体安装审批；本机安装及下载均显式拒绝 |
| 23 | `navigator.mediaDevices.getDisplayMedia`／`setDisplayMediaRequestHandler` | P:1350 附近 | 屏幕录制**不是靠 invoke IPC**，原厂直接用 Chromium 设备请求 | B | Mcode 模式的原厂 display-media 回调只返回 `{}`，不触发 `desktopCapturer`；录制授权不可借原厂回退 |
| 24 | `slides:save-recording`, `slides:microphone-access` | P:4247, 4280 | 记录音轨/提取麦克风权限 | B | 当前 Mcode 无录音审批端口，IPC 一律返回可读拒绝 |
| 25 | `slides:print`, `slides:show-fullscreen` | P:4729, 4791 | 显示打印对话框／调整宿主全屏 | C | 非路径写入/桌面采集，保留并按调用审计 |
| 26 | `trackSlidesWebContents.setWindowOpenHandler` | P:420–435 | 原厂外链交系统浏览器 | C | 仅 HTTP(S)，Mcode 模式打印审计日志 |

#### 2. 边界、验证与剩余事实

- **A 类实际做法**：将原厂的 `ipcMain.handle/on` 和 `dialog.showOpenDialog/showSaveDialog` 用同一份 scoped handler/文件对话框代理包装，IPC 先验宿主 sender；`AsyncLocalStorage` 把已验证身份随异步对话框延续到**选完路径之后**，原厂业务在返回前得不到越界路径。不依赖 renderer/preload 自报的 docId、项目根或 `sessionId`。路径型 channel 同时检查直接输入。原厂独立运行不注入 guard，保持兼容。
- **B 类**：sheets 两条桌面采集、slides 字体本地安装/下载、录制/麦克风访问明确拒绝并携带 `Mcode 安全限制` 原因；slides 的非 IPC `getDisplayMedia` 通路额外 fail-closed。未来如要替换为 Mcode 工件裁剪截图，必须接已有受控授权 API，本卡**未伪装成已经实现**。其余 renderer 直接用媒体设备的权限路径并未做真 Electron 独立审计。
- **C 类**：打印、查询打印机、全屏不向任意用户文件写盘也不枚举屏幕；Shell 外链只准 HTTP(S)，都可记审计。注意 PDF 导出内部隐藏 BrowserWindow **本质是 A 类写文件**，不因“窗口”二字误归 C。
- **非 IPC A 类检查**：原厂 `installDropOpenBridge` 通过 `webUtils.getPathForFile` 收拖拽路径并以 `DROP_OPEN_CHANNEL` 发异步消息（`genoffice/packages/electron-utils/src/drop-open.ts:112`），不是本次枚举的 `slides:` / `workbook:` invoke；在 Mcode 内不把该 bridge 当授权器，Mcode 的初始 `createNativeView` 路径仍由 `DocumentViewHost` 先围栏。不能因此声称 GenOffice 全部 IPC 已审计。
- **T42 两条红**：原 T47 主题 CSS 链接并非未注入，当前测试已对 HTML 实体解码并在 `GET /` 的 `link[rel=stylesheet]` 里检查，真实主题 CSS 返回 200；`node-red-e2e-smoke` **106/106**，包含生产 vendor runtime/editor PASS。先前真正阻断本轮重跑的是 `sherpa-onnx-node` 原生 `.node` 被 esbuild 尝试静态打包，`run.sh` 为无头 smoke 添加了 `--external:sherpa-onnx-node`，没有改 T47 主题实现。原 `slidesNative` 一行类型红由早先提交 `e3782d47` 解决，`document-view-renderer-smoke` 本轮 PASS。
- **测试证据（E1）**：`node apps/desktop/scripts/run-smokes.mjs genoffice-pane-fence-smoke` → **109/109**（包含显式路径与对话框内/外、假 sender、无对话框授权生成目标、B 拒绝、C 放行），日志 `apps/desktop/.tmp/smoke-runs/1792576082059-24596-Lab8Gt/genoffice-pane-fence-smoke.log`。`mutation-check.mjs` 使用 esbuild 对**临时源码拷贝**取消 A 路径拒绝或取消 B 禁止，分别观察到命中的越界/采集红例，正源 SHA256 未变；每次 run.sh 都自动执行。`node-red-e2e-smoke` **106/106**，日志 `apps/desktop/.tmp/smoke-runs/1792574902771-33408-QuNgbS`；`genoffice-native-view-smoke` / 5 套 `document-view-*` / 7 套 `arc005-pane-*` + 新套件，共 **14/14 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792576082059-24596-Lab8Gt`。均隔离动态、没有访问生产文档。
- **性能**：每条相关 IPC 增一次 sender 查询，仅 A 路径操作多一次物理归属检查，异步 picker 靠 `AsyncLocalStorage` 绑定；**没有真 Electron 的帧率/打开延迟 benchmark**，不把无头绿灯当成 U1 性能结果。
- **类型检查**：`pnpm exec tsc --noEmit -p genoffice/apps/sheets/tsconfig.json`、`genoffice/apps/slides/tsconfig.json`、`packages/contracts/tsconfig.json`、`apps/desktop/tsconfig.json` **四包最终均 PASS**。期间桌面检查曾短暂受他人 T58 并发工作树 `WorkflowLibraryView.tsx:407,678` 类型红阻断，随后它自行修复；本任务未跨范围修改，提交前重跑全部通过。
- **验收状态**：#1–#9 **均已达到本任务卡定义的静态/隔离动态判据**（#8 最终四包 tsc 均绿）。完整 155 条原厂 IPC 独立安全枚举、真实 Electron UI 交互及性能标定不在本卡九项判据内，均未据此宣称已经完成。
