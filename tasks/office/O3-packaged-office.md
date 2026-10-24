# O3｜安装版里打开六格式：源码机能跑，不等于用户装完能跑

- Status: **ready-for-agent**
- Category: **Office / E2E-6**
- Priority: **P0 —— 这是「完全体」的最后一道门，而它一次都没验过**
- Depends on: 打包链路已通（`electron-builder --dir` EXIT=0，产物 875M，`resources/genoffice` 167M）
- 独占写入边界：
  - `apps/desktop/scripts/o3-packaged-u1/**`（新建）
  - **不得改** `apps/desktop/build/stage-genoffice-resources.cjs`（打包链路刚验过，见 `ec9ac3f2` / `fde19327`）
  - **不得触发新打包**（见第四节）

## Required Skills

- `mcode-smoke`：真 Electron 套件的写法
- `electron-u1` 相关：`apps/desktop/scripts/electron-u1/` 的 driver 骨架可直接复用

## 一、为什么这张卡最容易被跳过

`t7-genoffice-u1` 六格式全过，但它跑的是**源码树**：
- CLI 从 `genoffice/packages/cli/dist/genoffice.cjs` 加载
- renderer 从 `genoffice/apps/*/out/renderer` 加载
- sidecar 从 `genoffice/apps/sheets/native/xlsx-engine/target/release/` 加载

**安装版这三条路径全都变了**（见 `nativeViewsRoot()` 的两个分支）：

| | 源码 | 安装版 |
|---|---|---|
| CLI | `genoffice/packages/cli/dist/genoffice.cjs` | `resources/genoffice/cli/genoffice.cjs` |
| renderer | `genoffice/apps/<k>/out/renderer` | `resources/genoffice/apps/<k>/out/renderer` |
| sidecar | `.../target/release/xlsx-sidecar.exe` | `resources/genoffice/native/xlsx-sidecar.exe` |

**路径分支不同 = 可能只有一条被验过。** 这正是「源码能跑、装上不能跑」的经典来源。

## 二、判据

**用现成的 `apps/desktop/release/win-unpacked` 启动**（已在，875M，不要重新打包）。

### 2.1 启动即验的四件事

| # | 验什么 | 怎么验 |
|---|---|---|
| 1 | 进程起得来，主窗口可见 | 复用 `electron-u1` 的 CDP 连接 |
| 2 | `document.capabilities()` 报告的 `hosts` 六项为 true | **从应用内部读**，不是读文件 |
| 3 | `resources/genoffice/availability.json` 的 `editorsBundled === true` | 读产物文件 |
| 4 | `cliPath` 指向 **`resources/genoffice/cli/genoffice.cjs`**，不是源码路径 | 关键：证明走的是安装版分支 |

### 2.2 六格式逐一：打开（最低限度）

**本卡只要求「打开并渲染出真实内容」，不要求完整编辑保存**（那是 `t7` 在源码树上验的）。
理由：先证明资源路径在安装版下是对的，再谈编辑。两步分开，失败时能立刻定位是哪一类。

每格式：
- 打开一份真实样本；
- `assertDom` 找到该格式的特征元素
  （docs: `.ProseMirror`、sheets: `#univer-container canvas`、slides: 画布、pdf: PDF 页容器、
  markdown: 编辑区、html: 预览/源码区）；
- **不能只看「视图存在」** —— 必须看到该格式自己的特征 DOM。空壳页面也「存在」。

### 2.3 负控（必须有）

| 负控 | 期望 |
|---|---|
| 把 `resources/genoffice/apps/docs/out/renderer/index.html` 临时改名 | 打开 docs **应当失败并给出可执行说明**，不是白屏、不是假装成功 |
| 恢复后 | 再打开 docs 应当成功 |

**这个负控证明「打开成功」不是因为判据太松。**

## 三、★ 旧红 → 新绿

- 旧：六格式只在源码树验过，安装版零证据。
- 新：安装版启动 + capabilities 六项 + 六格式各自渲染出特征 DOM + 缺资源时正确拒绝。

**交付结论**：安装版能不能用 Office，卡在哪一步（如果卡）。

## 四、不要触发新打包

**用户明确说过「没做好之前不要打包」。** `release/win-unpacked` 已经存在（875M），直接用它。

如果你发现产物已损坏或缺失，**停下来回报**，不要自己跑 `electron-builder`。

## 五、本机限制（提前说明，不要当成缺陷）

- 打包产物是 **Windows x64**，只能在这台机器验。跨 OS（E2E-6 要求的「其它 OS」）**本卡不做**，
  交付时如实标注「仅 Windows 验过」。
- 真正「安装」（NSIS 安装器）**没做过**，`win-unpacked` 是解压态。
  本卡验的是「解压态能否运行」，不是「安装器能否正确安装」。**这两件事的差别要写进交付。**

## 六、变异要求

1. **删掉某个 `resources/genoffice/apps/<k>/out/renderer/index.html`** → 该格式打开必须失败；
2. **把 `availability.json` 的 `editorsBundled` 改成 false** → 第 2/3 条必须红；
3. 恢复后 `cmp` 逐字节核对。

## 七、结果回写区

（执行会话在此追加：启动结果、capabilities 六项、六格式 DOM 断言、负控、变异记录、提交 SHA）

---

## 执行结果（O3，2026-10-24）

**Status: done** —— 解压态产物上六格式全部打开并渲染出各自的特征 DOM；
缺资源时正确拒绝；变异 23/23 判据成立。**另有一条卡外缺陷（docs 关闭）已登记，
未修**，见下面 §4。

### 0. 跑法与证据

```bash
bash apps/desktop/scripts/o3-packaged-u1/run.sh            # 正常跑，期望 exit 0
bash apps/desktop/scripts/o3-packaged-u1/run.sh --mutate   # 变异验证（5 次完整跑）
pnpm test:smoke o3-packaged-smoke                          # 同一份（经 smoke 发现器）
```

**没有重新打包**（卡第四节）。用的是已在的 `apps/desktop/release/win-unpacked`
（875M，`resources/genoffice` 167M），`Mcode.exe` 直接启动，隔离的
`--user-data-dir` + 数据根指针在每次运行的 `mkdtemp` 目录里 —— 与本机真实
Mcode（当时 PID 25092 在跑）互不影响。

实现目录 `apps/desktop/scripts/o3-packaged-u1/`（入口 `o3-packaged-smoke/run.sh`
只转调它，为了满足 `run-smokes.mjs` 的 `-smoke` 发现规则）。证据落在
`.tmp/o3-packaged-u1/<时间戳>/`（**不自动清理**）。

### 1. 启动 + capabilities（A 段）

| 判据 | 结果 |
|---|---|
| 进程起来、主窗口 `[data-testid=workspace-main]` 挂载、`window.api` 可用 | **PASS** |
| `document.capabilities().hosts` 六项（**从应用内部读**） | **PASS** — `{docs:true, sheets:true, slides:true, pdf:true, markdown:true, html:true}`（另有 `slidesNative:true`） |
| `resources/genoffice/availability.json` 的 `editorsBundled` | **PASS** — `true`，`editors` 六项齐全 |
| `cliPath` 走**安装版分支** | **PASS** — `…/win-unpacked/resources/genoffice/cli/genoffice.cjs`（含 `/genoffice/cli/`，**不含** `/genoffice/packages/cli/`） |
| 项目根可登记（工作区围栏的事实源） | **PASS** |

### 2. 六格式（B 段）—— 每条的判据是**该格式自己的特征 DOM + 内容**

夹具统一由**产物里的 CLI** 生成（`resources/genoffice/cli/genoffice.cjs`，
不是源码树、不是套件自造二进制）；每份带唯一文本。PDF 例外：产物 CLI 的
`create --type pdf` 需要 GenOffice 应用（`app_unavailable`），改用手写的最小
合法 PDF（Helvetica + 一行文本），由 pdf.js 文本层来证明它被真渲染。

| 格式 | 特征 DOM | 内容证据 | 结果 |
|---|---|---|---|
| docs | `.ProseMirror` | 正文里有 `O3-DOCS-4f8a1c` | **PASS** |
| sheets | `#univer-container` + 网格 `canvas` + 名称框 | 状态栏「**2** 行可用」（= 夹具行数）+ 磁盘侧 CLI 读取（E1） | **PASS**（边界见 §5） |
| slides | `.app` + `canvas` + 缩略图栏 | 渲染树（`slidesApi.consumePendingOpen`）按 run 拼接后有 `O3-PPTX-6c0d3e` | **PASS** |
| pdf | `.app` | `.textLayer span` 里有 `O3-PDF-1a9f5b` | **PASS** |
| markdown | `.doc-editor`（Tiptap） | 编辑区里有 `O3-MD-7e4b2a` | **PASS** |
| html | `.cm-content`（CodeMirror） | 源码里有 `O3-HTML-2d8c6f` | **PASS** |

**docs 的打开链是两段**：先 `open` 视图 → 等起始屏 `.ProseMirror` 挂载 →
再 `openPath` 下发文件。第二段必须等第一段 —— 起始屏没挂载就发会被页面静默
丢弃（本卡首次 spike 复现；`t7` 的 harness 里也有同样注释）。生产面板
`GenofficeViewHostPane` 也是这个顺序。

### 3. 负控 + 正控（C 段）

| 判据 | 结果 |
|---|---|
| C1：把 `resources/genoffice/apps/docs/out/renderer/index.html` 改名 → 打开**失败** | **PASS** — `did-fail-load(-6) ERR_FILE_NOT_FOUND`，宿主 `lastFailure.kind === "load"`；没有 `.ProseMirror`，不是白屏假装成功 |
| C2：失败原因**可执行**（点名缺的页面/文件） | **PASS** — `页面加载失败(-6): ERR_FILE_NOT_FOUND` |
| C3：还原后 `sha256` 逐字节一致 | **PASS** |
| C4：恢复后 docs 用**第三份夹具**再打开成功（判据不是恒假） | **PASS** — 正文是 `O3-DOCS-4f8a1c-C` |

**为什么负控选 docs**：docs 走 `file://`，缺文件会触发 `did-fail-load`；
原厂五家走 `genoffice-app://` 协议，Chromium 把协议 handler 的 404 当成**成功
响应**（没有 `did-fail-load`）。这是两条加载路径的事实差异，不是挑软柿子。
两条路的"缺 renderer"分别由 M1（markdown，协议路）与负控（docs，file 路）覆盖。

### 4. ★ 卡外缺陷（**已登记，未修**）：docs 关闭恒被拒

| 格式 | `documentView.close` |
|---|---|
| pdf / markdown / html / sheets / slides | **成功** |
| **docs** | **恒被拒**：`编辑器未响应关闭检查；为保护未保存内容，拒绝关闭`（每次 2s 超时） |

**根因链**（本卡 spike 用页面侧计数器定位，未改产品代码）：

1. `DocumentViewHost.closeWithDirtyProtection` 对 docs 是「推
   `mcode:document-view:close-check` → 等页面 `send` 回来 → 2s 超时即拒」；
2. docs 页面（vendor `App.tsx:5337`）**确实**订阅并回了 `reportCloseCheck` ——
   页面侧计数器实测 `checkEvents: 1`；
3. 但回答走的是 `ipcRenderer.send`，主进程的对端是 `ipc/index.ts:209` 传进来的
   **`createDbGuardedIpc(ipcMain)`**，它的返回对象**只实现 `handle`、没有 `on`**；
   `documentView.ts:212` 的 `if (typeof ipc.on === 'function') ipc.on(...)` 因此
   **静默不注册**；
4. 页面的回答落在没有监听者的通道上 → 宿主 2s 超时 → fail-closed 拒绝。

**为什么 `t7`（源码树）没抓到**：t7 的 harness 用**裸 `ipcMain`** 做
`recordingIpc`，它自带 `.on`。这正是本卡要抓的「源码机能跑 ≠ 装完能跑」的
又一实例 —— 但它落在**关闭路径**，不在本卡的六格式判据里。

**处置**：单列为 `results.json` 的 `findings`（F1/F2/F3），**不计入本卡
验收**；生产 close 关不掉的 docs 视图随**应用退出**被
`documentViewHost.dispose()` 销毁（F3 记录），不留下进程内孤儿。
建议总控决定是否开新卡（修法在 `ipc/index.ts` 给包装层补 `on`，或让
`documentView.ts` 的 `ipc.on` 分支拿到裸 `ipcMain`）。

### 5. 变异（`--mutate`，5 次完整跑）

| 变异 | 撤掉什么 | 期望 | 结果 |
|---|---|---|---|
| M1 | `apps/markdown/out/renderer/index.html` 改名 | `B-markdown` 红，其余五格式仍绿 | **成立** |
| M2 | `apps/sheets/out/renderer/index.html` 改名 | `B-sheets` 红，其余五格式仍绿 | **成立** |
| M3 | `availability.json` 的 `bundled: false` | `A2`/`A4` 红（视图装配不了） | **成立** |
| M4 | 内容断言预期文本换成永不出现的串（`O3_MUTATE_TOKEN=1`） | 五个内容可读格式全红；A1–A5 仍绿；C4 跟红、C1–C3 仍绿 | **成立**（23/23） |
| M5 | `availability.json` 的 `editorsBundled: false` | 卡的 §6.2 说「第 2/3 条必须红」 | **前提不成立**，见下 |

每个变体都：备份**原始字节** → 改 → 跑完整套件 → 还原 → `Buffer.equals` 逐字节核对。

**M5 是对卡 §6.2 的更正**：把 `editorsBundled` 改成 `false`（`bundled` 保持
`true`）后**重启进程**，`capabilities.hosts` 六项**仍然全 true**、`cli.available`
仍 true。原因：`resolveGenofficeCliPath` 的 bundle 分支只检查 `format` 与
`bundled`；`editorsBundled` **只被构建期脚本读取**（`stage-genoffice-resources.cjs`
/ `verify-genoffice-editors-after-pack.cjs` / `release-readiness-smoke`），
运行时零消费方（`grep -rn editorsBundled apps/desktop/src packages/contracts/src`
零命中）。所以 A3（读文件断言该字段为 true）验的是**产物清单**，不能当成
"运行时受影响"的证据；真正能红的对应变异是 M3。

### 6. **M4 暴露的判据边界（如实记录）**：sheets 的内容层

M4 第一次跑时 **B-sheets 保持 PASS** —— 不是缺陷，是 sheets 的真实边界：

- sheets 是 Univer canvas，单元格值不在 DOM 里；
- **生产页面没有任何可读单元格的面**（实测 2026-10-24：`__univerAPI` 只在
  `import.meta.env.DEV` 下挂；公式栏不随选区显示值；名称框只有坐标）；
- 所以 sheets 的 DOM 判据证明的是「一个已装入数据的 workbook 被渲染出来了」
  （Univer 容器 + 网格 canvas + 名称框 + 「2 行可用」等于夹具行数），
  **单元格文本本身由 E1 的磁盘侧 CLI 读取证明**。

两层合起来排除了"打开了一张空壳"。**单靠 B-sheets 不证明画布上画的正是夹具**
—— 这是生产页面的能力边界，已写进 `kinds.mjs` 的 sheets case 注释与
`mutators.mjs` 的 M4 期望（"六个全红"是错的，改成"五个红 + sheets 保持绿"）。

### 7. 本机限制（卡第五节，如实标注）

- **仅 Windows x64 验过**。产物是 `win32-x64`，跨 OS（E2E-6 的「其它 OS」）
  **本卡不做**：非 Windows 上套件直接 `SKIP`（`process.platform !== "win32"`）。
- **验的是「解压态能否运行」，不是「NSIS 安装器能否正确安装」**。`win-unpacked`
  是解压目录；真正的安装（注册表、开始菜单、卸载、自动更新）**一次都没做过**。
  这两件事的差别决定：本卡的 PASS **不能**推出「用户装完一定能用」——
  它推出的是「把这份产物解压出来、双击 `Mcode.exe`，六格式能用」。

### 8. 提交

见本轮提交（`o3-packaged` 相关路径）。文件清单：

- `apps/desktop/scripts/o3-packaged-u1/{run.sh, main.mjs, kinds.mjs, fixtures.mjs, mutators.mjs, driver/{cdp.mjs, packaged-app.mjs}}`（新建）
- `apps/desktop/scripts/o3-packaged-smoke/run.sh`（新建，只转调）
- 本回写区

### 9. 未做 / 觉得不对但没改

- **docs 关闭缺陷未修**（§4）—— 卡外，已登记，建议新卡。
- **sheets 的单元格内容没有 DOM 层证据**（§5）—— 生产页面没有可读面；
  要补只能改 vendor 页面或加 dev hook，两者都超出本卡边界。
- **没有验「编辑 + 保存 + 重开」**—— 卡 §2.2 明确只要求「打开并渲染出真实内容」，
  编辑保存是 `t7` 在源码树上验的。安装版下的保存链路（`saveOpenedFile` 的写盘、
  CAS）**未验**。
- **没有验 NSIS 安装器**（§7）。
- **首次 spike 时发现主窗口在启动初期有一小段 `[data-testid=workspace-main]`
  未挂载**（约 1–2s），套件已用轮询等待覆盖；但如果用户机器更慢，值得留意。
