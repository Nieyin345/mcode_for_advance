# T68｜smoke 基线复查：四套旧红例

| 项目 | 值 |
|---|---|
| 编号 | T68 |
| 类型 | **测试基础设施** |
| 优先级 | 中 —— 四套已坏，说明那四块的验证是假的 |
| 建议并发 | 只改 `apps/desktop/scripts/`；**与 T61/T67 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **T61 已完成**：它在跑 116 套时发现了这四条。
- **T67 可以先做**（它修的是其中一条的根因）。

---

## 四条红（T61 实测，不是转述）

| 套件 | 现象 | 判断 |
|---|---|---|
| `app-control-smoke` | 569/570，catalog 缺 `workflowEngine.load` | **→ T67 已覆盖** |
| `automation-smoke` | 旧 `--alias:node:fs` 连带破坏 `node:fs/promises` 的解析 | 构建配置 |
| `event-vertical-smoke` | sherpa 平台 `.node` 原生模块未外置 | 构建配置 |
| `orchestration-ipc-smoke` | 既有工作流字段/出厂更新标记断言红（430/433） | **待定性** |

**T67 修第一条。本卡修后三条。**

---

## 为什么这四条值得单独一张卡

T61 说得很清楚：

> 这些套件没有引用新共享 `electron.ts`，未越界替其它任务修它们。

**它们不是 T61 造成的，是早就坏的。**

而 T52 当时跑出「481/503 PASS」，说明**这四套当时可能也是红的**，
只是没人逐个看。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/.claude/skills/mcode-smoke/SKILL.md` —— **全文**。
3. `apps/desktop/scripts/automation-smoke/run.sh` —— `--alias:node:fs` 那条。
4. `apps/desktop/scripts/event-vertical-smoke/run.sh` —— sherpa 那条。
5. `apps/desktop/scripts/orchestration-ipc-smoke/` —— 430/433 那三条断言。
6. `apps/desktop/scripts/genoffice-native-view-smoke/run.sh` ——
   **T28/T42 之后建的套件怎么处理 GenOffice 依赖**，照它。
7. `apps/desktop/scripts/run-store-smoke/stubs/electron.ts` —— T61 新建的那个。

---

## 执行内容

### 第 1 步：三条逐一实跑，先看真实错误

```bash
bash apps/desktop/scripts/automation-smoke/run.sh 2>&1 | head -40
bash apps/desktop/scripts/event-vertical-smoke/run.sh 2>&1 | head -40
bash apps/desktop/scripts/orchestration-ipc-smoke/run.sh 2>&1 | head -40
```

**不要相信卡里的描述，以实测为准。**

### 第 2 步：`automation-smoke` 的 alias 问题

T61 说：

> 旧 `--alias:node:fs` 连带破坏 `node:fs/promises` 的解析

**这是 `mcode-smoke` skill 里写的那个坑的变种**：

> `--alias` 只认包名，相对 import 换不掉

`node:fs` 和 `node:fs/promises` 是**两个不同的模块说明符**。
alias 了前者，后者还是真模块 —— 两边行为不一致。

**要查**：

- 为什么 alias `node:fs`？（谁需要桩？）
- 能不能改成 alias 更精确的东西？

### 第 3 步：`event-vertical-smoke` 的 sherpa

原生 `.node` 模块 esbuild 打不进去。

**照 `genoffice-native-view-smoke` 的做法**：加 `--external:sherpa-onnx-node`。

**但要确认**：这个套件的断言路径**真的不调用 sherpa** 吗？
如果调用了，`--external` 会让它在运行时失败。

### 第 4 步：`orchestration-ipc-smoke` 的三条断言

430/433，**三条红**。

T61 说是「既有工作流字段/出厂更新标记断言红」。

**要判断**：

- 产品真的退化了？（那要修产品）
- 还是断言过时了？（那要修断言）

**这是本卡唯一需要判断「产品 vs 断言」的一条。**

### 第 5 步：确认没有第五套

```bash
node apps/desktop/scripts/run-smokes.mjs --all 2>&1 | grep "^FAIL"
```

**跑全量**，看现在到底有几套红。

**注意**：跑之前确认没有任务在跑 Electron 探针
（`tasks/README.md` 里记了这条规则）。

---

## 边界（不要碰）

- **只改 `apps/desktop/scripts/`**（除非第 4 步确认是产品退化）。
- 不改断言的语义（改形状让它匹配新实现可以，删断言不行）。
- 不改 `packages/contracts/`。
- 不改 T67 的 catalog。

---

## 验收判据

1. `automation-smoke` 全绿。
2. `event-vertical-smoke` 全绿。
3. `orchestration-ipc-smoke` 全绿，**或**有明确的「这是产品退化」的结论 + 记录。
4. 全量跑一次，**失败套件数写进回写区**（不是「应该全绿」，是实际数字）。
5. 双包 tsc 干净。
6. **变异验证**：对每条修好的，撤掉修复 → 该套件重新红。

---

## 回写区要回答

- 三条的真实错误分别是什么？
- `automation-smoke` 的 `--alias:node:fs` 是谁加的？为什么？
- `event-vertical-smoke` 外置 sherpa 后，断言路径真的不调用它吗？
- `orchestration-ipc-smoke` 那三条是产品退化还是断言过时？
- 全量跑的结果是多少套红？除这四条还有别的吗？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 T68 执行实证（E1 动态 smoke + 变异，E2 源码归因）

- 开工 HEAD `64179174f6a3f5d56dc573425490597cb4a9a68b`。只修改 T68 负责的三个 smoke 与确证缺陷 `apps/desktop/src/main/orchestration/library.ts`；没有触碰 T67 catalog / `packages/contracts`。并行会话在执行期间改动了 contracts、appControl、modules 与 renderer，最终全量输出不能当作单一稳定版本的独立绿灯。
- 本机是 Windows；直接 `bash` 命中 WSL shim，且三份脚本的 checkout 为 CRLF，故首次入口报 `set: pipefail\r: invalid option name`。将目标脚本工作树换行归一 LF，并在 `apps/desktop` 工作目录使用 `D:\\anaconda1\\Library\\usr\\bin\\bash.exe` 实跑，此环境问题才排除。
- **automation 原红**：esbuild 把 `node:fs/promises` 误映射为 `./scripts/automation-smoke/stubs/fsSync.ts/promises`，报 `Could not resolve`。查 `git log --follow -- apps/desktop/scripts/automation-smoke/run.sh`：`--alias:node:fs` 由 `858349e1`（2026-10-13 ARC-005 durable 提交）引入，专为 `stubs/fsSync.ts` 拦截 `store/db.ts` 的同步 `openSync(.persist-..., "wx")`，注入 EIO 以验证失败回滚，不能粗暴移除。修法是将更精确的 `--alias:node:fs/promises=fs/promises` 放在 `--alias:node:fs=...` 前，保留同步故障桩和真实 promises；导入图还会拉入 sherpa 原生 addon，另加 `--external:sherpa-onnx-node`。**绿**：`automation-smoke:820/820`，新进程回读 `self-budget-restart:10/10`，整体 exit 0。
- **event-vertical 原红**：esbuild `No loader is configured for ".node" files`，来自 `sherpa-onnx-node/addon-static-import.js` 的各平台原生 addon；在 main bundle 加 `--external:sherpa-onnx-node`。其测试入口 `scripts/event-vertical-smoke/main.ts` 没有直接 sherpa/voice/audio 调用；外置后在真实 Node 中 **26 passed, 0 failed**，证明本套断言运行路径没有实际加载或调用 addon（否则会在运行时报错）。
- **orchestration 原红**：`430/433`，三条是「干净文档保存后不凭空多出字段」和「刚播种的自带行无更新标记」「用户改过但出厂版未变不提示」。前一条属于**过时断言**：`WorkflowRepo.parseWorkflowDoc` 合法归一可选 `engine:"mcode"`，修断言为已知契约键集加 engine 并校验确为 mcode，不放宽其他字段。后两条属于**真实产品退化**：读取时补默认 engine，但 `shippedContentRevision` 把补出来的 engine 也参与出厂内容 hash，导致未变化的出厂版误提示更新；在共同 hash 实现比较前将 `engine === "mcode"` 归一成缺省。**绿**：`orchestration-ipc-smoke:433/433`。
- **变异验证**：撤掉 automation 的 `fs/promises` 精确别名 → 重新在构建期报 `fsSync.ts/promises`；撤掉 automation 和 event 各自的 sherpa external → 各重新报 `.node` loader；撤掉 `shippedContentRevision` 默认 engine 归一 → 上述两条出厂更新断言重新红；把 orchestration 字段断言改回旧比较 → 字段断言重新红。每条撤销后均重新应用修复，目标文件 diff 仅剩预期改动。
- **双包 tsc**：`packages/contracts` 在两次检查中均 PASS；`apps/desktop` 在检查时 FAIL，第一次为非 T68 的 app-control / session-store / HooksPanel 共七条错误，第二次（并发改动后）缩到 `src/renderer/components/ide/FileEditor.tsx:2653` 的 `useGitStore` 未定义与参数隐式 any 两条。**验收第 5 条未达成**，未越权修改其他任务文件。
- **全量 smoke 命令**：`MCODE_TEST_BASH=D:\\anaconda1\\Library\\usr\\bin\\bash.exe`、`MCODE_SMOKE_JOBS=2`、`MCODE_SMOKE_HEAVY_JOBS=1` 环境下跑 `node apps/desktop/scripts/run-smokes.mjs --all`，在启动时检查无用户项目 Electron 探针进程；实际失败数及其他失败名单在本回写末尾补充。全量中已观察 T67 `app-control-smoke` PASS，T68 `automation-smoke` / `event-vertical-smoke` PASS。其他红例包括 Windows `-V 系统找不到指定的文件`、MSYS `ln ... node_modules: Device or resource busy` 与并行修改中的 `capability-smoke` 主机声明不一致，**不能据此宣称整个项目绿灯**。

- **全量实测终局**：`node apps/desktop/scripts/run-smokes.mjs --all` **exit 1，510 suites = 450 PASS / 60 FAIL**；日志在仓库根 `.tmp/t68-all-smokes.log`。全量输出中 `app-control-smoke`、`automation-smoke`、`event-vertical-smoke`、`orchestration-ipc-smoke` 均明确 PASS；其他红例**确实存在，不能说全量通过**。60 条失败套件原名：
  `aoci-index-smoke, arc005-file-picker-error-smoke, arc005-focus-ownership-smoke, arc005-gesture-runtime-smoke, arc005-library-picker-search-smoke, arc005-picker-layer-smoke, arc005-recorder-input-smoke, archiver-installer-smoke, capability-smoke, claude-ipc-smoke, codex-effort-smoke, design-tokens-smoke, document-router-smoke, document-view-renderer-smoke, emit-path-smoke, engine-bootstrap-integrity-smoke, engine-secret-integrity-smoke, engine-secret-path-safety-smoke, flow-migration-smoke, flow-snapshot-isolation-smoke, genoffice-mcp-smoke, library-adopt-smoke, library-delete-smoke, library-entry-path-smoke, library-import-smoke, library-mcp-smoke, library-move-smoke, library-pdf-writeback-host-smoke, library-trash-smoke, maint-c-followup-smoke, maint-m33-smoke, maint-m35-smoke, mc035-egress-isolation-smoke, mcode-admin-smoke, mcp-endpoint-smoke, mcp-ipc-smoke, md-image-guard-smoke, memory-codex-smoke, module-extension-lifecycle-smoke, module-permissions-smoke, module-protocol-integrity-smoke, pdf-annotation-smoke, pdf-highlights-integrity-smoke, pdf-import-atomic-smoke, projects-ipc-smoke, provider-health-smoke, relay-smoke, resume-fault-smoke, remote-ssh-smoke, settings-panel-smoke, skill-delivery-smoke, settings-panels-electron-smoke, theme-ipc-smoke, updater-tools-smoke, vscode-l1-smoke, workflow-engine-bridge-smoke, workflow-engine-runtime-smoke, workflow-engine-selection-smoke, workflow-extension-seams-smoke, workflow-native-load-smoke`。
  失败来自环境（Windows sh/ln）、并行代码变动及其他模块问题的混合，此轮**未独立逐套复核 60 个根因**，不能将全部 60 个武断归为环境故障或 T68 回归。
- **最终 tsc 复核更正**：并行编辑一度造成 desktop typecheck 7 条、后 2 条临时红例；本次末尾从仓库根重跑 `node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json` **exit 0 PASS**，`node node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json` **exit 0 PASS**。因此以**最终复核**为准，验收第 5 条已达成；早前红例仅作为不稳定工作树证据保留。
- **T68 判据最终状态**：① automation 820/820+10/10 PASS；② event 26/26 PASS；③ orchestration 433/433 PASS；④ 已完成全量并记录实际 60 失败；⑤ 双包 tsc 最终 PASS；⑥ 所有修复均做了撤销→红→恢复，PASS。**六条均达到 T68 任务卡明定判据；但仓库整体 60 套红未关闭，不可扩张为全项目验收。**
