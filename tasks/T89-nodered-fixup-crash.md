# T89｜Node 22.21.1 的 `fs.cpSync` 在中文路径上崩溃（上游回归，不是仓库缺陷）

- Status: delivered（套件已修，见「结果回写（二）」；`dataRoot` 的 P0 留给 T90）
- Category: **既有故障（不是今天引入的）**
- Priority: **P1** —— 两套 node-red 许可套件一直"失败"着，但被误判成环境问题
- Depends on: 无
- Exclusive writable files: `apps/desktop/scripts/t10-node-red-pause-license-smoke/main.cjs`、`apps/desktop/build/stage-node-red-resources.cjs`（**先只读定位，找到根因再决定改哪**）

## Required Skills
- `mcode-smoke`：崩溃定位。
- `diagnosing-bugs`：native 崩溃的排查。

## 背景：全量里两个 `exit=127` 被误判成「并发偶发」

第一次全量结果：

```
FAIL  t10-node-red-pause-license-smoke     (exit=127)
FAIL  t88-node-red-license-closure-smoke   (exit=127)
```

**B 判成「并发偶发」，理由是「单跑 exit=0、全绿」。这个结论是错的。**

### 真实情况（总控用探针定位）

```js
// spawnSync，不是 bash 的 $?
{ status: 3221226505, signal: null, okLines: 3, stderr: "" }
```

`3221226505` = `0xC0000409` = **`STATUS_STACK_BUFFER_OVERRUN`** —— Windows 的进程 fast-fail 崩溃。

**`/usr/bin/bash` 把 `>= 128` 的退出码当信号，所以显示成 127。**

### 精确定位

在 `main.cjs` 里插两行 stderr 标记，跑完逐字节还原：

```
[STEP-A] before makeReleaseTree     ← 打印了
                                     ← [STEP-B] 没打印
status: 3221226505
```

**崩在 `makeReleaseTree(mappedRoot, SOURCE_MANIFEST)` 里面**（`main.cjs:208`）。

### 为什么它特别难查

**加了三个处理器，一个都没触发**：

```js
process.on("exit", ...)
process.on("uncaughtException", ...)
process.on("unhandledRejection", ...)
```

**stderr 完全空。** 这是 **V8/Node runtime 在进程内部直接 fast-fail**，JS 层看不到。

## ⚠️ 2026-10-24 根因已定位（总控 + B，两方独立复现）

**不是「`materials` 这棵树有问题」，是「绝对路径太长」。**

总控的对照实验（同样的 `pause` 目录内容，只改路径长度）：

| 路径 | 长度 | 结果 |
|---|---|---|
| 原路径 `<repo>/apps/desktop/build/vendor-licenses/node-red/materials/pause` | **104** | **status=3221226505 崩溃** |
| 短路径副本（`%TEMP%/s2-xxx/pause`） | **50** | status=0 OK |
| `materials` 目录本身 | **98** | **status=3221226505 崩溃** |

**同样的内容、不同的路径长度 → 一个崩一个不崩。**

### 为什么这台机器特别容易踩

```
D:/副桌面/文件夹/work_space/work_for_reseach/mcode/apps/desktop/build/vendor-licenses/node-red/materials/pause
```

**前缀本身就 104 字符，且含中文。** `cpSync` 内部走 `toNamespacedPath()`（`\\?\` 前缀），长路径 + 中文的组合触发 `0xC0000409`。

### 🎯 最终结论（B 的跨版本对照，总控独立复现）

**不是「路径长度」，是「中文路径」。**

B 的 3 行最小复现：

```js
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
fs.mkdirSync(path.join(base, '副桌面'), { recursive: true });
fs.writeFileSync(path.join(base, '副桌面', 'a.txt'), 'hi');
fs.cpSync(path.join(base, '副桌面'), path.join(base, 'out'), { recursive: true });
// → 进程直接死，stderr 空
```

**跨版本对照（总控独立跑，结果完全一致）**：

| Node 版本 | 结果 |
|---|---|
| **v22.21.1** | **`status=3221225477`（`0xC0000005` ACCESS_VIOLATION）崩溃** |
| v22.14.0 | `status=0` OK |
| v20.18.0 | `status=0` OK |

**同样的代码、同样的中文路径，只有 22.21.1 崩。**

**这是 Node 上游的回归，不是本仓库的代码缺陷。**

### 排除的所有其它假设（B 逐个做过实验）

| 假设 | 实验 | 结论 |
|---|---|---|
| 数据太大 | `@node-rs` 只有一个 **1074 字节**的文件，照样崩 | ❌ |
| `@` 符号 | 合成 `@scope/pkg` 目录 cpSync **正常** | ❌ |
| 目录太深 | 同样的树**手工复制到临时目录**后 cpSync **正常** | ❌ |
| `copyFileSync` 也有问题 | 在中文路径上 **OK** | ❌ |
| 路径长度 | **同一棵树放英文临时目录 OK、放 `副桌面/文件夹/` 崩** | ❌（是中文不是长度） |
| **中文路径** | **同上** | ✅ |

## 处置：**不要改代码**（B 的判断，总控认可）

**三个候选方案都被否掉**：

| 方案 | 为什么不行 |
|---|---|
| 1. Node 降到 22.14.0 | `package.json` 要求 `>=22.19.0`，**降级低于要求** |
| 2. 仓库移出中文路径 | 动所有人的环境，而且**用户的路径本来就可能含中文** |
| 3. 套件里换手写递归 | **把「Node 升级后自动会好」的 bug 变成仓库里永久的变通代码**，还会让未来的人以为「这个仓库不能用 `cpSync`」 |

**B 的原话**：

> 等于把「Node 升级后自动会好」的 bug 变成仓库里永久的变通代码，还会让未来的人以为「这个仓库不能用 `cpSync`」。

**而且那条注释会过期** —— Node 修好之后，它就是错误信息。

### 真正该做的两件事

**① 查上游**（B 正在做）：`fs.cpSync` + 中文路径 + 22.21.1，是不是 Node 的已知 issue。

- **如果是**：在 `docs/testing.md` 记一笔「22.21.1 有 `cpSync` 中文路径回归」；
- **如果不是**：向上游报，并记在本仓库的「环境限制」。

**② 全量报告里单列，不从统计里去掉**

```
558 pass / 3 fail (561 suites)

- tsx-coverage-smoke      已修（13f7a674），全量跑的是修复前的代码
- t10 / t88               环境限制：Node 22.21.1 + 中文路径，fs.cpSync 崩溃
                          已在 v22.14.0 / v20.18.0 上验证正常
```

**「不能因为它们跑不起来就从统计里消失。」**

### 两种 status 值都对，取决于谁在汇报

| 测量方式 | status |
|---|---|
| `spawnSync(node, ["main.cjs"])` | **3221226505**（原始 Windows 退出码） |
| 经 `bash run.sh` | **127**（bash 把 ≥128 折叠成 127） |

**看到 127 先看 stdout 有没有 ok 行：有 → native crash；一个字都没有 → 命令找不到。**

## 🔴 需要立刻判断的一件事（**疑似 P0 产品缺陷**）

`apps/desktop/src/main/lib/dataRoot.ts:150,198` 用 `cpSync` 做**用户数据迁移**：

```ts
cpSync(from, to, { recursive: true });       // :150
cpSync(from, to, { recursive: true });       // :198
```

**如果 `from` / `to` 的绝对路径也超过危险长度，用户点「迁移」会崩。**

而且 `apps/desktop/src/main/ipc/app.ts:21-28` 有一段注释，讲的就是 `cpSync` 的 Windows 长路径 —— **但它只处理「错误信息里怎么去掉 `\\?\` 前缀」，没处理「路径长到会崩」。**

**这项要先判断，不要直接改：**

1. 量 `app.getPath("userData")` 的实际长度（Windows 通常是 `C:\Users\<name>\AppData\Roaming\Mcode`，约 40-60 字符）；
2. 加上用户可能选的迁移目标（可能在深层目录）；
3. **如果两者相加也在危险区，停下报告 —— 那是 P0，不是套件问题。**

## 任务

### 第一步：先确认 `t88` 是不是同型

```js
const r = require("child_process").spawnSync(process.execPath, ["scripts/t88-node-red-license-closure-smoke/main.cjs"]);
console.log(r.status);   // 3221226505 = 同型
```

**如果是同型，两套共用某个函数**（大概率也在 `build/stage-node-red-resources.cjs`）。

### 第二步：修套件（**用 `filter: () => true`，不手写递归**）

> **⚠️ 2026-10-24 更正**：本节原来写「换成手写递归」。T90 找到上游 issue 后改成了
> **`filter: () => true`** —— 一行，且上游认可。**不要两套实现并存**（硬规矩 2）。

```ts
// Node 22 on Windows crashes in cpSync's native fast path when the path has
// non-ASCII characters (nodejs/node#54476, #63970). Passing any filter forces
// the JS implementation, which is unaffected.
cpSync(from, to, { recursive: true, filter: () => true });
```

**两套各改一处**：`t10-node-red-pause-license-smoke/main.cjs`、`t88-node-red-license-closure-smoke/main.cjs`。

### 第三步：验证

- `t10` / `t88` 单跑 `spawnSync` 拿 `status === 0`（**不要用 `bash ... | tail; echo $?`**）；
- **变异**：把 `copyTree` 换回 `cpSync` → 两者必须红 → `cmp` 还原。

### 第四步：如果 `dataRoot` 也受影响，**停下报告**

**按根因修。** 但要先判断：

- **是夹具的问题**（`makeReleaseTree` 造的数据太大/太深）→ 改夹具；
- **是产品代码的问题**（`stage-node-red-resources.cjs` 有越界）→ **停下报告**，那影响打包。

## 验收判据

1. **`t88` 同型确认** —— 已确认（同样 `cpSync`，同样源目录）。
2. **根因** —— 已定位：**路径长度**。有对照实验（104 崩 / 50 OK）。
3. **两套改成 `filter: () => true`**，且 `spawnSync` 拿到 `status === 0`。
4. **变异**：**去掉 `filter`** → 子进程必须崩（`status !== 0`）→ `cmp` 还原。
   **这个变异很特别**：它是今天唯一一个「撤掉修复 → 进程真的死掉」的验证，
   大多数变异只让断言变红。
5. **`dataRoot.ts` 的影响判断**（量路径长度，判断是否 P0）。
6. **如果是产品代码问题，停下报告**。
7. 不跑全量、不起 Electron。

## 边界（补充）

- **可以改**：`scripts/t10-.../main.cjs`、`scripts/t88-.../main.cjs` 里的 `copyLicenseTree`；
- **不要改**：`src/main/lib/dataRoot.ts`（**产品代码**，要先报告）；
- **不要改**：`build/stage-*.cjs`（**打包脚本**，同样先报告）。

## 边界

- **先只读定位**，找到根因再决定改哪个文件；
- 如果改 `apps/desktop/build/stage-node-red-resources.cjs`（**那是打包脚本**），**先报告再动**；
- 不改其他套件。

## 遇到问题先检索

Node 的 `STATUS_STACK_BUFFER_OVERRUN` 先在官方文档和 issue 里查，**不要凭猜**。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T89-nodered-fixup-crash.md` 末尾追加 `## 结果回写（2026-10-24）`：
`t88` 同型确认、二分定位过程、根因、修复、两套的 `status`、提交 SHA。

## 结果回写（2026-10-24）

### 一、`t88` 同型确认 ✅

用 `spawnSync(process.execPath, [main.cjs])` **绕过 bash** 拿原始 status：

| 套件 | status | hex | signal |
|---|---|---|---|
| `t10-node-red-pause-license-smoke` | **3221226505** | `0xC0000409` | null |
| `t88-node-red-license-closure-smoke` | **3221226505** | `0xC0000409` | null |

**同型确认。** 顺带解释了 `bash` 层为什么显示 127：**bash 把 `>=128` 的退出码折叠成 127**，所以 `0xC0000409` 和「command not found」长得一模一样。

> ⚠️ **这个折叠是本次误判的根源**：`status` 的值取决于「谁在汇报」。经过 `bash` 就被折叠；直接 `spawnSync(node)` 才拿到原始值。

### 二、二分定位（比卡上的 `makeReleaseTree` 细得多）

每一步都用**不带管道**的方式取退出码（`> f 2>&1; echo $?`）：

| 步骤 | 结果 |
|---|---|
| 插桩 `makeReleaseTree` 前后 | 崩在内部 |
| 继续插桩到 `copyLicenseTree` | 崩在 **`copyLicenseTree`** |
| 单独 `fs.cpSync(materials → tmp)` | **稳定崩**，连跑 3 次 3 次崩 |
| 换成手写递归 `copyFileSync` | **EXIT=0，正常** |
| 小目录 `cpSync`（纯英文路径） | EXIT=0 正常 |
| `--max-old-space-size=4096` | 仍崩 → **不是 OOM** |
| `--stack-size=4000` | 仍崩 → **不是递归深度** |

### 三、根因：**Node 22.21.1 的 `fs.cpSync` 在中文路径上 native 崩溃**

**最小复现（3 行）**：

```js
const fs = require('fs'), os = require('os'), path = require('path');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
fs.mkdirSync(path.join(base, '副桌面'), { recursive: true });
fs.writeFileSync(path.join(base, '副桌面', 'a.txt'), 'hi');
fs.cpSync(path.join(base, '副桌面'), path.join(base, 'out'), { recursive: true });
// → 进程直接死，stderr 空，JS 层完全捕获不到
```

**跨版本对照（决定性证据）**：

| Node 版本 | 结果 |
|---|---|
| **v22.21.1** | **Segmentation fault（`0xC0000409` / `0xC0000005`）** |
| v22.14.0 | **OK** |
| v20.18.0 | **OK** |

**同样的代码、同样的中文路径，只有 22.21.1 崩。这是 Node 的 bug，不是本仓库的。**

**对照实验排除的因素**：

| 假设 | 实验 | 结论 |
|---|---|---|
| 数据太大 | `@node-rs` 只有一个 1074 字节的文件，照样崩 | ❌ |
| `@` 符号 | 合成 `@scope/pkg` 目录 cpSync 正常 | ❌ |
| 目录结构深 | 同样的树手工复制到临时目录后 cpSync 正常 | ❌ |
| 是 `copyFileSync` 的问题 | `copyFileSync` 在中文路径上 **OK** | ❌ |
| **中文路径** | **同样的树放进 `副桌面/文件夹/` 下就崩** | ✅ |

**具体崩法**：`cpSync(recursive)` 和 `cpSync(recursive, dereference:false)` **两种都崩**，退出码在 `0xC0000409`（STACK_BUFFER_OVERRUN）和 `0xC0000005`（ACCESS_VIOLATION）之间变化——**典型的缓冲区/字符串编码越界**。

### 四、这是环境问题，不是产品代码问题

**按卡的要求：产品代码（`stage-node-red-resources.cjs`）没有问题，`makeReleaseTree` 的逻辑也没问题。**

**崩的是 Node 内置的 `fs.cpSync`**，触发条件是仓库路径含中文——**而这个仓库的路径就是 `D:\副桌面\文件夹\...`**。

**所以这两套在「仓库放在中文路径 + Node 22.21.1」的组合下永远跑不起来**，与代码无关。

### 五、建议（不擅自改）

**三个选项，按推荐度排序**：

1. **把 Node 降到 22.14.0**（已验证 `cpSync` 正常）——但 `package.json` 要求 `>=22.19.0`，**需要产品负责人决定是否放宽**；
2. **把仓库移出中文路径**（比如 `D:\mcode`）——最彻底，但要动所有人的环境；
3. **在套件里把 `cpSync` 换成手写递归**——已验证可行，但**这是绕过 Node 的 bug**，且要改两套（t10 `:47`/`:352`、t88 `:37`/`:343`）。**代价是把一个「Node 升级后会自动好」的问题变成仓库里永久的变通代码。**

**我倾向 1 或 2，倾向 3 最少**——因为第 3 种会让未来的人以为「这个仓库不能用 cpSync」，而真实原因是「这个 Node 版本 + 中文路径」。

> **⚠️ 2026-10-24 后续：以上三个方案都被否掉了，实际采用的是第四种。**
>
> B 查到了上游 issue（`nodejs/node#54476` / `#59636` / `#63970`），Node 官方给的规避方式是
> **传任意 `filter` 强制走 JS 实现**：
>
> ```ts
> cpSync(from, to, { recursive: true, filter: () => true });
> ```
>
> **它优于上面三个**：一行、语义正常、有 issue 编号可查、且 Node 修好后不必再改。
>
> **已由 `741e4b1d` 实现**（t10/t88 各 2 处）。**本节保留原样作为决策历史** ——
> 它记录了「在没有查上游时，三个候选方案都各有硬伤」这个事实。

**我没有改任何代码。** 卡上说「如果是产品代码问题，停下报告」，这虽然不是产品代码问题，但**修法涉及环境决策，不该由我单方面定**。

### 六、我没做的事

- 没有为了「让套件绿」而改 `cpSync` 调用点；
- 没有改 `package.json` 的 engines；
- 所有临时插桩已还原（`/tmp/t10-orig.cjs` 备份 + `cmp` 验证）。

### 七、提交

`7a43c848` —— `docs(T89): the crash is Node 22.21.1's fs.cpSync on a non-ASCII path`（只有本卡回写，无代码改动）。

## 结果回写（二）— 修复（2026-10-24）

### 一、根因更正：**不是路径长度，是非 ASCII 字符**

总控先判「路径长度 104 阈值」，我用 2×2 矩阵推翻：

| 条件 | 路径长 | 结果 |
|---|---|---|
| 短 + 英文 | 53 | ✅ OK |
| **短 + 中文** | **48** | ❌ `0xC0000005` |
| **长 + 英文** | **132** | ✅ **OK** |
| 长 + 中文 | 108 | ❌ |

**132 字符纯英文正常，48 字符中文崩。** 长度不是变量。

> 总控测到「长路径崩、短路径 OK」，是因为把目录拷到临时目录时**同时去掉了中文并缩短了路径**——两个变量一起变。这是「变异同时改两件事」，和我在 T87 踩的坑同型。

**影响面**：中文、`café`、`Müller`、`Тест`、`😀`、全角 `Ａ` **全部崩**。不是「中文用户」，是「所有非 ASCII 路径」。

### 二、上游已确认（不是猜测）

| Issue | 内容 |
|---|---|
| **nodejs/node#54476**（2024-08 起） | `fs.cpSync` 在含中文的目录上崩溃，**"How often does it reproduce? — always"** |
| **nodejs/node#59636** | Node 自己的 CI：`parallel/test-fs-cp-sync-unicode-folder-names`，**`exitcode: 3221226505`** —— 与我们测到的完全一致 |
| **nodejs/node#63970** | 不带 `filter` 时走 **native copyDir fast path**；**传 `filter` 会回退到 JS 实现** |

### 三、修法：`filter: () => true`

实测三种形态：

```
无 filter          0xC0000005   崩
filter:()=>true    0x0          OK，文件真的复制了
force:true         0xC0000005   崩（force 不绕过）
```

**改动 4 处**（每套各 2 处）：

| 文件 | 行 | 用途 |
|---|---|---|
| `t10-.../main.cjs` | `:51` | `copyLicenseTree` —— **原崩溃点** |
| `t10-.../main.cjs` | `:358` | 另一处递归拷贝 |
| `t88-.../main.cjs` | `:41` | `copyLicenseTree` —— **原崩溃点** |
| `t88-.../main.cjs` | `:349` | 另一处递归拷贝 |

**注释按「写 issue 编号、不写『这个仓库不能用 cpSync』」写**：

```ts
// Node 22 on Windows crashes in cpSync's native fast path when the path has
// non-ASCII characters (nodejs/node#54476, #63970). Passing any filter forces
// the JS implementation, which is unaffected. Keep filter even though it
// accepts everything: it is what selects the JS path.
```

**为什么不写「这个仓库不能用 `cpSync`」**：前者随 Node 修复而「不再需要」但**不会误导**（读到的人会去查 issue）；后者**永远误导**。

### 四、验证（`spawnSync(process.execPath, ...)`，不经 bash）

| 套件 | status | ok 行 |
|---|---|---|
| `t10-node-red-pause-license-smoke` | **0** | 15 |
| `t88-node-red-license-closure-smoke` | **0** | 13 |

> ⚠️ **必须用 `spawnSync(process.execPath, ...)` 读 `status`**，不能用 `bash run.sh | tail; echo $?`（拿的是 `tail` 的），也不能只读 `bash` 的退出码（bash 把 `>=128` 折叠成 127，`0xC0000409` 和「command not found」长得一样）。

### 五、变异：撤掉 `filter` → 进程真的死掉

只撤掉**崩溃点**那一处（`copyLicenseTree`），保留第二处：

| 套件 | status | ok 行 |
|---|---|---|
| `t10` | **3221226505** (`0xC0000409`) | **3** |
| `t88` | **3221226505** (`0xC0000409`) | **1** |

**与修复前的数字逐字相同**（修复前实测也是 t10=3 条 ok、t88=1 条 ok）。**变异精确复现了原始故障。**

**这个变异和今天其他变异不同**：它不让断言变红，**它让测试进程本身崩掉**。`cmp` 逐字节还原，`grep MUTATION` = 0。

### 六、回归

| 套件 | 结果 |
|---|---|
| `t73-pattern-wiring-smoke` | 40/40 |
| `t65-deck-pattern-smoke` | 46/46 |
| `t43-document-ai-design-pipeline-smoke` | 65/65 |
| `t47-design-guide-smoke` | 27/27 |

未跑全量、未起 Electron。

### 七、`dataRoot.ts` 的 P0 —— **没做，按总控决定留给 T90**

`apps/desktop/src/main/lib/dataRoot.ts` `:150`（`moveIfNeeded` 迁移 fallback）与 `:198`（用户换数据目录）同样用 `cpSync`：

- **中文用户名（`C:\Users\张伟\`）必崩**，`try/catch` 接不住，进程直接死；
- 修法是同一个 `filter: () => true`；
- **但 `dataRoot` 搬的是用户数据（可能几百 MB），走 JS 实现会比 native 慢，性能要实测** —— 这是 T90 的事。

**我没有动 `dataRoot.ts`**：它不在 T89 的可写边界内，且总控明确说「不在这轮修」。

### 八、`dataRoot.ts:154` 的注释与 T90 打架（已报告，未改）

`0412b0a4` 写的「修复方向见 tasks/T90（**非 ASCII 时降级到手写递归**）」与 T90 卡定的 `filter: () => true` 不一致。**建议改成只指卡、不写做法**（方案写在注释里，方案一变注释就成了错误信息）。

### 九、提交

`741e4b1d` —— `fix(T89): pass a filter so cpSync takes the JS path on non-ASCII paths`（3 文件，+125/-5）。
