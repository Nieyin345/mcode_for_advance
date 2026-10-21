# T52｜smoke 急救：501 套里 25 套红，其中 15 套是构建就崩

| 项目 | 值 |
|---|---|
| 编号 | T52 |
| 类型 | **测试基础设施**（不是新功能，是让验证重新可信） |
| 优先级 | **最高** —— 25 块地方的验证是假的 |
| 建议并发 | 改 `apps/desktop/scripts/` + `electron.vite.config.ts`；与功能卡不撞 |
| 预计规模 | 中 |

---

## 实测现状（2026-10-21，`bash apps/desktop/scripts/run-all-smokes.sh`）

**501 套，25 套红。** 分两类，根因完全不同。

### A 类：15 套在 esbuild 构建期就崩（不是断言失败）

```
X [ERROR] Top-level return cannot be used inside an ECMAScript module

    ../../genoffice/packages/html2docx/src/browser/core/paragraphs-document.js?raw:285:2:
      285 │   return globalThis.__html2docxPages.build({
          ╵   ~~~~~~
```

**根因**：T28 把 GenOffice 的 vendor 包引入了主进程 bundle。其中
`html2docx` 有一个用 `?raw` 导入的文件，那个文件顶层有 `return`，
esbuild 在 ESM 上下文里拒绝它。

**受影响的套件**（实测 15 个，含）：
`agent-mail` / `app-control` / `base-capability-matrix` / `document-read` /
`effective-tools` / `genoffice-cli` / `genoffice-format-gates` /
`genoffice-editors-release` / `genoffice-mcp` / `ipc-wiring` /
`html-preview-electron` / `maint-m15` / `mcode-admin` / `mcp-endpoint` / `mcp-ui`

**关键**：这些套件的**产品代码可能是对的**，但它们的 bundle 现在装不下 vendor。
**这不是「测试坏了」，是「测试再也跑不起来了」。**

### B 类：10 套是真断言失败或被信号打断

| 套件 | 现象 | 判断 |
|---|---|---|
| `arc005-chrome-polish-smoke` | 11/12，1 条断言红 | **真失败** |
| `design-tokens-smoke` | 338/339，1 条断言红 | **真失败** |
| `skills-management-ui-smoke` | 需单独看 | 待定 |
| `lsp-smoke` | 内部断言全 `ok`，但 exit=3840 | **像并发撞车** |
| `automation-smoke` | exit=3840 | 同上 |
| `mcode-node-pack-smoke` | exit=3840 | 同上 |
| `market-multiprocess-smoke` | exit=3840 | 同上 |
| `mcp-ipc-smoke` | exit=3840 | 同上 |
| `mcp-market-boundary-smoke` | exit=143（SIGTERM） | 同上 |

**`3840 = 15 × 256`** —— 不是正常退出码，像是被外部或运行器 kill 掉。
`143 = 128 + 15`（SIGTERM）。这两组要单独诊断。

---

## 为什么这张卡优先

`docs/testing.md` 与 `tasks/README.md` 都写着「test:all 0 失败是基线」。
**现在基线是 25 红，而且这个事实被记成了「test:all 当前仍是红的，不能声称全绿」。**

后果是真实的：任何一张卡说「现有套件全绿」，那 25 套里的验证都是空的。

**修好它，比再加一个新功能更重要。**

---

## 前置条件（不满足就不要开工）

- **无前置**。可以直接派。
- 唯一要求：开工前先跑一次 `bash apps/desktop/scripts/run-all-smokes.sh`，
  把当前的失败套件列表记下来（可能与卡里写的不完全一致 —— 并行任务会改动它）。
  以**你实测的那份**为准，并在回写区写明与卡里差在哪。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/.claude/skills/mcode-smoke/SKILL.md` —— **全文**，尤其是
   「`--alias` 只认包名」「相对 import 换不掉」「`--banner` 非有不可」。
3. `apps/desktop/scripts/run-smokes.mjs` 的 `runPool` / `runSuites`：
   - `:253` 默认并发 `min(6, cores)`
   - `:254` 重型套件 `min(3, ceil(cores/4))`
   - `:232` 超时 `240_000`
4. `apps/desktop/electron.vite.config.ts` —— T28 新增的 vendor 别名。
5. `genoffice/packages/html2docx/package.json` 与
   `src/browser/core/paragraphs-document.js`。
6. `CLAUDE.md` 的环境事实：**这台机器反复蓝屏 0x1A**。

---

## 执行内容

### 第 1 步：修 A 类（15 套构建失败）—— 这是最急的

**根因排查**：

- 为什么 `agent-mail-smoke` 这样的**主进程**套件会 import 到 `html2docx`？
  （T28 新增的 vendor 别名把整条 import 链带进来了）
- `html2docx` 那个 `?raw` 导入是给谁的？是渲染端用的还是主进程用的？
- 有没有办法**只对需要它的套件**加载？

**可能的修法**（按优先级）：

1. **精确别名**：只把真正需要的子路径映射到 vendor，
   不要把整个 `html2docx` 包根映射进去（照 `slidesVendorModules` 的做法）
2. **`--loader:.js=text`**：如果那个文件确实只当字符串用，
   在 esbuild 参数里加 loader
3. **stub**：如果那些套件根本不需要 `html2docx`，加一个 stub 别名

**判据**：15 套全部能跑到断言阶段（红绿都行，但不再构建失败）。

### 第 2 步：修 B 类的 3840 / 143

**先确认是不是并发撞车。**

```bash
# 单跑，看是否绿
MCODE_SMOKE_JOBS=1 bash apps/desktop/scripts/run-smokes.mjs lsp-smoke automation-smoke \
  mcode-node-pack-smoke market-multiprocess-smoke mcp-ipc-smoke mcp-market-boundary-smoke
```

- **单跑绿** → 是并发问题。改 `run-smokes.mjs` 的默认并发，
  或给这些套件标「重型」
- **单跑也红** → 是真失败，进第 3 步

**注意**：`CLAUDE.md` 写了本机蓝屏风险，降并发是**正确的方向**，
不是「掩盖问题」。

### 第 3 步：修 B 类的两条真断言失败

- `arc005-chrome-polish-smoke` 的那条：
  「工作区信息有弹性、可剪裁的单个上下文条且主窗口不重建」
- `design-tokens-smoke` 的那条（要单独看日志确认是哪条）

**这两条不要盲目改断言。** 先判断：
- 如果是产品代码真的退化 → 修产品
- 如果是断言过时 → 修断言，并在回写区说明为什么

### 第 4 步：把「test:all 是红的」这个事实写进基线

修完之后：
- `docs/testing.md` 更新基线
- `tasks/README.md` 的「已知未修」段清空这一条

### 第 5 步：给 `run-all-smokes.sh` 加一个「快速失败」摘要

现在跑全量要几分钟，输出 501 行。加一个 `--failures-only` 之类的开关，
只打印失败套件与失败的断言行。

**这不是必需的，但如果顺手就做。**

---

## 边界（不要碰）

- **不改产品代码**，除非第 3 步确认是真退化。
- 不改现有断言的语义（可以改形状让它匹配新实现，删断言不行）。
- 不改 vendor 源码（`genoffice/`）。
- 不改其它卡的领域（`document/` / `workflowEngines/` / `appControl/`）。

---

## 验收判据

1. `bash apps/desktop/scripts/run-all-smokes.sh` → **501 套全部跑到断言阶段**
   （不再有构建失败）。
2. 失败套件数从 25 降到 **0 或可在回写区逐一解释的极小数目**。
3. 每一条修掉的失败都有「根因 + 修法」记录在回写区。
4. 6 套疑似并发的套件：单跑结果写进回写区。
5. 双包 tsc 干净。
6. **变异验证**：A 类的修法要证明「撤掉修复 → 该套件重新构建失败」；
   B 类如果是产品退化，撤掉修复 → 断言红。

---

## 回写区要回答

- 15 套构建失败的根因是**同一个**吗？有没有不止一个原因？
- `html2docx` 的 `?raw` 文件到底是谁在用？主进程真的需要它吗？
- 6 套 3840 的套件，单跑绿不绿？并发的安全上限是多少？
- `arc005-chrome-polish` 与 `design-tokens` 那两条，是产品退化还是断言过时？
- 修完之后 `test:all` 的耗时是多少？降并发后变慢了多少？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 T52 执行与可复现证据

- **实际集合漂移**：原任务的「501 套 / 25 红」是派单时快照；运行期间其它开发卡新增套件。全量实测调用 `set MCODE_SMOKE_JOBS=2 && set MCODE_SMOKE_HEAVY_JOBS=1 && node apps/desktop/scripts/run-smokes.mjs --all` 枚举 **503 套**，原始日志位于 `apps/desktop/.tmp/smoke-runs/1792564639759-39236-kGzCub/`。并发开发中途有新增 / 尚未保存的入口，不能把全量中途观测误写成一致性的固定基线。
- **A 类根因并非同一个**：
  1. `@main/ipc/document.js` 的静态导入带入 `genofficeViewFactories` / `genofficeNativeVendor`，后者带入 GenOffice `html2docx`：`extract.ts` 用 `?raw` 把 `paragraphs-document.js` 当**浏览器脚本文本**注入。纯 Node 的 esbuild CLI 不识别 Vite 原样字符串导入，把该文件当 ESM JS 解析，顶层 `return` 必然报错；无头 IPC/Agent/MCP 测试不需要浏览器 html2docx 运行时。更近一层还可能先报尚未生成的 `genofficeSheetsEntry` / `genofficeSlidesEntry`。
  2. `registry`/执行器依赖链还会经 `RuntimeManager` 间接装入 `sherpa-onnx-node` 的平台特定 `.node` 原生扩展与 `ssh2/cpu-features`，esbuild CLI 无法将原生二进制内联；在 `/tmp` 生成 ESM 又会找不到外置的 `ssh2`。
  3. `genofficeViewFactories` 引入 `electron`，无头 ESM bundle 的 Electron CJS `require('child_process')` 报动态 require 错；旧测试桩缺少新增的 `net` 和 `protocol` 导出。
  4. `genoffice-editors-release` 的模拟 vendor 树缺少已新增要求的原生 Sheets/Slides preload 和 Rust sidecar，原 electron-builder `afterPack` 入口也已被 T19 的联合检查脚本替代。这是过期夹具与断言，不是删验证。
- **A 类修法**：只给与原生 Office 视图不相关的无头套件配置 `--alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts`（现成 fail-closed 桩），没有修改 GenOffice/vendor 或生产别名；缺失的 Electron API 仍然是“调用即抛错”桩；原生扩展以 `--external` 在可解析 `node_modules` 的私有 `.tmp` 产物里隔离。原始 GenOffice CLI、PDF 提取、IPC 和 Node-RED 实测断言保留。`genoffice-editors-release-smoke` 补最小 preload/sidecar 夹具并验证新的联合 afterPack 仍调用原 GenOffice 检查。
- **B 类两条断言判断**：`arc005-chrome-polish` 的 titlebar 已从固定 `h-10` 改成 macOS `45px`、其它 `h-10` 的响应式 `cn` 表达式；旧固定 class 字符串断言过时，现断言平台自适应逻辑，单跑 **PASS**。`design-tokens` 的 `McpToolDecisionCard` 在执行中展示 `bg-accent/10`，属于既有许可的运行态提示而非选择态泄漏，按正控白名单显式放行，保留其它扫描及负控，单跑 **PASS**。
- **追加发现**：`ipc-wiring` 旧扫描器只识别双引号 IPC 通道，实际 `documentView.ts` 合法的单引号 `ipc.on` 被误判，兼容两种引号后 45/45 PASS；`html-preview-electron` 的测试视图在 `rightOpen=false` 且 `selected=false` 下永不激活，给隔离 harness 挂载真实可见右栏后独立 **PASS**，不改产品行为；`skills-management-ui` 加回新版 UI `Badge` 导出后由“无法 bundle”恢复到真实 UI 断言阶段，后续并行开发完成时在全量运行中 **PASS**。
- **变异验证**：仅暂时撤掉 `agent-mail-smoke/run.sh` 的新增 GenOffice stub alias，立刻复现 `html2docx/...js?raw: Top-level return cannot be used inside an ECMAScript module`（并列缺失 vendor entry）；随即恢复 alias，同套 **PASS**。两条 B 类是过期断言修正，不存在可撤销的产品代码补丁；未放宽有效行为断言。
- **六套疑似并发的首次独立复跑**（`MCODE_SMOKE_JOBS=1`、重型 1）：`lsp-smoke` PASS；`market-multiprocess-smoke` PASS；`mcp-market-boundary-smoke` PASS；`automation-smoke` 超过旧 runner 240 秒预算而超时（最终控制台靠近 `self-budget-restart:10/10`，不能据此判整套通过）；`mcode-node-pack-smoke` 首次为平台 `.node` 构建错误、隔离后进入真实断言；`mcp-ipc-smoke` 首次为 GenOffice `?raw` 构建错误。随后 `mcp-ipc` 单跑 PASS；`mcode-node-pack` 在隔离构建问题和 T47 同期真实端口接线后**再次单跑 PASS**。旧 3840 / 143 不能笼统归因并发。按本机 0x1A 风险采用 **2 light + 1 heavy** 保守配置，尚未证明更高的安全并发上限。
- **自动化超时**：`run-smokes.mjs` 仅对负载特别大的 `automation-smoke` 设置有界 600 秒上限，其余套件维持原 240 秒；`node --test apps/desktop/scripts/run-smokes.test.mjs` 12/12 PASS。需以再次执行后的结果判断长超时是否足够，不能将延长本身当作通过。


- **全量首轮结果**：`503` 套完整枚举；`481 PASS / 22 FAIL`（本次全量日志上述目录，最后一份日志写入距启动约 **18.9 分钟**；日志修改时间只能估算全量耗时，不能当作 runner 精确 wall-clock）。这轮在持续并发修复过程中启动，仍包含 14 套旧构建产物失败。单独重跑这 22 项：`15 PASS / 7 FAIL`（`apps/desktop/.tmp/smoke-runs/1792565831614-31284-gsDLL4/`）；随后修正 `settings-project-race` 已升级 Card 的缺失 stub 和 `skill-delivery` 的 vendor ?raw alias 后再跑 **2 PASS / 0 FAIL**（`apps/desktop/.tmp/smoke-runs/1792568900570-25820-dHHkBC/`）。即原 22 项已有 **17 项逐套转绿**、仅 **5 项真实断言尚红**，未发生静默 SKIP。尚未对所有 503 项改动后进行第二次完整枚举，不能以分批结果冒充新的全量绿色。
- **仍红的 5 套（逐一归属，不越过测试基础设施卡的边界修改产品代码）**：`module-ui-smoke` 打开嵌套授权弹窗后没有等到带 `script` 的 alert；`node-red-theme-smoke` 主题 bootstrap 更新后 manifest version=2 断言不满足；`node-red-e2e-smoke` 105/106（当前 T42/T47 节点包接线对应原 Gate C 语义变化）；`skills-nodes-ui-smoke` 18/23，`selectedRef` 五条 `aria-current`/高亮断言仍红；`vscode-l1-smoke` Windows 未授权的可执行扩展被真实 host 的 `egress_isolation_unavailable` 硬闸拒绝，现有 UI/API 用例却期望运行。后五项分别涉及模块 UI、Node-RED 主题/节点、技能 UI、扩展隔离政策，非 T52 的 vendor bundle 或原始两条 UI 断言修复范围。不可将其称为 T52 全部验收通过。
- **六套复核收口**：`automation-smoke` 在 600 秒有界限额下于原 22 项复跑中 **PASS**；`lsp`、`market-multiprocess`、`mcp-market-boundary` 首次独立 **PASS**，`mcp-ipc`、`mcode-node-pack` 修构建问题后独立 **PASS**。保守默认 **2 light + 1 heavy**；旧默认 6+3 的同版本完整耗时没有在同一安静机器上得到可靠基线，无法给出可信的精确增量，仅记录目前 503 套约 18.9 分钟的日志时间窗口。

- **类型和 runner 验收**：`node node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json` **exit 0**；`node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json` 在减少并发后 **exit 0**（早先有一次与 503 套回归重叠、被远程进程 220 秒保护超时，不能当作类型错误）；`node --test apps/desktop/scripts/run-smokes.test.mjs` **12/12**。未改生产业务代码、未改 vendor 源码；未使用无检查的 SKIP 冒充成功。
- **验收判据与缺口**：① 原 501 套集合已增长至 503 套：首轮完整枚举，发现的构建错误全部对应补丁，旧红 22 套分批复核后不再有 bundling 红；但并非在同一最终提交状态下重新全量执行，故此条按**证据部分达成**；② 仍有上述 5 套跨域真实断言红（不能宣称 0，需其他功能卡修复）；③ 每类根因与修法已记录；④ 六套单跑/复跑已记录；⑤ 双包 typecheck PASS；⑥ GenOffice stub alias 撤销回红/恢复转绿证据已记录，未扩大到对所有修复分别做变异。
