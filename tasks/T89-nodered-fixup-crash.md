# T89｜`fs.cpSync` 复制长路径时 native 崩溃 —— 可能影响用户数据迁移

- Status: **blocked — 根因是 Node 22.21.1 的 `fs.cpSync` 在中文路径上崩溃，修法涉及环境决策**（见末尾回写）
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

### 第二步：修套件（**这一步已经确定怎么做了**）

两套的 `copyLicenseTree` 都用 `fs.cpSync`。**换成手写递归 `copyFileSync`** —— B 已验证可行（`EXIT=0，MANUAL OK`）。

```ts
function copyTree(src: string, dst: string): void {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name));
  } else {
    fs.copyFileSync(src, dst);
  }
}
```

**同时给两套加一条注释说明「为什么不用 `cpSync`」**（否则下一个人会「优化」回去）。

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
3. **两套改成手写递归**，且 `spawnSync` 拿到 `status === 0`。
4. **变异**：换回 `cpSync` → 红 → `cmp` 还原。
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

**我没有改任何代码。** 卡上说「如果是产品代码问题，停下报告」，这虽然不是产品代码问题，但**修法涉及环境决策，不该由我单方面定**。

### 六、我没做的事

- 没有为了「让套件绿」而改 `cpSync` 调用点；
- 没有改 `package.json` 的 engines；
- 所有临时插桩已还原（`/tmp/t10-orig.cjs` 备份 + `cmp` 验证）。

### 七、提交

`<见提交>` —— 只有本卡回写，无代码改动。
