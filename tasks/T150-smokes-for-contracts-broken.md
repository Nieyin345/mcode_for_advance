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

## 二、症状 A 的根因（扩展线已查）

`app-control-smoke/main.ts:774` 用 **`readFileSync` 读 `rpcMap.ts` 的文本**，不是 `import` 它：

```ts
const rpcMapSrc = readFileSync(join(contractsDir, "ipc/rpcMap.ts"), "utf8");
```

**`smokes-for.py` 的依赖图只走 `import`，所以这条依赖它看不见。**

**⚠️ 这是「按名字搜是引用数，按来源区分才是出口数」（CLAUDE.md 第十五条）的工具化版本** ——
工具只认一种来源（import），漏掉了另一种（读文件）。

## 三、任务

### 第一步：先让 B 不崩

```python
# smokes-for.py:417 附近
# 现在：
p.relative_to(DESKTOP)

# 应该：
try:
    rel = p.relative_to(DESKTOP)
except ValueError:
    rel = p   # 或用 os.path.relpath / 直接显示绝对路径
```

**⚠️ 但「不崩」不等于「修好」。** 崩之前它该返回什么？
**至少要说清「这个路径不在 apps/desktop 下，所以依赖图对它不适用」**，而不是静默给个空答案。

### 第二步：让 A 能发现 `readFileSync` 依赖

**这是更难的一半。** 两条路：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A1. 解析 `readFileSync` 的路径参数** | 在 AST 里找 `readFileSync(join(X, "literal"))` 这类模式，把它当依赖边 | 只能抓字面量，动态拼接的抓不到 |
| **A2. 加一张手写的「声明式覆盖表」** | 每个套件在自己目录里写 `covers.json`，列出「我读了哪些非 import 的文件」 | 要人维护，但准确 |
| **A3. 两者结合** | A1 抓常见的，A2 兜住剩下的 | 成本最高 |

**我倾向 A1 + 一条「覆盖性断言」**：
- A1 自动抓 `readFileSync(<静态路径>)`；
- **如果 A1 一条都抓不到，说明解析逻辑失效** —— 加一条断言证明它至少抓到了已知的那几条。

**⚠️ 这正是 CLAUDE.md 第八条第 8 种形态**：「被测代码的分支一次没跑，但套件全绿」。
**A1 写完之后，必须有一条断言证明它真的抓到了 `app-control-smoke → rpcMap.ts` 这条边。**

### 第三步：验证

```bash
# 修好之后，这两条应该都成立：
bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/ipc/rpcMap.ts
# → 应该列出 app-control-smoke（至少）

bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/modules.ts
# → 不崩，且说清覆盖情况
```

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
