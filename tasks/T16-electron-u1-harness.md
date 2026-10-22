# T16｜真实 Electron U1 验收框架（可复用驱动骨架）

- Status: ready-for-agent
- Category: task
- Priority: P0 infrastructure
- Depends on: none
- Exclusive writable files: 新建 `apps/desktop/scripts/electron-u1/` 目录（驱动库 + 示例旅程 + run.sh），以及本节末尾的结果回写区。**不改** `arc005-visual-baseline/`、不改产品源码。

## Required Skills
- `mcode-smoke`: 理解现有 E1 证据形态，并在设计中把 U1 与 E1 的边界写死。
- `code-review`: 检查骨架是否真的能区分「通过」与「假装通过」。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`docs/planning/mcode-product-roadmap.md`、`apps/desktop/scripts/arc005-visual-baseline/README.md`、`apps/desktop/scripts/arc005-visual-baseline/electron-host.cjs`、`windowStub.ts`、`bridge.cjs`、`build.mjs`。

## 为什么要这张卡

现在整个项目**能拍静态截图，但不能跑用户旅程**。`arc005-visual-baseline` 拍 39 格 PNG + JSON，每个 JSON 都诚实标注了 `fixture` 类型（`real-app` / `static-terminal` / `stub-editor` / `sidechat-partial`）——这是好的取证纪律，但它**不是 U1**：

- 它验证「某个 DOM 在某个 viewport 下长什么样」
- 它不验证「用户点 A → 输入 B → 看到 C → 保存 → 重开还在」

T7（GenOffice 六编辑器 U1）、T8（Node-RED 画布 U1）、ARC-005 V4（逐屏对照）全都卡在同一个缺口上：**没有一个可复用的「启动真 Electron → 操作 → 断言」骨架**。每张卡都要从零手搓一遍，就会各自发明一套，最后谁也没法复核。

## 目标

产出一套**薄**的、可被后续任务卡 import 的驱动库，让「跑一段真实用户旅程」变成写几行声明式步骤。

### 硬性要求

1. **真 Electron**：必须 `app.whenReady()` 起真实 `BrowserWindow`，真实 `capturePage()`。禁止把 DOM stub 或 jsdom 包装成 U1。
2. **每步都有证据**：每一步产出 {步骤名, 动作, 断言, 截图路径, DOM 快照摘要, 时间戳}。失败时保留现场（不清理临时目录）。
3. **必须能失败**：骨架自带一条**故意失败**的示例旅程，证明断言真的会红。这是本卡最关键的自检。
4. **旅程声明式**：用数据描述步骤（导航/点击/输入/等待/断言），不要求每个用例写 200 行 Electron 样板。
5. **可断言的东西要分档**：
   - `dom` —— 元素存在/文本/属性
   - `visual` —— 截图与基准比对（允许标注「仅记录不断言」）
   - `sideEffect` —— 磁盘文件真的变了（用于保存/重开类旅程）
   - **三种都必须能单独开关**，便于某一步只取证不断言
6. **零新依赖优先**：先看现有 Electron + esbuild 能不能做。真要加依赖（如 Playwright 的 Electron 支持），必须在回写里给理由、许可、体积影响。

### 建议的最小 API（可调整，但要写进回写）

```ts
const journey = defineU1Journey({
  name: "genoffice-docs-open-edit-save",
  launch: { userData: temp, env: {...} },
  steps: [
    step.navigate("/"),
    step.click("[data-testid='file-tree'] >> text=blank.docx"),
    step.waitFor("[data-genoffice-editor]"),
    step.assertDom(...),
    step.screenshot("opened"),
    step.type("...", "hello"),
    step.assertSideEffect({ file: "blank.docx", sha256Changed: true }),
  ],
});
```

## 必须覆盖的三条示例旅程（证明骨架可用）

1. **纯 UI**：启动 → 主窗口出现 → 点左栏某项目 → 断言中间面板切换。不需要真实文件。
2. **文件副作用**：打开一个临时 `mcode.db` 副本与临时文档 → 改一个字节 → 保存 → **重开进程** → 断言改动还在。这条证明骨架能验「保存」这类最容易假绿的行为。
3. **故意失败**：断言一个不存在的元素，**必须红**，并把截图与 DOM 快照留在失败的证据目录里。

## 禁止事项

- 不得把 `arc005-visual-baseline` 的 fixture 冒充成 U1。
- 不得为了让骨架「跑绿」而放宽断言。
- 不得在骨架里读写真实用户数据目录；一律 `mktemp -d`。
- 不得宣称 T7/T8/ARC-005 V4 已完成——本卡只交付**框架**。

## 验收判据

1. `bash apps/desktop/scripts/electron-u1/run.sh` 能起真实 Electron 并跑完三条示例旅程。
2. 第二条旅程**在真实重开进程后**断言到改动持久化。
3. 第三条旅程**失败**，且失败证据（截图 + DOM）落盘；脚本以非零码退出。
4. 骨架被至少一个后续卡可直接 import（在回写里给出 import 示例）。
5. 变异验证：把骨架里的断言执行改成「无条件通过」，第三条旅程必须由红变绿——证明它之前真的在判。

## 结果回写（2026-10-23）

（执行者在此追加）
