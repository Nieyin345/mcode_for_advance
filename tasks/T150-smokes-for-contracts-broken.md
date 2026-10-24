# T150 — `smokes-for.sh` 对 `packages/contracts` 的答复不能用：要么说没覆盖，要么直接崩

**Status**：`ready-for-agent`
**Category**：P0 测试基础设施
**发现者**：总控（扩展）—— 它在追 `rpcMap.ts` 为什么没有回归网时撞到
**写卡时间**：2026-10-24 21:45。**下面前提都是扩展线实测的，我复核过。**

## 一、两个症状

### 症状 A：改根因文件得到「没有套件覆盖」，改症状文件却有 14 套

```bash
$ bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/ipc/rpcMap.ts
⚠️ 没有套件覆盖它 —— 改这里没有回归网。

$ bash apps/desktop/scripts/smokes-for.sh src/main/appControl/apiCatalog.generated.ts
必跑（1–2 跳，14 套）
```

**而加一个 RPC 的人，动的一定是 `rpcMap.ts`。**
**这个顺序反了：真正需要回归网的地方，工具说没有。**

### 症状 B：查询 `packages/contracts` 下的文件直接 Python traceback

```bash
$ bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/modules.ts
# → Python traceback
```

**`smokes-for.py:417` 的 `p.relative_to(DESKTOP)`** —— 「上一跳」在 `packages/contracts` 下，
不在 `apps/desktop` 下，`relative_to` 抛 `ValueError`。

## 二、⚠️ 这是**两个不同的 bug**，不是一件事

**我第一版卡把 A 和 B 写在一起，是错的。** 扩展线查清之后：

| 症状 | 真问题 | 修法 |
|---|---|---|
| **B（崩溃）** | **依赖图能看见，但算距离时 `p` 在 `packages/contracts` 下** | 修 `:417` 的**路径基准** |
| **A（`rpcMap.ts` 说没覆盖）** | **`readFileSync` 根本不是 import，依赖图看不见它** | 要**显式声明** |

**两个症状、两个修法、两个 PR 都可接受。别混。**

### 症状 B 的完整机制（扩展线查的）

`smokes-for.py` 的 `resolve()`：

```python
elif spec.startswith("@contracts/"):
    return None                                # 包边界，丢掉（这条是对的）
elif spec.startswith("."):
    base = (from_file.parent / spec).resolve() # 相对路径 → 不认包边界
```

**而很大一批套件是这样 import 的**（真实存在）：

```ts
// apps/desktop/scripts/capability-smoke/main.ts:1
import { resolveCapabilities } from "../../../../packages/contracts/src/capability.js";
```

**`../../../../packages/contracts/...` 走 `.` 分支，解析成功，contracts 文件进了图。**
`distances_to` 能到达它，`rank()` 给出「上一跳」`p`，而 `p` 在 `packages/contracts` 下 → `:417` 抛。

**为什么崩在 `moduleCapability.ts` 而不是 `modules.ts`**：`modules.ts:4` 有
`import type ... from "./moduleCapability.js"`，`closure()` 顺着这条边再走一跳。

### 症状 A 的完整机制（扩展线查的）

**`app-control-smoke` 是用 `readFileSync` + `ts.createSourceFile` 读 `rpcMap.ts` 的 —— 连相对路径 import 都没有。**

所以**任何解析器都看不见它**。这里需要的是**一条显式声明**。

**⚠️ 而 `@smoke-covers` 现在不能用** —— 它硬拒绝 `src/main` 以外的路径：

```
smokes-for.py:77   SMOKE_COVERS_RE 的正则
smokes-for.py:277  is_relative_to(MAIN)
```

**所以「显式声明」这条路要先放宽那条限制，而那是另一次改动。**

## 三、任务

### 第一步：修症状 B（便宜、清晰、无争议）

```python
# smokes-for.py:417 附近
# 现在：
key = p.relative_to(DESKTOP).as_posix() if p is not None else "(不可达)"

# 改成：先试 DESKTOP，失败试 ROOT，都失败给原文
```

**⚠️ 正确改法不是 `try/except` 吞掉。** 理由（扩展线原话）：

> 吞掉会让「上一跳到底是谁」这个信息消失，**而那个信息是 `--why` 的全部价值。**

**`p` 不在 `DESKTOP` 下时，正确的显示是它相对仓库根的路径。**

### 第二步：症状 A —— 加显式声明（**要额外放宽一条限制**）

**两种做法，选一个并写清理由：**

| 做法 | 代价 |
|---|---|
| **A1. 放宽 `@smoke-covers` 的路径限制**（允许 `packages/contracts/`），然后在 `app-control-smoke` 里写一条声明 | 改 `smokes-for.py:77/277`，影响所有套件的声明能力 |
| **A2. 单独的「读取声明」机制**（比如套件目录下 `reads.json`），只解决 `readFileSync` 这类 | 新增一套机制，但不动现有的 |

**⚠️ 不要用「解析 `readFileSync` 的静态路径」去修 A。** 我第一版卡提了这个方向，**是错的** ——
`app-control-smoke` 用的是 `readFileSync` + `ts.createSourceFile`，路径还是 `join(contractsDir, "ipc/rpcMap.ts")`，
**解析器追不到这种组合。** 显式声明是唯一可靠的路。

### 第三步：验证（**这条最关键**）

**⚠️ 断言 `rc == 0` 不够 —— 现在的行为就是 `rc == 0`**（它打印完「没有套件覆盖」正常退出）。

**必须断言输出内容：**

```bash
# 改完之后必须同时成立：
bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/ipc/rpcMap.ts
# ① 输出里有 "app-control-smoke"
# ② 且它不在「没有套件覆盖」那句下面
```

**写套件时用这两条，不要用 rc。**

**并且要有一条「覆盖性断言」**：证明这个检查**真的抓到了那条边**，不是「不报错」。
（CLAUDE.md 第八条第 8 种：「被测代码的分支一次没跑，但套件全绿」。）

**判断信号**：如果改完之后 `smokes-for.sh rpcMap.ts` **仍然说「没有套件覆盖」**，
那就是没生效 —— 不管代码看起来多对。

## 四、验收

1. **`smokes-for.sh packages/contracts/src/modules.ts` 不崩**，且输出有意义。
2. **`smokes-for.sh packages/contracts/src/ipc/rpcMap.ts` 能列出 `app-control-smoke`**（它真的读这个文件）。
3. **有断言证明 A1 的解析真的抓到了那条边**（不是「改了但没生效」）。
4. **不回归**：`tsx-coverage-smoke` 全绿（它断言 `smokes-for.py` 的输出格式）。
5. **不回归**：`smokes-for.sh src/main/<某个文件>` 的结果和改之前一致。

## 五、⚠️ 输出格式是公共接口

`smokes-for.py` 的 stdout 被别的套件断言（CLAUDE.md 第十七条）。

```bash
grep -rln "smokes-for" apps/desktop/scripts/*/main.*
grep -rln "跑这些\|必跑\|没有套件覆盖" apps/desktop/scripts/*/main.*
```

**改输出格式之前先查消费者。**
`tsx-coverage-smoke` 是已知的一个 —— 它上次就是因为这个格式变了而红的。

## 六、边界

**可以改**：
- `apps/desktop/scripts/smokes-for.py`
- `apps/desktop/scripts/smokes-for.sh`（如果调用方式要变）
- 新建/延伸套件

**不许碰**：
- `apps/desktop/scripts/*/run.sh`（T145 在改）
- `arc005-visual-baseline/`（T149 刚改）
- 任何 `src/`

**⚠️ 并行提示**：T145 的子代理可能还在改 `smokes-for.py` 的打印行（只改了一句）。
**开工前先 `git log -2 -- smokes-for.py` 和 `git status --porcelain -- smokes-for.py` 确认。**

## 七、回写

1. 症状 B 修成了什么（崩之前它该返回什么）
2. 症状 A 选了 A1 / A2 / A3，为什么
3. **A1 的「覆盖性断言」怎么写的**（证明它真的抓到 `app-control-smoke → rpcMap.ts`）
4. `tsx-coverage-smoke` 有没有红，为什么
5. 改前/改后 `smokes-for.sh` 对几个样板的输出对比
6. 提交 SHA
7. **你觉得不对但没改的**

---

## 附：为什么这张卡重要

**这两个 bug 让工具在「最需要它的时候」给出错误答案：**

| 场景 | 工具说 | 真相 |
|---|---|---|
| 改 `rpcMap.ts`（加 RPC 的必经之路） | 「没有套件覆盖」 | `app-control-smoke` 读它 |
| 改 `packages/contracts/src/modules.ts` | Python traceback | — |

**而「改这里有没有回归网」正是这张工具存在的唯一理由。**
**它在 `packages/contracts` 上的答案不能用，就等于这个目录没有工具。**
