# W22｜`t8-node-red-u1` 的包装器把「构建失败」读成 PASS

- Status: **delivered（回写已追加；改动未提交，见 `## 结果回写`；遗留：README 退出码表未更新、`--keep` 既有 bug 未修、其余 6 套共用启动器的同样兜底未动）**
- Category: **假门禁（比没有门禁更坏）**
- Priority: **P0 —— 整个 Node-RED U1 套件的门禁在这儿**
- Depends on: W5（发现者）
- 来源：W5 执行会话的报尾

## 缺陷

`apps/desktop/scripts/t8-node-red-u1/run.mjs:44`：

```js
const run = (...) => {
  const r = spawnSync(process.execPath, [...], { cwd: desktop, stdio: "inherit", env: process.env });
  return r.status ?? 1;          // ← 拿不到退出码也返回 1
};
```

`:49-60`：

```js
const normal = run([]);
if (normal !== 1) {
  console.error("T8: FAIL（期望 1；0 = 故意失败旅程变绿 = 断言被旁路，2 = 意外失败）");
  process.exit(normal === 0 ? 1 : normal);
}
console.log("T8: PASS");          // ← 拿到 1 就 PASS
process.exit(0);
```

**`1` 有两个含义：**

| 什么情况 | 退出码 |
|---|---|
| 正式旅程全绿 + 故意失败旅程按预期红（**正常**） | `1` |
| **esbuild 构建失败** | `1` |
| **`build.mjs` 崩溃/找不到** | `1`（`r.status ?? 1` 的兜底） |
| **spawn 失败（`status` 是 `null`）** | `1` |

**四种情况，一个数字。** 前一种是「PASS」，后三种是「根本没能测」。

## 为什么这是 P0

**这个仓库为这件事栽过三次**（CLAUDE.md 硬规矩二）：

- 一次 `i18n/ide.ts` 字符串未闭合，别人的 30 次采样全部白跑；
- 一次 `RightPanel.tsx` JSX 未闭合，两个会话的 `tsc` 门禁红着等；
- 2026-10-23 是第三次。

**而 CLAUDE.md 的原话是**：

> **打包期失败（`X [ERROR]` / `Unterminated string literal` / `No matching export`）不等于被测对象失败。**

**现在这个包装器连「不等于」都不做** —— 它把两者读成同一个结果。

**而且它输出的是 `T8: PASS`** —— 一句会让所有人停下来的话。

## 任务

### 一、让四种情况可区分

**核心要求：`1` 只能表示「故意失败旅程按预期红」。** 其它三种必须是**别的退出码**。

至少要做到：

| 情况 | 退出码 | 输出 |
|---|---|---|
| 全绿 + 故意失败按预期 | `1`（**保持不变**，外部脚本可能依赖它） | `T8: PASS` |
| **构建失败** | **新值**，比如 `3` | **`T8: BUILD FAILED`**（不是 PASS） |
| **`build.mjs` 崩溃** | **新值**，比如 `4` | 说清是哪一步 |
| **spawn 失败（`status === null`）** | **新值**，比如 `5` | 说清「根本没跑起来」 |

**怎么区分「构建失败」和「故意失败旅程红」**：这是本卡的核心难点。三个方向（你选并论证）：

| 方向 | 做法 | 代价 |
|---|---|---|
| **A. 让 `build.mjs` 用不同的退出码** | 构建失败退 `3`，正常退 `0`/`1` | 改 `build.mjs`，要看它现在怎么退 |
| **B. 读产物** | 检查 `journey-result.json` 或构建产物是否存在、是否解析得出 | 不解耦，但不用改构建脚本 |
| **C. 让 `build.mjs` 输出一个机器可读的哨兵** | 比如最后一行 `BUILD_OK` | 最稳，但两边都要改 |

**我倾向 A 或 C** —— B 是「用结果推测过程」，而本卡的整个教训就是「别用代理指标」。

**⚠️ 不管选哪个，必须有「构建失败」的真实样本。** 怎么造：
故意在某个被 esbuild 打包的文件里写一个语法错误（**改完立刻还原，用 `sha256sum` 核对**），
确认包装器报 `BUILD FAILED` 而不是 `PASS`。

### 二、不许改掉现有的正常语义

**「正式旅程全绿时退 `1`」这条要保持** —— W1/W2 的回写都依赖它，
外部调用方（`pnpm test:smoke`）也可能依赖。

**如果你认为 `1` 这个约定本身就是错的（0 才是成功），那要单独论证，
并且同时改所有调用方。不要只改一半。**

### 三、`r.status ?? 1` 这个兜底本身也要改

```js
return r.status ?? 1;          // ❌ null 被当成「正常」
```

`spawnSync` 的 `status === null` 意味着**进程根本没跑起来**（ENOENT、权限、被杀）。
**把它当成 1 是「把失败读成成功」。**

### 四、变异验证

| # | 变异 | 预期 |
|---|---|---|
| M1 | 在打包文件里植一个语法错误 | 包装器输出 **`BUILD FAILED`**，退出码**不是 1** |
| M2 | 把 `spawn` 的路径改成一个不存在的文件 | 输出说清「没跑起来」，退出码**不是 1** |
| M3 | 删掉那条故意失败旅程（或让它变绿） | 退出码 **0**（现有的「断言被旁路」分支），**不是 PASS** |

**M1 是本卡的核心** —— 不做它，你不知道改动真的有效。

**M1 的还原要用 `sha256sum -c` 核对**，别把语法错误留在工作区里（那会让别人的 `tsc` 红着等）。

## 验收判据

1. **四种情况可区分**，每种都有实测（不是只有代码）；
2. **正常情况仍退 `1`**（回归）；
3. **M1「构建失败」有真实样本**，走完整个包装器（不是只测 `build.mjs`）；
4. **`r.status ?? 1` 的兜底改掉了**；
5. **回写里写清：谁在依赖退出码 `1`**（`grep` 一遍）；
6. **不跑全量**；
7. **不改 `apps/desktop/src/**`**。

## 边界

**可以改：**

- `apps/desktop/scripts/t8-node-red-u1/run.mjs`
- `apps/desktop/scripts/t8-node-red-u1/build.mjs`（如果方案需要）
- 新建一个小的探针或自检脚本

**不许碰：**

- `apps/desktop/scripts/t8-node-red-u1/journeys/**`（**W5 刚改完，且它还有工作在跑**）
- `apps/desktop/src/**`
- `apps/desktop/scripts/mcode-node-pack-smoke/`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

**⚠️ 与 W5 的冲突**：W5 改了 `journeys/` 和 `editor-flow.ts` 但没碰 `run.mjs` / `build.mjs`。
**可以在它之上工作，但不要动它改过的两个文件。**

## 回写

`tasks/workflow/W22-run-wrapper-false-pass.md` 末尾追加 `## 结果回写`：

1. 四种情况各自的退出码与输出（实测）；
2. 你选的区分方案与论证（尤其「为什么不用结果推测过程」）；
3. M1/M2/M3 的实测；
4. **谁在依赖退出码 1**（`grep` 结果）；
5. **你没能验证的东西**；
6. **W5 / 这张卡上写错的地方**。

## 一条判断标准

**「构建失败」和「测试通过」在退出码上相同，那么每一次构建失败都会被记成一次通过。**

这个包装器存在的意义就是**替人判断「这一跑算不算过」**。
它现在把「跑不了」和「过了」算成同一件事 —— **那它判断的不是通过，是「跑完了」。**

## 结果回写

> 执行日期：2026-10-24 晚。未提交（工作区）。没跑全量。`apps/desktop/src/**`、`journeys/**`、
> `editor-flow.ts` 一字未动（`ls --time-style=full-iso` 核过 mtime：仍是 W5 的 20:45/20:47）。
> 改动文件：`run.mjs`（重写）、新增 `child-completion-probe.mjs`、新增 `wrapper-verdict.mjs`（判定核心 + 自检）。
> 探针/取证文件全在 `.tmp/w22/` 与 `apps/desktop/.tmp/t8-wrapper-probes/`（都被 git 忽略）。

### 一、四种情况各自的退出码与输出（实测）

**先说口径**：子进程（`electron-u1/build.mjs`）的 0/1/2/3 是**旅程结论**；包装器
把「子进程完成且退 1」翻译成 **包装器退 0 + `T8: PASS`**。卡面表格里「全绿 + 故意失败
按预期 → 1」说的是**子进程**的码；**包装器**在这种情况下的退出码一直是 **0**（旧代码
`process.exit(0)`）。这两种「1」在卡面上被混写了，见第六节。

| 情况 | 包装器退出码 | 输出（首行） | 实测样本 |
|---|---|---|---|
| 全绿 + 故意失败按预期（子进程 completed 退 1） | **0** | `T8: PASS` | R1：`--only=node-red-deliberate-failure` → 0 / PASS |
| 子进程 completed 退 0（故意失败旅程缺席/变绿 = 断言被旁路） | **1**（旧行为，未改） | `T8: FAIL（…0 = …断言被旁路…）`，无 PASS | M3 |
| 子进程 completed 退 2（意外红） | **2** 透传（旧行为） | `T8: FAIL（…）` | R2（21:53 全注册表）、21:56 全注册表 |
| **构建失败**（esbuild 编译错误） | **4** | **`T8: BUILD FAILED`** | **M1**（真语法错误，走完整包装器） |
| **构建脚本崩溃**（build.mjs 自身 throw / 找不到 / 没走完） | **5** | `T8: BUILD CRASHED（…）+ 具体原因` | M2a、R3 |
| **spawn 失败**（`status === null`） | **6** | `T8: SPAWN FAILED（根本没跑起来：ENOENT）` | M2c |

**为什么是 4/5/6 而不是卡面示例的 3/4/5**：`electron-u1/build.mjs` 的退出码已经用到
0/1/2 与 **3**（自检失败：`process.exitCode = 3`）。若包装器也用 3 表示构建失败，
「自检失败」与「构建失败」又共用一个数字 —— 正是本卡要消灭的形态。4/5/6 与 0–3 无交集。

**`r.status ?? 1` 已删除**（`grep "?? 1" run.mjs` 只剩注释里讲历史的引用）。`status === null`
现在直接落到 `spawn-failed`（退 6），不再被读成「预期红」。

### 二、区分方案与论证：完成探针（事件），不是读产物（代理指标）

**选的是 A/C 之外的第四条路：在子进程里注入一个「完成探针」**（`node --import`，
不改 `build.mjs` 一个字节）。它记录三个进程级事件：

| 事件 | 语义 |
|---|---|
| `beforeExit` | **只在事件循环自然排空时触发** —— 即「构建脚本把话说完、给出结论」 |
| `uncaughtExceptionMonitor` | 记录崩溃（不吞异常、不改退出码；进程行为与无探针时完全一致） |
| `exit` | 最后同步落盘 `{completed, exitCode, crash}` |

于是判定变成：**`completed === true` → 子进程的退出码是「结论」；否则是「没跑完」。**
没跑完再按崩溃消息分「esbuild 编译失败」（`Build failed` 文案 或 Error 上的 `.errors`
数组 —— esbuild `failureErrorWithLog` 的 API 契约）与「其它崩溃」。

**为什么不用 B（读 `journey-result.json`/产物推测）**：那是「用结果推测过程」，本卡
的整个教训就是代理指标会在没想到的输入上失效（CLAUDE.md 二十八）。而且 B 有真实
反例：构建失败时**产物可能是上一轮的**（`--only` 跑、或 `.tmp` 里残留），文件存在
不证明这次构建成功；反过来「构建成功但某条旅程在写结果前崩了」也会让 B 误判。
`o2-conflict-u1/run.mjs` 的头注释记录了同一教训（它第一版把 exit 1 读成预期红，
真因是 esbuild 连 journeys.cjs 都没打出来）—— 它选了「读 summary」，那是它的场景
（有独立的结论文件）；本套件的 summary 同样由 build.mjs 在**最后**写，构建期崩溃
根本走不到，所以 B 在本套件能挡住的只有一部分，且仍有「读到上一轮产物」的窗口。
探针是**直接记录「进程走完了没有」这件事本身**，没有这些窗口。

**为什么不用 A（让 build.mjs 用不同退出码）**：`electron-u1/build.mjs` 被 **7 套**
共用（o0/o2/t7/t8/t29/t30/t46），改它的退出码要同时改 6 个调用方；而且它自己的
`process.exitCode = 3` 已被占用。探针只影响 t8 自己的子进程（经 `--import` 注入），
**零共享改动**。

**一个机制事实（本机实测，Node v22.21.1，`node --import` + ESM 入口）**：
`beforeExit` 在「自然结束（含 `process.exitCode = N` 收尾）」时触发，在
「未捕获异常」与「显式 `process.exit()`」时不触发。`build.mjs` 正常路径全部以
`process.exitCode = …` 收尾 → 能触发。原型矩阵（五种进程形态）与真实 build 的
7 份探针落盘都验证了这一点。探针本身不依赖 `argv`/工作目录；`--import` 对 CJS
入口也有效（原型里实测过）。

**判定逻辑没有抄在 `run.mjs` 里**：它在 `wrapper-verdict.mjs`，`run.mjs` import 真身；自检脚本
（`node scripts/t8-node-red-u1/wrapper-verdict.mjs`）也 import 同一份。自检 11 条
（含一次**真实**的 `spawnSync` ENOENT 测量，不是手写返回形状），并钉住硬性质
「非 completed 的 kind 永不映射到 0–3」。

### 三、M1 / M2 / M3 的实测（先写预期，跑完对比）

预期写在 `.tmp/w22/predictions.md`（跑之前）。

| # | 变异 | 预期 | 实测 |
|---|---|---|---|
| **M1** | `fixtures.ts`（被 esbuild 打包的文件）植入未闭合字符串 | 新包装器 4 / `BUILD FAILED` / 无 PASS；旧包装器 0 / `T8: PASS` | **新 4 / BUILD FAILED；旧 0 / `T8: PASS`**（同一份错，旧包装器退 0 —— 假门禁坐实）。变异态 sha `c544d4a4…`；**还原后 `sha256sum -c` 与 pristine 逐字节一致**（`6101d9a9…`） |
| M2a | 迷你树（真身字节复制的 run.mjs + 兄弟目录缺 build.mjs） | 5 / BUILD CRASHED（说 Cannot find module）；旧 0 / PASS | 5 / `Cannot find module …`；**旧 0 / `T8: PASS`**（stderr 里 ERR_MODULE_NOT_FOUND） |
| M2b | 迷你树：假 build.mjs 自杀 SIGKILL | 5 / BUILD CRASHED（探针无落盘）；旧 0 / PASS | **5** / 「没有拿到完成探针的落盘结果」；**旧 0 / `T8: PASS`**。⚠️ 机制事实：**Windows 上被 SIGKILL 的子进程 `spawnSync.status` 是 `1` 不是 `null`**（实测 `kill-shape.mjs`）—— 这就是为什么不能靠退出码分；探针「无落盘」把它归为没跑完（fail-closed） |
| M2c | 真包装器 + `process.execPath` 指向不存在的文件（真 `status === null`） | 6 / SPAWN FAILED | **6** / `T8: SPAWN FAILED（正常跑：根本没跑起来：ENOENT）` |
| M3 | `--only=node-red-canvas-build-from-scratch`（子进程 completed 退 0 = 故意失败旅程缺席 → 断言被旁路分支） | 1 / FAIL / 无 PASS | **1** / `T8: FAIL（期望 1；0 = …断言被旁路…）` / 无 PASS。⚠️ **卡面写「退出码 0」是错的**（旧代码就是 `process.exit(normal === 0 ? 1 : normal)` → 1），见第六节 |
| R1 | `--only=node-red-deliberate-failure`（子进程退 1 = 正常语义） | 0 / PASS | **0** / `T8: PASS`（回归 ✓） |
| R2 | 全注册表 | 子进程结论透传 | 21:53 跑：子进程退 2（baseline-deploy 红，W5 在途）→ 包装器 **2** / FAIL；21:56 同类 → 2 透传。探针记录 `completed=true, exit=2` ✓ |
| R3 | `--keep`（build.mjs 抛 `Unknown option: --keep` —— 既有 bug，见第六节） | 5 / BUILD CRASHED；旧 0 / PASS | 新 **5** / `T8: BUILD CRASHED` + `Error: Unknown option: --keep`；**旧 0 / `T8: PASS`** |
| R4 | `--only=node-red-deliberate-failure --mutation`（变异分支） | 正常跑 0→PASS，变异跑 0→0 | 正常跑 child 1 → PASS 退 0；变异跑 child 0 → 退 0 ✓ |
| 自检变异 | 把 `wrapper-verdict.mjs` 的 `if (run.probe.completed !== true)` 改成 `if (false)`（「永远当没崩」） | 自检必须红，且红的恰是那 4 条 `completed:false` 用例 | **7/11，红 4 条，正是 esbuild×2 + crash + 显式 exit**；还原后 `sha256sum -c` OK、11/11 |

**M1 的还原保全**：变异脚本 `finally` 里无条件写回原始字节，并用开始时记录的
`sha256sum` 核对（不匹配则脚本退 3）；两次 M1（含旧包装器补录）结束后都跑了
`sha256sum -c .tmp/w22/fixtures.sha` → OK。变异窗口每次 < 10 秒（两次构建，各约 4.9s）。

### 四、谁在依赖退出码 1（grep 结果，重搜过的完整范围）

原始 grep 记录：`.tmp/w22/grep-exit-code-consumers.txt`。搜索覆盖：全仓
（排除 node_modules/.tmp/.git/dist/out）的 `*.md/*.sh/*.mjs/*.js/*.ts/*.py/*.json/*.yml`、
`apps/desktop/package.json`、根 `package.json`、`turbo.json`、`.github/workflows/*`、
`run-smokes.mjs`、`smokes-for.{sh,py}`、`.claude/skills/mcode-smoke/`。

**可执行消费者 —— 只有 1 个：**

| 消费者 | 它依赖什么 | 新包装器下还成立吗 |
|---|---|---|
| `apps/desktop/scripts/t8-node-red-u1/negative-control.sh:28` | **只依赖「非 0」**（`if code -eq 0 → 负控 FAIL`），不依赖具体是 1；用 `PIPESTATUS[0]` 取码 | 成立。且更好：构建失败从「旧=0（负控报『正式旅程仍是绿的』——归因错）」变成 4/5/6，脚本会在核对失败步骤那一步如实 FAIL（找不到 evidence/步骤名不符） |

**没有其它可执行依赖：**

- `run-smokes.mjs` 的套件发现规则是 `^[a-z0-9]+(?:-[a-z0-9]+)*-smoke$` ——
  `t8-node-red-u1` **不以 `-smoke` 结尾，永远不会被 `pnpm test:smoke` / `test:all` 发现**；
- `package.json`（根与 desktop）零引用；`smokes-for.{sh,py}` 零引用；
  `.github/workflows/*` 零引用（CI 跑的是 workflow-ui-smoke 等 4 套 + `test:all`）；
- `docs/testing.md`、`AGENTS.md`、`.claude/skills/mcode-smoke/SKILL.md` 零引用；
- 全仓 `T8: PASS` 只有 README（文档）与套件自身。

**文档/任务卡里的「依赖」（不是可执行依赖，但会误导人）：**
`README.md:9,22`（说「正常跑期望退出码 1」，实际包装器是 0 —— 它把子进程码当成了包装器码）；
`tasks/T8-node-red-electron-u1.md:27`（写「期望 run.mjs 退出码 0」，**这条是对的**）；
W0/W1/W2 的回写（把「包装器退 1」当作 `--only` 跑的正常结果 —— 与旧代码一致，新代码不变）。
**README 的退出码表需要更新（我没改：不在本卡可写边界内），见第五节。**

### 五、我没能验证的东西（如实）

1. **没在「全注册表全绿」状态下实测「子进程退 1 → 包装器 0 + PASS」的完整跑**。
   原因：工作区里 W5 的 `baseline-deploy` 改动在途（21:53 实测该旅程红），21:56 之后
   另一个会话的在途改动（`mcodeNodeTypes.ts` 加了 `mcode-condition-eval` 类型，
   `htmlByType` 没同步 → `TypeError: htmlByType[type] is not a function`，全部 4 条
   旅程在 Electron 启动期崩）让全注册表稳定为「4 红」。这个分支我用
   `--only=node-red-deliberate-failure` 精确覆盖了（R1：child 1 → 0/PASS）——
   **包装器这一层的判定与 `--only` 无关**，但「全注册表版本」我没跑到。
2. **`negative-control.sh` 端到端没重跑**：负控要求「红在 `deploy-wrote-native-flows`」，
   而当前在途改动让旅程在更早的地方就红（或根本起不来），跑了也只会得到「红的步骤
   不是它」的 FAIL —— 不是负控失效，是环境不在可判状态。它的取码方式（`PIPESTATUS[0]`、
   只判非 0）我逐行读过，新码下成立。
3. **`--mutation` 全注册表版没跑**（同上，W5 在途让正常跑期望不是 1）；变异分支用
   `--only=node-red-deliberate-failure --mutation` 走完了（R4）。
4. **`--keep` 是既有 bug 不是本卡引入**：`run.mjs` 把 `--keep` 透传给
   `electron-u1/build.mjs`，而它的参数解析**不接受 `--keep`**（其头注释写着「保留它是
   为了显式声明」，但解析分支里没有）→ `Unknown option: --keep`。旧包装器把这个崩溃
   读成 `T8: PASS`（R3 实测），新包装器如实报 BUILD CRASHED（5）。**本卡没修这个
   bug**（`build.mjs` 不归我改；且 `--keep` 在 t8 的语义本来就是空操作）。建议单开卡：
   要么删掉 `run.mjs` 的 `--keep` 透传，要么给 `build.mjs` 补上这个分支。
5. **探针的能力边界**：`beforeExit` 语义在 Node 主版本升级时可能变化；探针只经
   `--import` 注入 ESM 入口（本套件 `build.mjs` 是 ESM）。若将来 `build.mjs` 被包一层
   CJS 启动器，需要换注入点 —— `wrapper-verdict.mjs` 的自检会在「探针无落盘」时
   fail-closed 成 BUILD CRASHED（不会变成 PASS），但那是「退化」不是「崩」。
6. **`electron-u1/build.mjs` 被 7 套共用**，我一行没动；因此 o0/o2/t7/t29/t30/t46 的
   `r.status ?? 1` 兜底**仍然存在**（它们的 run.mjs 我没改）。它们是同样的病，但不在
   本卡边界内 —— 记录在此，供总控决定是否单开卡。

### 六、W5 / 这张卡上写错的地方

1. **卡面表格把「子进程退出码」与「包装器退出码」混写了**。第 69 行
   「全绿 + 故意失败按预期 | `1`（**保持不变**）」—— **子进程**退 1，**包装器**退 0
   （旧代码 `process.exit(0)`）。W1 的回写（「套件内部退 0、包装器必退 1」）指的是
   `--only` 场景（child 0 → wrapper 1），与全注册表场景（child 1 → wrapper 0）是两个
   方向。**「包装器退 1」从来都不是正常结果**；README:9 的「正常跑期望退出码 1」同样
   是错的。（我按实际行为实现：child 1 → 0/PASS、child 0 → 1/FAIL。）
2. **M3 的预期写错**：卡面说「删掉故意失败旅程 → 退出码 **0**」，实际旧代码就是
   `process.exit(normal === 0 ? 1 : normal)` → **1**。我保持了这个旧行为（不动它，
   因为外部文档都按「0 = 断言被旁路 → FAIL」读）。实测 M3 = 1 / FAIL / 无 PASS ✓。
3. **W5 的回写有一处归因风险**（不是它的错，是它的观察范围）：它说「`run.mjs` 把子进程
   退出码 1 当作 PASS」——准确说是「把**任何** 1（含构建失败）当作 PASS」。这个差别
   决定了修复方向：不是「别把 1 当 PASS」，而是「先确认 1 是哪来的」。
4. **卡面「`:44` 的 `r.status ?? 1`」位置准确**（旧文件 44 行），缺陷描述其余部分
   （`1` 的四种含义）我也逐条复现了：M1（esbuild 失败=1）、M2a（找不到 build=1）、
   M2b（被杀在 Windows 上也是 1）、R3（build.mjs 参数崩溃=1）。**「spawn 失败 status=null」
   在 Windows 上比卡面想的更少见** —— 被 SIGKILL 时 status 是 1，不是 null（实测），
   所以探针的「无落盘」判据比 `status === null` 更宽、更可靠。
5. **卡面漏了一类**：`build.mjs` 的退出码 **3**（自检失败：故意失败旅程没按预期红 /
   变异没生效）。旧包装器把它当 `normal !== 1` → `process.exit(3)`，输出归到「期望 1」
   那段文案（误导）。新代码保留 3 的透传但文案仍写「期望 1；…2 = 意外失败」——
   **3 的情况没有专属解释文案**，这是我没做的小遗留（影响：看日志的人要从
   build.mjs 的 `U1 SELF-CHECK FAILED` 行自己判断）。改它只需一行 `console.error`，
   但要动「失败文案」这段既有措辞，我选择了不动。

## 总控验收（2026-10-24，工作流总控）

**结论：通过。而且它是这批卡里我独立复现证据最硬的一张。**

### 我独立复现了 M1（不是看它的报告）

在同一份真语法错误（往 `child-owner.ts` 尾部植 `const __w22broken = "unterminated`）下：

| 包装器 | 退出码 | 输出 |
|---|---|---|
| **旧**（`git show HEAD:...run.mjs`） | **`0`** | **`T8: PASS`** |
| **新** | **`4`** | **`T8: BUILD FAILED`** |

**这就是假门禁的证据**：同一份坏代码，旧包装器说「通过」。
还原后 `sha256sum -c` 逐字节一致，临时文件已删，`git status` 干净。

另外我自己跑了它的自检：`node scripts/t8-node-red-u1/wrapper-verdict.mjs` → **PASS 11/11**（含一次真实 ENOENT 测量）。

### 它的方案比我卡上给的三个都好

我在卡里给了 A（改构建脚本退出码）/ B（读产物）/ C（哨兵）三个方向，并说「B 是代理指标，别用」。

**它三个都没选，换了判据**：往子进程注入完成探针（`child-completion-probe.mjs`），
按「`beforeExit` 有没有触发」判断**进程有没有自然走完**。

**这比三个都好**：
- 不是读产物推测（避开 B）；
- 不用改构建脚本（避开 A 的耦合与 C 的两边改）；
- **是直接记录**。「进程自然走完」和「进程崩了」在 `beforeExit` 上必然不同，
  而在退出码上必然相同 —— **这正是 W5 撞上的那个歧义**。

**降级方向也是安全的**：esbuild 改了文案，最坏从 4 变 5，**仍是「没跑完」，永远不会变成 0/1**。
它还把这条写成了自检里的硬性质断言：**非 `completed` 的 kind 永远不映射到 0–3**。

### 它纠正我两处，都对

1. **我把「子进程退出码」和「包装器退出码」混写了。**
   旧的 `run([])` 返回值是子进程的 `1`，而包装器**自己退 `0`**（`process.exit(0)`）。
   我卡上写「正常时退 1」，于是让整张卡去找「谁依赖退出码 1」——**而那个依赖根本不存在**。
   它全仓重搜了一遍，可执行依赖只有 `negative-control.sh`（只判非 0，用 `PIPESTATUS[0]`）。

2. **M3 的预期我写错了**（我写 0，实际旧代码就是 1）。它照实记了。

### 它报的三条遗留，我怎么处理

1. **`README.md` 退出码表过时** → **我已改**（那是文档说谎，且不在它的可写边界）。
   现在写清了：子进程 0/1/2/3 与包装器 0/4/5/6 是**两套**，且明确说「子进程退 1 时包装器退 0」。
2. **`--keep` 是既有 bug**（透传给 `build.mjs`，后者拒收 → 旧包装器也读成 PASS）
   → **成立，但不在本卡范围**。它现在会被新包装器归到 `build-crashed`（5），**至少不再是 PASS**。
   开一张卡记着（W24）。
3. **其余 6 套共用 `electron-u1/build.mjs` 的 `?? 1` 同病** → **同源问题，一并进 W24**。

### 一条我核实后发现不是它的问题

我跑全量包装器时得到 `T8: FAIL`（退出码 2）。**不是 W22 的回归** ——
日志显示三条旅程全崩在 `Error: Missing Node-RED node locale: en-US/mcode-condition-eval`，
那是 **W17 在途改动**（它加了新节点类型，locale 还没补）的中间态。
已发消息提醒 W17。**这条我按 CLAUDE.md 第二十四条处理：先问「提交了吗、编译得过吗」，没当成缺陷。**
