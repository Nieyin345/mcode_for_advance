# T15｜真 Electron 下的 Pane U1 验收（T02 剩余两条）

| 项目 | 值 |
|---|---|
| 编号 | T15 |
| 类型 | ARC-005 U1（真 Electron 用户旅程） |
| 优先级 | 高（T02 最后两条未达成项） |
| 建议并发 | 不要与改 `components/layout/` 的任务并行 |
| 预计规模 | 小 |

---

## 要补的两条

T02 交付了三向停靠与 50/50 吸附（双击双重取反已由总控修复，见 `12dfd270`）。
但两条需要真窗口的判据没做：

1. **拖动后 PTY / Monaco 不重建**
   `dockFlexOrder` 的注释写明了「停靠只改 flex order，不重建面板树，否则 PTY/Monaco
   会被销毁」——但这是**读代码得出的**，没有真 Electron 证据。
2. **损坏布局恢复**
   `parsePaneLayout` 的损坏输入矩阵在无头里过了，但「真启动时读到损坏的
   `ui.paneLayout` → 退回默认布局 + 用户能看到提示」没有端到端验证。

---

## 开工前必读

1. `apps/desktop/scripts/settings-focus-electron-smoke/build.mjs` —— **真 Electron + 真 App**
   的现成脚手架，照抄它的组装方式（真 App、只换 `lib/api` / `monacoSetup` / 深层面板桩）。
2. `apps/desktop/scripts/settings-focus-electron-smoke/probe.ts` —— 探针怎么发真实
   输入事件（`webContents.sendInputEvent`）。
3. `apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx` 的
   `onPointerDownCapture` / `onDoubleClickCapture` —— 要模拟的就是这两条。
4. `apps/desktop/src/renderer/stores/paneLayoutPrefs.ts` 与 `paneLayout.ts`
   的 `parsePaneLayout` —— 损坏输入怎么被判。

---

## 执行内容

### 1. 建探针 `apps/desktop/scripts/arc005-pane-electron-smoke/`

照 `settings-focus-electron-smoke` 的结构（`build.mjs` + `probe.ts` + `run.sh`），
隐藏 BrowserWindow、真 App。

### 2. 三条 U1 断言

**A. PTY 不重建**
- 启动后打开一个终端面板，记录它的会话 id（或 xterm 实例的某个稳定标识）。
- 用 `sendInputEvent` 拖动右栏分隔条，把右栏从左拖到右。
- 断言：会话 id 不变；PTY 进程没有重启（可通过 `api.terminal.*` 的返回或
  DOM 上 xterm 容器节点身份判断）。

**B. Monaco 不重建**
- 打开一个文件编辑器，记录 `monaco.editor.getModels().length` 与当前 model 的 uri。
- 拖动停靠后断言：模型数量不变、uri 不变。

**C. 损坏布局恢复**
- 启动前把设置里的 `ui.paneLayout` 写成非法 JSON / 非法结构。
- 启动后断言：
  - 布局是默认布局（不是空白、不是错乱）；
  - **用户能看到提示**（i18n 文案存在且渲染出来，不是只 console.warn）；
  - 控制台没有未捕获异常。

### 3. 变异验证（必须做）

- 把 `dockFlexOrder` 改成给面板加 `key` → A、B 必须红（证明确实测到了重建）。
- 把损坏分支改成静默回退（不渲染提示）→ C 的提示断言必须红。

---

## 边界（不要碰）

- 只新增 `arc005-pane-electron-smoke/`，不改产品源码。
- 不改 `ThreePaneLayout.tsx` / `paneLayout.ts` / store。
- 不要碰 `settings-focus-electron-smoke` 的既有断言。

---

## 验收判据

1. 三条 U1 断言全绿。
2. 两条变异验证成立（撤修复必红、还原 cmp 一致）。
3. 现有 7 套 `arc005-pane-*` smoke 仍全绿。
4. 双包 tsc 干净。

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
