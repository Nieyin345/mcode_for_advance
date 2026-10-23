# T89｜`makeReleaseTree` 里 native 崩溃（`0xC0000409`），不是并发偶发

- Status: ready-for-agent
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

## 任务

### 第一步：先确认 `t88` 是不是同型

```js
const r = require("child_process").spawnSync(process.execPath, ["scripts/t88-node-red-license-closure-smoke/main.cjs"]);
console.log(r.status);   // 3221226505 = 同型
```

**如果是同型，两套共用某个函数**（大概率也在 `build/stage-node-red-resources.cjs`）。

### 第二步：缩小到具体函数

`makeReleaseTree` 在 `main.cjs` 里，但它调用 `build/stage-node-red-resources.cjs` 的导出。

**用二分法**：在 `makeReleaseTree` 内部的每一步插 `stderr.write`，找到崩在哪个调用。

**注意**：`console.log` / `stderr.write` 本身可能触发问题（如果崩因是 stdout 缓冲），**所以先试「完全不输出，只做文件操作」**。

### 第三步：判断根因

`0xC0000409` 在纯 JS 里的常见原因：

| 原因 | 怎么确认 |
|---|---|
| **栈溢出**（无限递归） | `--stack-size=8000` 不改变 → 不是普通递归 |
| **V8 堆越界 / fast-fail** | 数据太大或结构太深 |
| **Buffer 越界** | 有没有 `Buffer.alloc` / `subarray` 越界 |
| **递归 JSON** | `JSON.stringify` 循环引用 |

**已经试过**：`--stack-size=4000` 仍崩 → **不是普通递归**。

### 第四步：修

**按根因修。** 但要先判断：

- **是夹具的问题**（`makeReleaseTree` 造的数据太大/太深）→ 改夹具；
- **是产品代码的问题**（`stage-node-red-resources.cjs` 有越界）→ **停下报告**，那影响打包。

## 验收判据

1. **`t88` 的同型确认**（`status` 是不是 `3221226505`）。
2. **崩在哪个具体调用**（二分定位，有 `[STEP-X]` 证据）。
3. **根因判断**（栈溢出 / 堆越界 / Buffer 越界 / 递归 JSON）。
4. **修复**，且 `t10` / `t88` 单跑 `exit=0`。
5. **如果是产品代码问题，停下报告**。
6. 不跑全量、不起 Electron。

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
