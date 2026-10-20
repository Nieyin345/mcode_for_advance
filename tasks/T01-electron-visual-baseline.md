# T01｜真 Electron 逐屏视觉基线（浅色 / 深色 / 窄窗）

| 项目 | 值 |
|---|---|
| 编号 | T01 |
| 类型 | ARC-005 U1（真实用户旅程验收） |
| 优先级 | 高 —— 它是 ARC-005「整包」放行的**唯一**剩余硬门槛之一 |
| 建议并发 | 可与 T02/T03/T04 并行（文件边界不重叠） |
| 预计规模 | 中（新增测试脚手架为主，不改产品代码） |

---

## 为什么做这个任务

ARC-005 的整包验收要求「逐屏对照 Claude Desktop 的真实视觉」。目前仓库里有：

- 一份**静态**参考矩阵 `docs/design/claude-code-reference-matrix.md`（13 屏 × 3 列，
  每格标了「已实现 / 未实现 / 待测」）；
- 一个**真实的逆向上游** `open-claude-ui/`（MIT，REA 取证，`.gitignore` 排除，
  需要本地检出）；
- 若干 Electron 探针（`settings-focus-electron-smoke` 等）证明「真 Electron + 真 App」
  这套测试脚手架**已经跑得通**。

缺的是**能把 13 屏 × 3 条件一次性拍下来、并且能对着上游值逐项核对的机器证据**。
没有它，「和 Claude 像不像」永远只能靠嘴说。

---

## 开工前必读

1. `audit-ledgers/README.md` —— 台账规则，尤其是 §2.3 双勾纪律与 §2.4 证据等级。
2. `CLAUDE.md` —— 尤其是「环境事实」一节（Windows 代码页、路径、sql.js 危险）。
3. `docs/design/claude-code-reference-matrix.md` —— 要验的 13 屏就在第一节的表里。
4. `docs/design/claude-desktop-ui-细节逆向.md` —— 上游读数来源。
5. `apps/desktop/scripts/settings-focus-electron-smoke/build.mjs` —— **真 Electron + 真 App**
   的现成脚手架。本任务应当复用它的组装方式（真 App、只换 `lib/api` / `monacoSetup` /
   两个深层面板），不要另造一套。

---

## 执行内容

### 1. 建立截图基线工具 `apps/desktop/scripts/arc005-visual-baseline/`

- `build.mjs`：照抄 `settings-focus-electron-smoke/build.mjs` 的组装方式，产出
  `main.cjs` + 渲染端 bundle。**不要**引入新的打包器或新的依赖。
- `probe.ts`：隐藏 BrowserWindow，逐屏执行：
  1. 用真实 store 的动作（`useSessionStore`）把界面切到目标屏；
  2. `webContents.capturePage()` 截图，写到 `.tmp/arc005-visual/<screen>-<theme>-<width>.png`；
  3. 同时 dump 一份**计算样式快照** JSON：每个屏抽 8–15 个关键元素
     （标题栏、左栏行、消息正文、工具行、Composer、卡片的实际
     `font-size` / `line-height` / `color` / `background-color` / `border-radius` / `padding`）。
     用 `getComputedStyle` 取，写到同名 `.json`。
- 13 屏名单直接取参考矩阵第一节的行标题：初始空会话、已有消息、工具运行中/完成/失败、
  权限审批、代码/文件 Diff、侧聊、终端、文件编辑、预览、并行会话侧栏、项目切换、
  设置菜单、窗口缩窄。
- 三种条件：浅色（`html` 无 `.dark`）、深色（`.dark`）、窄窗（1280×800 之外再加
  1024×640 这一档，这是 `apps/desktop/src/main/window.ts` 的最小窗）。

### 2. 与上游值逐项比对

`compare.mjs`：读 `.json` 快照，与 `open-claude-ui/code-examples/cds-theme.css`
的对应变量比对。**只比对参考矩阵第二节里已经登记过的项**，不要扩大：

- `--surface-*` / `--content-*` / `--edge` 的**色值关系**（不要求逐字节相等 —— 矩阵里
  已经记录了"Mcode 刻意加深以过 AA"的差异，那些是设计决策，不是缺陷）
- 圆角档（panel 10 / composer 20 / bubble / btn 6/8 / dialog 16 / code 12）
- 动效时长与曲线（矩阵判定为「一致」的四条）

输出 `diff.md`：逐项列「Mcode 值 / 上游值 / 矩阵判定 / 本次实测 / 结论」。
**结论只有三种**：`一致` / `已知差异（矩阵已登记，理由见矩阵）` / `未登记差异`。
`未登记差异` 是这次要抓的东西。

### 3. 产出

- `.tmp/arc005-visual/` 下 39 张 PNG（13 × 3，缺的用 `data-missing` 标记，不伪造）
- `diff.md`
- `apps/desktop/scripts/arc005-visual-baseline/run.sh`
- 一份 `README.md` 说明如何复跑

### 4. 把结论写进参考矩阵

在 `docs/design/claude-code-reference-matrix.md` 末尾追加「V4 实测」一节：
逐格写「已实测：一致 / 已知差异 / 未登记差异（内容）」。**不要**改原有的判定词。

---

## 边界（不要碰）

- **只读**：`apps/desktop/src/renderer/**` 下所有产品代码。发现视觉问题**记录下来**，
  不要在本任务里顺手改 —— 那会让「基线」和「修复」混在一起，无法判断基线是否可信。
- **只读**：`apps/desktop/src/main/**`。
- 不要改 `design-tokens-smoke`、`styles.css`、`tokens.cds.css`。
- 不要提交 `.tmp/` 下的 PNG（它已在 gitignore 里，确认一下）。
- 不要引入新依赖（截图用 Electron 自带的 `capturePage`）。

---

## 验收判据

1. `bash apps/desktop/scripts/arc005-visual-baseline/run.sh` **真的跑起来**并产出
   13 个屏 × 3 条件的快照文件（缺的必须有显式 `data-missing`，不许静默少图）。
2. `diff.md` 里的每一项结论都能追溯到具体的计算样式值（不许写"看起来差不多"）。
3. 至少核实 3 个参考矩阵里标「待测」的格子，并把实测值填进去。
4. **变异验证**：故意把 `--surface` 改成一个错误值 → `compare.mjs` 必须报
   `未登记差异`；还原后 `cmp` 逐字节一致。
5. 全套 `pnpm test:all` 仍然全绿（本任务只加测试，不该弄红任何既存套件）。

---

## 你要在回写区回答的问题

- 39 格里有多少格**真的拍到了**？没拍到的为什么？
- `未登记差异` 有几项？每项是什么？（这些是我后续要派修复任务的输入）
- 本机 Electron 版本、Windows 版本、DPI 缩放比例。

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。格式：

### 2026-XX-XX 执行结果

- 提交：`<SHA>`（`git rev-parse HEAD`）
- 改动文件：...
- 命令与结果：...
- 变异验证：...
- 未完成/未验证：...
- 剩余风险：...
-->

### 2026-10-20 执行结果（T01，U1 部分达成）

- 源码与矩阵提交：`8e9e2e34054e74438f8cde3870eab566d6a86923`（只包含 T01 新增脚手架与 V4 参考矩阵增量，未改产品源码）。
- 改动文件：`apps/desktop/scripts/arc005-visual-baseline/{build.mjs,probe.ts,compare.mjs,run.sh,README.md,api-stub.js,bridge.cjs,electron-host.cjs,windowStub.ts}`；`docs/design/claude-code-reference-matrix.md` 追加第十二节 V4 实测。
- 命令与结果：`"C:\\Program Files\\Git\\bin\\bash.exe" apps/desktop/scripts/arc005-visual-baseline/run.sh` 退出 0；`.tmp/arc005-visual/` 39 份同名 JSON，**真实 Electron capturePage PNG 16 张**，其余 23 格含明确 `data-missing`（7 类高依赖屏的浅/深/窄窗各 3 格：Diff、侧聊、终端、编辑器、预览、并行侧栏、项目切换；“窗口缩窄”浅色和深色不是窄窗的 2 格）。保留空缺，不用空白/替身截图冒充。
- 上游比对：`node apps/desktop/scripts/arc005-visual-baseline/compare.mjs` 产出 `.tmp/arc005-visual/diff.md`，退出码 2 表示如实发现未登记差异；637 条登记值相符，247 条矩阵已有已知差异，**13 条未登记差异只有 1 个独立根因**：暗色 `--edge` 实测 `44 44 42`（`#2c2c2a`），矩阵 §二旧值 `#c3c2b7`，暗色 13 屏重复 13 次。逐条可通过 `<screen>-<theme>-<width>.json` 的 `snapshot.tokens` 与 `snapshot.measured` 复核。
- 待测项实测：矩阵 V4 追加了 13×3 结果，并给出原“待测”的 **工具、权限审批、设置菜单三个窄窗格** 的 font-size、line-height、background、radius、padding、bounds 真实数值；未擅自改动原判定或宣称 Claude Desktop 已实测。
- 变异验证：仅临时把 `.tmp/arc005-visual/empty-light-1280.json` 的 `snapshot.tokens["--surface"]` 改为 `255 0 255`，比较器未登记差异由 13 增为 14 并在 diff 中出现错误值；还原后回到 13；前后 SHA-256 均为 `c0b9f86a65ac83fa21a580cc83688231b0f6c55c8c3eebd0383e008563e740b6`，二进制 Buffer/cmp 相同。证据：`.tmp/arc005-visual/mutation.json`。
- 全量回归：`pnpm test:all` **未全绿**，退出 1；`run-smokes.test.mjs` 12/12 PASS，另 495 个 smoke 套件 **483 PASS / 12 FAIL**。红例：`collaboration-commit-audit-smoke`、`maint-m22-smoke`、`document-router-smoke`、`html-preview-electron-smoke`、`maint-m07-smoke`、`maint-m35-smoke`、`mcode-node-pack-smoke`、`module-extension-lifecycle-smoke`、`module-protocol-integrity-smoke`、`release-readiness-smoke`、`updater-tools-smoke`、`vscode-l1-smoke`。日志路径：`apps/desktop/.tmp/smoke-runs/1792493668848-29820-6HJvNk/`。本执行对话未修改以上红例对应业务/测试源码；无法将它们归因为 T01。
- 运行环境：**Electron 44.4.5**，Windows 内核版本 **10.0.22000**，**devicePixelRatio 1.75（175% DPI）**；窄窗请求 1024×640，网页 viewport 实际 1024×614（窗口框架占高）。
- 验收判据结论：**#2、#3、#4 达成；#1 部分达成**（39 格都有 JSON 与缺失原因，但只有 16 格实际拍图、23 格尚需完整宿主支持）；**#5 未达成**（495 套件中 12 红例）。另有上游 Claude 用户安装版未取证，因此不能据此放行 ARC-005 整包。
- 剩余风险：可复跑的基线工具已建立，但真实项目/终端/侧聊/文档场景尚无独立安全夹具；暗色 `--edge` 旧矩阵登记需要后续审查决定是否更新。本任务遵守仅增加基线、不修产品代码的边界。
