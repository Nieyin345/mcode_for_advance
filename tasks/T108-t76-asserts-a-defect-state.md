# T108｜`t76` 把「缺陷状态」写成了断言：`releaseEligible === false` 现在恒红

- Status: ready-for-agent
- Category: **P0 测试正确性（断言记录的是当时的缺陷，不是规范）**
- Priority: **P0 —— 这条断言在 HEAD 上已经红了整整三天，因为条件分支从没被执行到**
- Depends on: T10（`782b08fc`，pause 许可整合）
- Exclusive writable files:
  - `apps/desktop/scripts/t76-vendor-release-integrity-smoke/main.cjs`
  - `apps/desktop/scripts/t88-node-red-license-closure-smoke/main.cjs`（**只读核对，可能不用改**）

## Required Skills
- `mcode-smoke`：变异 + 条件分支覆盖。

## 背景：这条断言在 HEAD 上就是红的

**触发链路**：

```
00:20 全量#1：PASS  t76（因为 .tmp/node-red-release 不存在 → 走 else 分支打 skip）
01:40 B 跑打包链：产出 .tmp/node-red-release（134MB，420 包，releaseEligible: true）
01:48 全量#2：FAIL  t76（if 分支第一次被执行到，断言当场红）
```

**`t76` 的失败行**（`:418`）：

```js
assert.equal(inventory.summary.releaseEligible, false);   // 实测 true
const pause = inventory.packages.find(...);
assert.ok(pause && pause.status === "unknown-license");   // 实测 "collected"
assert.ok(missing.length > 0);                            // 实测 0
```

**三条断言全部与当前事实相反。**

## 这不是 bug，是断言写错了对象

**`git log -S "releaseEligible, false"` → 只有 `ab9149eb`（T76 建立时）一次提交。**

**也就是说：这条断言从建立起就写着「当前的 release stage 是坏的」。**

**而 T10（`782b08fc`）做的事情正是「把 pause 的 MIT 许可整合进去，让它变好」** ——
**T10 完成后，`releaseEligible` 变成 `true`、`pause` 变成 `collected`、`missingLicenseText` 变成 `0`，而 t76 的三条断言原样没动。**

**它测的不是「许可门禁是否工作」，而是「这个阶段现在是不是坏的」。** 后者是一个会随事实变化的**状态**，不该被写成断言。

## 对比：同一套件里的正控是好的

`t76` 前面的那些 `verify(...)` 都是**用 fixture 造坏树**：

```js
const inventory = makeNodeRedFixture(root, { missingExpressLicense: true });
assert.equal(inventory.summary.missingLicenseText, 1);
assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /license-text-missing/);
```

**这才是正确形状**：自己造坏数据，断言门禁抓住了它。**它不依赖真实的 stage 是好是坏。**

**出问题的那一段（`:412-431`）用的是 `existingStage`（真实产物）** —— 于是它变成了一条「当前环境快照」断言。

## 任务

### 一、把「真实 stage」那段的断言改成不依赖具体状态的形状

**目标**：**无论真实 stage 是好的还是坏的，这段都该绿；它要验的是「审计工具在真实数据上能跑通并且结论自洽」。**

**改法（你论证）**：

**① 验自洽性，不验具体值**：

```js
const inventory = createNodeRedLicenseInventory(existingStage);
assert.ok(inventory.summary.packageCount > 0);
assert.equal(inventory.inventoryType, "license-coverage-audit-not-sbom");
// 自洽：releaseEligible 必须与它自己的 blocker 计数一致
assert.equal(inventory.summary.releaseEligible, inventory.summary.releaseBlockers === 0);
// 自洽：每个 status=unknown-license 的包必须没有 license 文本
for (const p of inventory.packages.filter(p => p.status === "unknown-license")) {
  assert.equal(p.licenseTextPresent, false);
}
// 自洽：报告里说 releaseEligible=true 时，不能有任何 missing
if (inventory.summary.releaseEligible) assert.equal(inventory.summary.missingLicenseText, 0);
```

**这是「验工具的正确性」，不是「验世界的状态」。**

**② 或者把这段改成 §二 说的「真实数据上跑一遍，断言它不崩、且和 `verifyNodeRedResource` 的结论一致」**：

```js
const inventory = createNodeRedLicenseInventory(existingStage);
const gate = verifyNodeRed.verifyNodeRedResource(existingStage);   // 好就过，坏就 throw
// 两者结论必须一致：审计说 eligible ⇔ 门禁放行
```

**我倾向 ① + ② 合起来** —— 自洽性 + 两个工具结论一致。**你判断。**

**⚠️ 不要做的事**：**不要把 `false` 改成 `true`。** 那只是把「记录某天的状态」换成「记录另一天的状态」，下次状态变了还红。**这个错误最容易犯。**

### 二、`pause` 那条断言也要改

```js
const pause = inventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
assert.ok(pause && pause.status === "unknown-license");
```

**T10 就是为了让 `pause` 变成 `collected` 才做的。** 这条断言是**在验收 T10 之前写的，T10 完成后就成了反证**。

**改成**：`assert.ok(pause)` + **断言它的状态与它自己的许可数据自洽**（有 `license` 且有文本 ⇔ 不是 `unknown-license`）。

### 三、`missing.length > 0` 同理

**「真实 stage 里必须有缺失许可的包」** —— 这是把「当时还缺」写成了期望。**删掉或改自洽。**

### 四、⚠️ 更重要的：这个套件的「条件分支」从来没被覆盖过

**`if (fs.existsSync(existingStage))` 这段在 00:20 那轮走的是 `else`（打 skip），01:48 那轮才第一次走 `if`。**

**换句话说：这段代码被写出来三天，只在今晚执行过一次，而那一次是红的。**

**这说明**：`t76` 的「真实 stage 审计」这条路径**没有持续被验**。

**要求**：**在 else 分支里，用 fixture 造一个「好」的 stage 跑一遍同样的断言** —— 这样无论真实产物在不在，那条路径都被执行到。

```js
} else {
  console.log("  skip ...");
  // 但用 fixture 造一份「合格」的 stage，把 if 分支的断言在这份 fixture 上跑一遍
  verify("合格 stage 的自洽性（真实产物不存在时的替代覆盖）", () => { ... });
}
```

**这是本卡最有价值的一条** —— 它把「条件分支在某个环境下永不执行」变成「两条路都有覆盖」。

### 五、变异

1. **把 `releaseEligible` 的自洽断言改成恒真** → 用一份坏 fixture 跑，必须红；
2. **把 else 分支的 fixture 覆盖删掉** → 断言「else 分支也执行了 if 分支的判据」必须红（要为此加一条显式断言）。

## 验收判据

1. **`t76` 在「真实 stage 是好」时绿**（现在就是好的，`releaseEligible: true`）。
2. **`t76` 在「真实 stage 是坏的」时也绿** —— **用一个坏的 fixture stage 验证**（这是关键：证明它不再依赖状态）。
3. **`releaseEligible: false` 没有被简单改成 `true`**（回写区要明说）。
4. **else 分支有等价覆盖**（真实产物不存在时也跑到那些判据）。
5. **两次变异各红一次**。
6. `t10` / `t88` 不回归。
7. 不跑全量、不起 Electron。

## 边界

- 只改 `t76` 套件；
- **不改 `verifyNodeRed` / `createNodeRedLicenseInventory` 的实现**（那是产品代码）；
- **不改 `build/vendor-licenses/`**（那是已提交的许可材料）；
- **不碰 `.tmp/node-red-release`**（B 的打包产物，T107 在处理它的复制问题）；
- 如果发现 `t88` 里有同型的「记录状态」断言，**报告，不擅自改**（T107 正在改 t88 的复制逻辑）。

## 遇到问题先检索

```bash
grep -n "releaseEligible\|unknown-license\|missingLicenseText" apps/desktop/scripts/t76-vendor-release-integrity-smoke/main.cjs
git log --oneline -3 -- apps/desktop/build/vendor-licenses/node-red/
sed -n '1,60p' tasks/T10-node-red-license-integration.md
```

**先读 `T10` 的回写区** —— 它记了 pause 许可整合的前后对比，那正是本卡断言的「反证来源」。

## 回写

`tasks/T108-t76-asserts-a-defect-state.md` 末尾追加 `## 结果回写（2026-10-24）`：
三条断言各自的改法、坏 fixture 的验证、else 分支覆盖、两次变异、提交 SHA。
