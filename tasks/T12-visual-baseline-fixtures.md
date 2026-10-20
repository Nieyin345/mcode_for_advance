# T12｜视觉基线补完：7 类高依赖屏的真实夹具

| 项目 | 值 |
|---|---|
| 编号 | T12 |
| 类型 | ARC-005 U1（T01 的续篇） |
| 优先级 | 中 |
| 建议并发 | **不要与 T02 同时跑**（T02 会改布局，基线会立刻过期） |
| 预计规模 | 中大 |

---

## 为什么还差 23 格

T01 建好了 `apps/desktop/scripts/arc005-visual-baseline/`，39 格里拍到 16 格。
剩下 23 格不是偷懒，是**脚手架本身拍不到**——`probe.ts` 里每一条都有明确理由：

| 屏 | 缺格数 | `probe.ts` 里写的原因 |
|---|---|---|
| `diff` | 3 | 无带旧版本的真实文件 Diff 夹具；不伪造 Monaco diff |
| `sidechat` | 3 | 依赖独立 WorkflowBoard IPC；复用脚手架下真实面板会卸载 |
| `terminal` | 3 | 无独立 PTY 宿主；直接打开会触发原生终端创建 |
| `editor` | 3 | 无可安全读取的已打开编辑器文件 |
| `preview` | 3 | 无真实可预览文件夹具（PDF/图片/Markdown） |
| `parallel` | 3 | StreamSidebar 是焦点脚手架的替身，不是真组件 |
| `projects` | 3 | 同上（左栏被替换成占位） |
| `narrow-window` 的 light/dark | 2 | "窄窗"本身是一个宽度条件，不是主题 |

根因是 T01 复用了 `settings-focus-electron-smoke` 的组装方式，那套为了测焦点，
把 `LeftBar` / `StreamSidebar` 换成了占位 div、并且不加载真实 IPC。

**本任务要把这 7 类屏的真实夹具建起来**，让它们能真的被截图与量取。

---

## 开工前必读

1. `tasks/T01-electron-visual-baseline.md` 的「执行结果」一节 —— 已有事实与判据。
2. `apps/desktop/scripts/arc005-visual-baseline/probe.ts` **全文**，特别是
   `SCREENS` 数组与每个屏的 `result(false, reason)` 分支（第 150–200 行附近）。
3. `apps/desktop/scripts/arc005-visual-baseline/README.md` —— 它当前怎么组装、
   哪些模块被换了桩。
4. `apps/desktop/src/renderer/components/layout/LeftBar.tsx` 与 `StreamSidebar.tsx`
   —— 它们为什么在焦点脚手架里会炸（读文件头注释）。
5. 现有的「真实 Electron + 真 App」参考：`settings-focus-electron-smoke/build.mjs`。

---

## 执行内容

按难度从低到高，**每完成一类就提交一次**，不要憋一个大提交：

### 1. `parallel` + `projects`（最容易）

这两个只是因为 `LeftBar` / `StreamSidebar` 被换成了占位 div。
把它们换回**真组件**，并用假 store 数据喂出「多个并行会话」与「多项目」的状态。
关键：如果真组件在无 IPC 环境会炸，**补最小 stub 而不是替换组件**——
`api.ts` 已经被换成 `window.labApi`，往那个 stub 里补所需方法即可。

### 2. `terminal`

`TerminalView` 会真的起 PTY。两条路：
- **推荐**：把 `TerminalView` 换成一个**同样几何、同样主题变量**的静态渲染桩，
  并**在 JSON 里标注 `fixture: "static-terminal"`**——它验的是「终端面板的
  背景/前景/字号/内边距是否与 token 一致」，不是 PTY 行为。
- 不推荐：真起 PTY（会污染用户机器，且截图时机不稳定）。

**标注必须写进快照**，不能让人误以为这是真终端。

### 3. `editor`

同理：Monaco 会加载 worker。用 `monacoSetup` 的桩（`settings-focus-electron-smoke`
已经有 `export const monacoSetup=()=>{}`），配一个**虚构的只读文件体**渲染。
JSON 里标注 `fixture: "stub-editor"`。

### 4. `preview`

PDF/图片/Markdown 三种预览里，**至少把 Markdown 做真**（它是纯渲染，不依赖原生视图）。
PDF 与图片可以用同目录下的**仓库内已有静态资源**（`src/renderer/public/` 里有没有？
先查，没有就用一个极小的内联 PNG data URL）。标注 `fixture` 类型。

### 5. `diff`

需要「同一个文件的两个版本」。做法：在 `.tmp/arc005-visual/` 下**临时**写两个版本的
虚构文本文件（`v1.ts` / `v2.ts`），用真实 `lineDiff` 算出 diff，喂给 `DiffView`。
不要伪造 diff 数据——那验不出渲染是否正确。

### 6. `sidechat`

最难。它依赖 `WorkflowBoardPanel` 的 IPC。先读那个组件的依赖，
**优先补 `window.labApi` 的 stub 方法**让它能渲染；实在不行的部分
（例如某个必须的异步订阅）用一个**永不 resolve 的 Promise** 让面板停在加载态——
那至少能拍到面板框架的视觉。标注 `fixture: "sidechat-partial"` 并说明缺什么。

### 7. `narrow-window` 的两格

这两格的意思是「窗口本身变窄时整体布局如何」。
简单做法：在 `CONDITIONS` 里已经有 1024×640 的窄窗条件，
把 `narrow-window` 这个屏定义成「同时打开左栏 + 右栏 + 编辑器」的极端组合，
让它在窄窗下真的挤压。如果这样定义不合适，**在回写区说明你改成了什么定义**。

---

## 边界（不要碰）

- **只改 `apps/desktop/scripts/arc005-visual-baseline/`**。
  不要改任何产品源码（`apps/desktop/src/renderer/**`）。
- 如果某个真组件必须有产品侧的小改动才能被隔离渲染（例如导出某个内部函数），
  **停下来在回写区说明**，不要自己改产品代码。
- 不要改 `docs/design/claude-code-reference-matrix.md` 的原有判定，
  只在 V4 节追加新的实测值。
- 不要碰 T02 正在改的布局文件。

---

## 验收判据

1. `.tmp/arc005-visual/` 里的 PNG 从 16 张增加到 **≥ 30 张**（目标 39）。
2. 每一张新图都在同名 JSON 里有 `fixture` 字段说明它是真实渲染还是桩，
   **不许有不标注的桩**。
3. `compare.mjs` 仍然能跑，未登记差异数**不增加**（除非你发现了新的真实差异，
   那要在回写区单独说明）。
4. `npx tsc --noEmit -p apps/desktop/tsconfig.json` **exit 0**（当前已由总控修好，
   不要弄红）。
5. **变异验证**：随便挑一个 token（例如 `--surface`）在快照里改错，
   `compare.mjs` 必须报未登记差异；还原后 `cmp` 一致。
6. 仍然缺的格，逐格写清「为什么还是拍不到」，不许静默留空。

---

## 你要在回写区回答的问题

- 新增了多少张？用的哪些是桩、哪些是真渲染？
- `sidechat` 到底缺什么？补它需要产品侧改什么？
- 有没有发现新的「未登记差异」？
- 39 格里还剩几格没拍到，各是什么原因？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
