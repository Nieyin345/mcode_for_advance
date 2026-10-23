# T113｜`hook-runner-smoke` 有一条时序假设：「撤权一定发生在第 2 条 spawn 之前」

- Status: ready-for-agent
- Category: **P1 测试正确性（全量偶发红的根因之一）**
- Priority: **P1 —— 它让「全量绿」这个验收标准失去判据效力**
- Depends on: T112（同时开的另一条偶发红）
- Exclusive writable files:
  - `apps/desktop/scripts/hook-runner-smoke/main.ts`

## Required Skills
- `mcode-smoke`：时序断言的正负控 + 变异。

## 现象

**第三轮全量里 `hook-runner-smoke` 224/226**：

```
FAIL ★ 复审修复:第 1 条跑完后撤权 → 第 2 条进程一个都不起 — {"actual":1,"expected":0}
FAIL ★ 复审修复:第 2 条记一条 denied(起进程前复验未通过) — {"accepted":1,"dropped":0,...,"denied":0,...}
```

**单独跑：226/226 全绿。**

## 根因：marker 写入早于 sleep，`until()` 返回得太早

`main.ts:1145-1156`：

```ts
rt.emit({ type: "tool.use", ... });
await until("第 1 条(慢)先跑起来", () => slowCmd.hits() === 1, 4000);
revokeHostHookGrants("race-plugin");        // 撤权
await new Promise((r) => setTimeout(r, 1500));
eq("★ ...第 2 条进程一个都不起", fastCmd.hits(), 0);
```

**而 `makeCmd` 生成的脚本（`:146-161`）是**：

```js
fs.appendFileSync(file, "x");               // ← 先写 marker，几乎立刻
setTimeout(() => {}, Number(sleepMs || 0)); // ← 然后才是 sleep 1000
```

**`hits()` 读的是那个 marker 文件（`:164-167`）。**

**所以 `until()` 返回的那一刻，「第 1 条刚 spawn 完、只写了一个字节」，第 2 条的 spawn 可能已经在调度器的下一步里了。**

**`until()` 的轮询间隔是几十毫秒**，而在几十毫秒里，onEvent 的 `await slowCmd` 可能已经完成（慢命令的 1 秒 sleep 在 `setTimeout` 里、不阻塞写 marker）—— **于是第 2 条在撤权之前就 spawn 了。**

**所以不是「撤权没生效」，是「撤权来得太晚」。** 断言 `fastCmd.hits() === 0` 假设了「撤权一定发生在第 2 条 spawn 之前」，**而这个假设没有任何机制保证**。

## 这比一条 flaky 断言严重

**它把一条安全性质的验证建立在一个时序偶然上**：

> 「撤权之后，已经排队的 hook 不应该执行」

**这条性质本身是对的，也是重要的**（它是「AI 可配置但不可自授权」的一个落点）。**但现在的验证方式是「在撤权前一刻停住」，而那个「一刻」是靠 sleep 1 秒撞出来的。**

**在单机空闲时它撞得准，在并行负载下撞不准。** 于是**同样一条安全性质，有时被验了，有时没被验 —— 而两次都是绿的。**

## 任务

### 〇、已核实：`hookRunner` **有**「起进程前复验」（不是产品缺陷）

`hookRunner.ts:435-446` 的 `deliver()` 里、**真正 spawn 之前**：

```ts
const pluginSource = this.pluginSources.get(spec.id);
if (pluginSource !== undefined) {
  const decision = decidePluginHookExecution(pluginSource, spec.event, Date.now());
  if (decision.decide !== "allowed") {
    this.pushRun(spec, payload, "skipped", decision.reason);
    this.bumpCount(spec.id, decision.decide === "exhausted" ? "budgetExhausted" : "denied");
    return;   // ← 不起进程
  }
}
```

**所以产品行为是对的：撤权之后，已经排队的候选在 spawn 前会被拦下。**

**这次红是测试的时序假设错，不是产品缺陷。** 但**「撤权后已排队的不执行」这个性质目前没有一条不依赖时序的断言** —— 这正是本卡要补的。

### 一、把「撤权发生在第 2 条之前」变成**可控的**，不是**撞出来的**

**核心问题**：现在没有任何「第 2 条准备 spawn」的信号可以让测试停下、撤权、再放行。

**你要判断哪种做法可行**（不要三个都做，选一个并论证）：

**选项 a：用一个显式的屏障钩子**

如果 `hookRunner` 或 hook 执行链上有可注入的接缝（比如 `configureHookExec` 之类），**在「第 2 条即将 spawn」时回调一次**，测试在那里撤权。

**查**：`apps/desktop/src/main/hooks/` 下有没有可注入的执行接缝。

**选项 b：让第 1 条**真正阻塞到撤权完成

**现在慢命令的 sleep 在写 marker **之后**，所以 marker 出现 ≠ 第 1 条还在跑。**

**改成「marker 在 sleep 结束之后才写」** —— 那么 `until(() => hits() === 1)` 返回时，第 1 条已经完成，`revokeHostHookGrants()` 在第 2 条被 spawn 之前的窗口**更小**了，**方向反了，不要这么做**。

**正确的方向是：让 marker 在第 1 条**开始时**写，但让 `until()` 等到一个**更晚的信号** —— 比如第 1 条写一个 `started` 文件，第 2 条**永远不写任何东西**，而测试等到「第 1 条的 sleep 即将结束」的时刻再撤权。**但那个时刻怎么观测？** **没有可靠信号。**

**所以选项 b 不可行 —— 除非改 `hookRunner` 让它暴露「第 N 条正在执行」的观测点。**

**选项 c：把断言改成不依赖时序的形式**

**现在的断言验的是「撤权后第 2 条不起进程」。**

**如果改成「撤权后，任何**新**的 hook 调用都不起进程」** —— 即**在撤权之后单独发一次事件**，断言那次的第 1 条和第 2 条都不起进程。

```ts
revokeHostHookGrants("race-plugin");
rt.emit({ type: "tool.use", ... 新 toolCallId ... });   // 全新一次调用
await until("新事件处理完", ...);
eq("★ 撤权后的新事件：两条都不起进程", slowCmd.hits() === 1 && fastCmd.hits() === 0, ...);
//                                                ↑ 仍是 1（上次那次），没有增加
```

**这个形式没有时序假设** —— 撤权发生在发事件**之前**，不存在竞态。

**⚠️ 但它验的性质比原来弱**：原断言验的是「**已经在队列里**的第 2 条被拦下」，新断言验的是「**之后新来的**被拦下」。

**两条都要有** —— 如果 `hookRunner` 只在「进入队列时」检查授权，那「已在队列里的」不会被二次检查，**那是一条真实的漏洞**。

**所以：**

1. **先查 `hookRunner` 有没有「起进程前复验」**（那条断言的文案说「起进程前复验未通过」，所以它**声称**有）；
2. **如果有** → **选项 a**（用可注入接缝把它测成确定性的）；
3. **如果没有** → **那是产品缺陷，不是测试问题** —— **停下来报告**。

### 二、无论走哪条，都要保留「正控」

**现有那条 `check("正控:第 1 条(撤权前已在跑)确实跑了", slowCmd.hits() === 1, ...)` 必须保留。**

**它证明的是「这道闸门没有把所有 hook 都拒掉」** —— 没有它，一个「全部拒绝」的实现也能让主断言绿。

## 验收判据

1. **主断言不再依赖时序**（证明方法写在回写区）。
2. **正控保留**（第 1 条确实跑了）。
3. **连跑 10 次全绿**（现在偶发，所以一次不够）。
4. **变异**：把「起进程前复验」删掉 → 主断言必须红（**这证明它验的是那道复验，不是时序**）。
5. **如果发现 `hookRunner` 没有复验** → **停下来报告，不要改产品代码**。
6. 不跑全量、不起 Electron。

## 边界

- **只改 `hook-runner-smoke/main.ts`**；
- **不改 `apps/desktop/src/main/hooks/` 下的任何产品代码**（发现问题先报告）；
- **不改 `until()` 的实现**（它被这套里几十条断言共用）。

## ⚠️ 为什么这条不能靠「加重试」解决

**加重试会把一条偶发的安全断言变成「偶尔被验」** —— 而**重试那一次如果也红，你不知道是真的还是又撞上了。**

**这条断言的正确形态是「不撞」**，不是「撞多次」。

## 遇到问题先检索

```bash
sed -n '1120,1165p' apps/desktop/scripts/hook-runner-smoke/main.ts
grep -rn "起进程前复验\|denied" apps/desktop/src/main/hooks/hookRunner.ts | head -10
grep -rn "configureHookExec\|HookExecPort\|execPort" apps/desktop/src/main/hooks/ | head -5
```

## 回写

`tasks/T113-hook-runner-timing-assumption.md` 末尾追加 `## 结果回写（2026-10-24）`：
选的哪个方案 + 为什么、`hookRunner` 有没有「起进程前复验」、连跑 10 次结果、变异、提交 SHA。
