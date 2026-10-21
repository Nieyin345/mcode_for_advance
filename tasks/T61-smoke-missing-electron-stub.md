# T61｜两套 smoke 引用了不存在的 electron 桩

| 项目 | 值 |
|---|---|
| 编号 | T61 |
| 类型 | **测试基础设施** |
| 优先级 | 中 —— 两套跑不起来，其中一套是 T59 的判据 6 |
| 建议并发 | 只改 `apps/desktop/scripts/`；**与任何任务不冲突** |
| 预计规模 | 小 |

---

## 前置条件

- **无前置**，可直接派。

---

## 现状（实测，2026-10-21）

`apps/desktop/scripts/run-store-smoke/stubs/` 里只有：

```
dataRoot.ts
logger.ts
```

**没有 `electron.ts`。**

但两套 `run.sh` 引用了它：

```
apps/desktop/scripts/workflow-seed-smoke/run.sh:23
apps/desktop/scripts/published-tools-smoke/run.sh:21
  --alias:electron=./scripts/run-store-smoke/stubs/electron.ts
```

**后果**：这两套在 esbuild 阶段就失败，跑不到断言。

T59 的回写区报告：

> `workflow-seed-smoke` **仍失败**，现存的旧构建脚本引用不存在的
> `scripts/run-store-smoke/stubs/electron.ts`，还在旧组合中拉入缺少可打包的
> `cpu-features`/GenOffice 资产。

---

## 这不是「复制一个 stub」那么简单

T59 提到两个问题，第二个可能更麻烦：

> 还在旧组合中拉入缺少可打包的 `cpu-features`/GenOffice 资产

**`cpu-features` 是原生模块**，esbuild 打不进去。
**GenOffice 资产**是 T28/T42 之后新增的依赖链。

所以这两套可能不只是缺一个 stub，而是**整个构建配置都过时了**。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/.claude/skills/mcode-smoke/SKILL.md` —— **全文**。
   特别是「`--alias` 只认包名」「相对 import 换不掉」「`--banner` 非有不可」。
3. `apps/desktop/scripts/run-store-smoke/stubs/` —— 现有两个桩的写法。
4. `apps/desktop/scripts/workflow-seed-smoke/run.sh` 与
   `apps/desktop/scripts/published-tools-smoke/run.sh` **全文**。
5. 这两套的 `main.ts` —— 它们到底需要 `electron` 的哪些 API。
6. `apps/desktop/scripts/genoffice-native-view-smoke/run.sh` ——
   T28/T42 之后的套件怎么处理 GenOffice 依赖（**照它的做法**）。

---

## 执行内容

### 第 1 步：先跑一次，看真实错误

```bash
bash apps/desktop/scripts/workflow-seed-smoke/run.sh 2>&1 | head -40
bash apps/desktop/scripts/published-tools-smoke/run.sh 2>&1 | head -40
```

**不要相信卡里写的错误，以实测为准。**

### 第 2 步：判断缺的是什么

三种可能：

- **A. 只缺 `electron.ts` 桩** → 补一个
- **B. 缺桩 + 构建配置过时** → 补桩 + 加 `--external` 或 `--alias`
- **C. 整个套件的假设过时**（它测的东西已经变了）→ 先判断它还有没有价值

**第 3 步之前必须先回答是哪种。**

### 第 3 步：按情况处理

**如果缺桩**：

`run-store-smoke/stubs/electron.ts` 是共享位置，**补在里面**（其它套件可能也要用）。
照现有 `dataRoot.ts` / `logger.ts` 的写法 —— **桩要真代理，不要手写返回值**。

**如果构建配置过时**：

照 `genoffice-native-view-smoke/run.sh` 的做法（T28/T42 之后建的）：
- 无关的 vendor 用 `--alias` 指到 stub
- 原生模块用 `--external`

**如果套件本身过时**：

在回写区说明它测什么、现在还有没有价值、被谁取代。
**不要为了让它变绿而删断言。**

### 第 4 步：确认没有第三套受影响

```bash
grep -rln "run-store-smoke/stubs/" apps/desktop/scripts/ | wc -l
```

**每个引用方都要检查**，不只是报错的这两套。

---

## 边界（不要碰）

- **只改 `apps/desktop/scripts/`**。
- 不改任何 `src/main/` 或 `src/renderer/` 的产品源码。
- 不改断言的语义（改形状让它匹配新实现可以，删断言不行）。
- 不改 T54 的 `genoffice-pane-fence-smoke`。
- 不改 `packages/contracts/`。

---

## 验收判据

1. `workflow-seed-smoke` 能跑到断言阶段并全绿（或有明确的「该退场」结论）。
2. `published-tools-smoke` 同上。
3. 所有引用 `run-store-smoke/stubs/` 的套件都检查过，没有第三套坏的。
4. 双包 tsc 干净。
5. **变异验证**：如果补了 `electron.ts`，删掉其中一个导出 →
   对应套件重新构建失败（证明桩真的是必需的）。

---

## 回写区要回答

- 这两套的真实错误是什么？（不是卡里说的，是实测的）
- 缺的只是 `electron.ts` 吗？还是构建配置也过时了？
- `cpu-features` 和 GenOffice 资产怎么处理的？
- 有多少套引用 `run-store-smoke/stubs/`？都检查了吗？
- 如果某套该退场，它原本测什么？现在被谁覆盖了？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 执行回写（T61）

- 基线 HEAD：`89c56a8b608de45f9080716e4bf7e3a275d7f086`。仅修改两个 `run.sh`、新增共享 `scripts/run-store-smoke/stubs/electron.ts`；没有改产品源码或删除断言。
- **真实红例**：以 `apps/desktop` 为 cwd 运行 `bash scripts/workflow-seed-smoke/run.sh` 与 `bash scripts/published-tools-smoke/run.sh`，两者均在 esbuild 阶段报告 `Could not resolve "./scripts/run-store-smoke/stubs/electron.ts" (originally "electron")`，还报告 sherpa-onnx 平台原生 `.node` 文件无 loader（初轮约 32 条构建错误）；补齐桩后仍有 10 条原生打包错误。因此判定 **B：缺 Electron 桩 + 构建配置过时**，不是套件断言过时。
- **修法**：新增共享 Electron 桩，真实代理 `app.getPath("userData")` 到必须显式提供的 `MCODE_SMOKE_DATA_ROOT`（未设置立即抛，不碰真实用户库）；与 `safeStorage` 等无头行为约束兼容，其余非本测职责的 API fail-loud。两套构建追加 `--alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts` 隔离无关 GenOffice vendor；原生 `sherpa-onnx-node`、`cpu-features` 用 `--external`，其调用未在断言路径发生。`ssh2` 不外置（实测若外置，临时 bundle 从 `/tmp` 解析不到裸包），保留打包以免运行时错误；保留既有 ESM `--banner`。
- **两个目标全绿**：`workflow-seed-smoke` 四进程依次 `4/4+7/7+3/3+12/12=26/26`；`published-tools-smoke` `27/27`，均运行实际断言（非仅打包绿）。
- **共享引用方核查**：`git grep -l "run-store-smoke/stubs/" -- apps/desktop/scripts` 命中 128 个文件，跨 116 套；另以内容搜索核实共 116 套、225 行引用。**直接引用缺失 `run-store-smoke/stubs/electron.ts` 的只有上述 2 套**。命令 `node scripts/run-smokes.mjs <116 个关联套件名>` 已逐套运行，结果 **112 PASS / 4 FAIL**，日志 `apps/desktop/.tmp/smoke-runs/1792578963294-23664-z32qDg/`。四个失败：`app-control-smoke` 的 catalog 缺 `workflowEngine.load`（569/570）；`automation-smoke` 的旧 `--alias:node:fs` 连带破坏 `node:fs/promises` 的解析；`event-vertical-smoke` 对 sherpa 平台 `.node` 原生模块未外置；`orchestration-ipc-smoke` 既有工作流字段/出厂更新标记断言红（430/433）。这些套件没有引用新共享 `electron.ts`，未越界替其它任务修它们。**验收判据 3 的“无第三套坏的”严格意义未达成**，但没有第三套遇到本次报告的缺失 `electron.ts` 故障。
- **双包类型检查**：`../../node_modules/.bin/tsc.cmd --noEmit -p tsconfig.json` 分别于 `apps/desktop`、`packages/contracts` 执行，均 exit 0。
- **变异验证**：将共享桩 `export const safeStorage` 临时改成 `const safeStorage`，重新执行 `published-tools-smoke`，esbuild 按预期报 `No matching export ... for import "safeStorage"`（`secretStore.ts`、`BrowserManager.ts`）；随后逐字恢复该导出，目标测试与 116 套批跑均在恢复后进行。判据 5 已达成。
- **remaining**：仅判据 3 的关联套件全绿尚未达成；上述 4 个旧红例各有独立根因，不在 T61 的两套构建与共享 Electron 桩修复范围。任务仍有价值：MC-053/ARC-006 导入保真与 MC-041 发布工具闭环都恢复了动态保护。
