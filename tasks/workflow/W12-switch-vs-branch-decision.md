# W12｜`branch` / `condition` 能不能用上游 `switch` 代替 —— 总控预判

- Status: **预判卡（总控写，等 W8 回来对照后才决定是否派）**
- Category: **决策依据（读源码得到的硬事实），不是任务卡**
- 依赖：W8 的决策表
- 写入边界：**无。这张卡不派给执行会话。**

## ⛔ 2026-10-24 更正：这张卡第三节「`branch` 不能」错了一半

**我写这张卡时说「`branch` 差三个能力，要写 `mcode-branch`」。**

**`mcode-branch` 已经在了**，而且实现的正是我列的缺口：
`apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts:361-386` ——
1 入 N 出、调 `port.decide({ portCount, decider })`、拿 `chosen.port` 后 `send(ports)`
只在选中那一口发、其余发 `null`。

**所以我下面第三节那张「差一个能力」的表，对 `branch` 的那一行是错的。**

**但它指出的一件事仍然成立，而且更重要了**：

> 旧 `branch` 的选项在**边上**，每条边带 `label`（按钮文字）和 `note`（**拼进下一步提示词的一句话**）。
> `mcode-branch` 的 `send(ports)` **只选端口，没有信息通道**。

**所以真问题变成：`label` / `note` 在 `mcode-branch` 里还在不在？** 如果不在，
那是**功能丢失**，不是「用上游代替」——**W8 正在查这个。**

**第三节里关于 `switch` 的两条仍然有效**（`checkall` 默认 `"true"`、`msg` 为 `null`），
因为那是对**上游**的核实，不依赖 `mcode-*` 的现状。

---

## 为什么先写这张

W7 和 W8 里我给的初判是「`branch` / `condition` → `switch`，**够**，不造新节点」。
**我读了两边的源码，发现「够」这个判断半对半错，而且错的那一半会静默丢功能。**

W8 大概率会照我的初判回「用上游」。**如果它那样回，而我不纠正，W12 就会写成一个
「验证映射」的卡 —— 而真正的活是「补一个无人值守时没法表达的分支」。**

**所以我把证据先摆出来，等 W8 的结论来对照。**

## 一、旧 `branch` 实际是什么（`nodeTypes.ts:764-802`）

两件事，**第二件在 Node-RED 里没有对应**：

| 旧 `branch` 的能力 | 详情 |
|---|---|
| **选项 = 出边** | `params` 只有 `NODE_DECIDER_KEY`（决定权）和 `NODE_PROMPT_PARAM_KEY`（选路判据）。**选项不是节点上的表，是图上拉出来的边**；每条边带 `label`（按钮文字）和 `note`（拼进下一步提示词的一句话） |
| **决定权二选一** | `decider: "user"` → **运行时停下来弹框等真人点选**，还能临时补一句话。<br>`decider: "model"` → **跑一轮模型，按「选路判据」自行挑一条**，挑完继续 |

**这是「人在环里」和「模型判断」两种分流，不是条件匹配。**

## 二、上游 `switch` 实际是什么（`10-switch.js` 实测）

```js
// applyRule（:186-215）
if (operators[rule.t](property,v1,v2,rule.case,msg.parts)) {
    state.onward.push(msg);
    state.elseflag = false;
    if (node.checkall == "false") { return done(undefined,false); }   // 首个命中就停
} else {
    state.onward.push(null);                                          // 未命中 → 该口发 null
}
done(undefined, state.currentRule < node.rules.length - 1);
```

**三条硬事实：**

1. **`checkall` 默认 `"true"`**（`10-switch.js:263` `this.checkall = n.checkall || "true"`，
   UI 默认值也在 `10-switch.html:199` `checkall: {value:"true", required:true}`）。
   **默认语义 = 所有命中的规则全部放行**，也就是**一条 msg 可能同时走多个出口**。
   UI 上把它改成 `"stopping after first match"` 才是互斥。
2. **匹配失败的分支，`msg` 是 `null`**（`state.onward.push(null)`）。下游那一口
   收到的是「什么都不发」，不是「发一个 false」。
3. **`switch` 只会做规则运算**。它**没有**「暂停等用户点」的形态，
   也**没有**「让模型读上游产出自行挑一条」的形态。

## 三、逐条对照：够不够

| 旧能力 | `switch` 能表达吗 | 判断 |
|---|---|---|
| **`condition`**（`exists`/`equal`/`contains` + AND/OR → true/false 两口） | **能**。设两条规则（true 规则 + `else`），`checkall: "false"`，两个出口 | ✅ **真够，不造新节点** |
| **`branch` + `decider: "user"`**（运行时弹框等人点选） | **不能**。`switch` 没有「停下来等人」 | ❌ **差一个能力** |
| **`branch` + `decider: "model"`**（跑一轮模型按判据挑） | **不能**。`switch` 只做规则运算，不调模型 | ❌ **差一个能力** |
| **边上的 `label` / `note`**（选项名 + 拼进下一步的说明） | **不能**。`switch` 的出口标签是规则名，不是「选项」；也没有「选这条之后给下一步一句话」 | ❌ **差一个能力** |

**所以：`condition` 可以直接用 `switch`；`branch` 不能。**

## 四、那么 `branch` 该怎么办

**三个候选，我不预设答案（W8 或后续卡论证）：**

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 写 `mcode-branch` 节点** | 一个节点两种模式（等人选 / 模型选），选项来自出边 | 一个节点类型 + 真人的审批 UI + 模型派发接线；但它保住了旧 `branch` 的全部语义 |
| **B. 拆成两个节点** | `mcode-approve`（人工审批）+ `mcode-decide`（模型判断），各自输出到不同口 | 两个更小的节点；用户要自己连，比旧 `branch` 多一步 |
| **C. 用上游表达一部分** | 用户选：用 `switch` + 人工在别处确认；模型选：`switch` 接 JSONata 规则 | **丢掉「模型按判据挑」**，等于功能倒退 |

**我的倾向是 A 或 B，不是 C** —— 路线图说「保留旧功能」，而 C 是丢掉一个。
**但这条要 W8 用它的证据来定，我不替它决定。**

## 五、给 W8 的三个具体问题

**如果 W8 已经交了，用它对照；如果还没交，把这三条发给它。**

1. **`switch` 的 `checkall` 默认是 `"true"`（全部命中都放行）** —— 你在说「够」的时候，
   是想让一条消息走多个出口吗？如果不是，**你的映射必须显式写 `checkall: "false"`**，
   否则行为是「一次触发，多条支路同时跑」。
2. **旧 `branch` 的 `decider: "user"` 是运行时暂停等人点**，`switch` 做不到。
   **你打算怎么保留这个能力？**（如果结论是「不保留」，请写明理由 —— 这是功能丢失，不是等价替换。）
3. **边上的 `label` / `note`** 是旧系统「选项」语义的一部分（`note` 会被拼进下一步的提示词）。
   Node-RED 的连线有没有对应物？没有的话，这部分信息迁过去时落在哪？

## 六、这条预判卡本身要遵守的规矩

**我这段全部是读源码得到的，没有实跑。** 所以：

- `switch` 的 `checkall` 默认值我读的是 `10-switch.js:263` 与 `10-switch.html:199`，**两处一致**；
- 「`msg` 为 `null` 表示这一口不发」我读的是 `10-switch.js:203` 的 `state.onward.push(null)`，
  但**我没有跑一遍验证 `node.send(null)` 的语义**（Node-RED 对数组里的 `null` 是跳过）。
  **这一条如果你要拿去当结论，先跑一次。**

**验证成本很低**：`node-red-e2e-smoke` 已经是现成的真跑环境，加一个三口 `switch`
（两条规则都命中）看下游收到几条，就能同时验掉 `checkall` 与 `null` 两条。
