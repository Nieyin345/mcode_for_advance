# T108｜`t76` 把「缺陷状态」写成了断言：`releaseEligible === false` 现在恒红

- Status: done（2026-10-24 执行回写，见文末）
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

## 结果回写（2026-10-24）

### ⚠️ 先回答卡上最要紧那条：**`false` 没有被改成 `true`**

**真实 stage 那条分支上现在没有任何 `releaseEligible` 的具体值断言。** 核对命令：

```bash
sed -n '/真实产物存在时走这里/,/realStageCovered = true/p' scripts/t76-vendor-release-integrity-smoke/main.cjs \
  | grep "releaseEligible, \(true\|false\)"      # → 无输出
```

改成的是**自洽性**：`releaseEligible === 「十项 blocker 计数全为 0」`。stage 是好是坏都绿。

### 三条断言的改法

| 原文 | 现在 |
|---|---|
| `assert.equal(summary.releaseEligible, false)` | `assert.equal(releaseEligible, blockersAllZero)` —— **十项计数**的合取 |
| `assert.ok(pause && pause.status === "unknown-license")` | `pause` 可以不在；若在，`status === "unknown-license"` ⇔ (`!license && !licenseTextPresent`) |
| `assert.ok(missing.length > 0)` | 删掉。改成 `if (releaseEligible) 断言 missing === 0` |
| `assert.throws(verifyNodeRedResource(existingStage))` | 两个工具的结论必须一致：审计说 eligible ⇔ 门禁放行 |

**顺带纠正了卡上的示例写法**（卡第 75 行）：`releaseEligible === (releaseBlockers === 0)` 是**错的**。
产品里 `releaseEligible` 是**十项**计数的合取（`stage-node-red-resources.cjs:594`），
`releaseBlockers` 只是其中一项。我照卡写，在缺许可文本的坏 fixture 上写出过一个**假的不自洽**（`1010` 那次失败）。
**已按产品真实语义改成十项合取。**

### 验收判据逐条

| # | 判据 | 结果 |
|---|---|---|
| 1 | 真实 stage 好时绿 | ✅ 26/26（`releaseEligible: true`，420 包） |
| 2 | **真实 stage 坏时也绿** | ✅ 把 `existingStage` 指向一份坏 fixture（`missingLicenseText: 1`）→ **26/26** |
| 3 | `false` 没被改成 `true` | ✅ 见上，分支内零值断言 |
| 4 | else 分支有等价覆盖 | ✅ 强制不存在 → `clean fixture stage` 那条跑通，**26/26** |
| 5 | 两次变异各红一次 | ✅ 见下（但有**两次没红**，一并记录） |
| 6 | t10 / t88 不回归 | ✅ t10 15/15、t88 13/13（**但见「未做」里的警告**） |
| 7 | 不跑全量、不起 Electron | ✅ |

### 变异记录（**两次红、三次没红**）

| # | 变异 | 结果 |
|---|---|---|
| 1 | 自洽断言 `releaseEligible === releaseEligible`（恒真），只跑真实 stage | ❌ **不红** —— 恒真在通过路径上看不出 |
| 2 | 删掉坏 stage 上的自洽调用，但保留 `assert.throws(门禁)` | ❌ **不红** —— 门禁的 throws 独立兜住了 |
| 3 | `blockersAllZero = true \|\| ...`（恒真） | ✅ **红**：`坏 fixture: releaseEligible 必须等于「所有 blocker 类计数都为 0」` |
| 4 | 掏空 else 里的自洽调用（未加 xor 断言前） | ❌ **不红** |
| 5 | 同上，**加了 xor 断言之后** | ✅ **红**：`真实产物存在时应走 if，不存在时应走 else —— 不能两条都没走` |

**变异 1、2、4 没红这件事本身是结论，不是操作失误**：`assertStageAuditSelfConsistent` 单独拿出来是**弱证人** ——
它在「只有好数据」或「旁边还有别的断言兜底」时，改坏了也看不出来。**是外面的显式断言给了它判别力**：

- 变异 3 之所以红，是因为**坏 fixture 也调了这个 helper**（新增）；
- 变异 5 之所以红，是因为**加了 xor 覆盖断言**（新增）。

**这两处新增都是变异逼出来的，不是原计划里的。**

### else 分支覆盖

```js
let realStageCovered = false;
if (fs.existsSync(existingStage)) { verify("current ... self-consistent ...", ...); realStageCovered = true; }
let selfConsistencyCovered = false;
if (!realStageCovered) { verify("... on a clean fixture stage (real stage absent)", ...) → selfConsistencyCovered = true }
verify("the stage self-consistency checks ran on exactly one path (if xor else)", () =>
  assert.equal(realStageCovered !== selfConsistencyCovered, true, ...));
```

else 里调的是**同一个** `assertStageAuditSelfConsistent`，不是另写一份简化版。
那条 xor 断言是让「else 被误删」可被发现的东西 —— 没有它，变异 4 是静默的。

### `makeNodeRedFixture` 复用情况

**没有改 fixture。** 实测确认默认参数（`pause=false, missingExpressLicense=false`）造出来的
就是一份**合格** stage（`releaseEligible: true`，门禁放行），正是卡上要的「好 fixture」。
坏数据靠已有的 `missingExpressLicense: true`。

### 提交

`cad5cfbf`（`test(T108): t76 asserted a defect state instead of the gate's behaviour`），1 文件 +134/−14。

### 未做 / 需要总控知道的

1. **t88 的绿灯不能当证据。** 我跑 t88 时它 13/13，但 `mtime` 是 **02:05:36（就在跑之前两分钟）**，
   且工作区有 **+9/−1 别人未提交的改动**（T107 正在改它）。**我看到的绿是别人在途的状态。**
   t10 同样有 +9/−1 在途改动。两套的「不回归」都要在 T107 落地后重跑才能作数。
2. **`t88` 里有没有同型「记录状态」断言 —— 我没查。** 卡上写「报告，不擅自改」，
   而我连查都没做（怕与 T107 的在途改动撞车）。**建议在 T107 之后另起一条核对。**
3. 没碰 `.tmp/node-red-release`，也没改 `verifyNodeRed` / `stage-node-red-resources.cjs` / `build/vendor-licenses/`。

---

## 附：判据强度分级（2026-10-24，由本卡的变异记录归纳）

> 这一节不是 T108 的验收内容，是从本卡**三次「变异没红」**里读出来的通用判据。
> 放在这里是因为本卡恰好三个档次都出现了实例。

### 三档

| 强度 | 什么情况下它会红 | 需要什么配套 | 本卡的实例 |
|---|---|---|---|
| **强** | 目标被改坏 → 必红，与旁边有没有别的断言无关 | 无 | `assert.throws(verifyNodeRedResource(brokenRoot), /license-text-missing/)` |
| **弱证人** | 需要「只有坏数据」**或**「没有别的断言兜底」才红 | **必须配对照 / 覆盖断言** | `assertStageAuditSelfConsistent` 单独用时 |
| **恒真** | 永远不红 | **删掉** | 变异 1 里我把它改成的样子 |

### 判断方法（一句话）

**「删掉旁边所有兜底的断言，它还能红吗？」**

- 能 → **强**；
- 不能，但配上「只喂坏数据」就红 → **弱证人**；
- 怎么都不红 → **恒真**。

### 为什么弱证人不等于坏断言

`assertStageAuditSelfConsistent` 是个**正确的**检查（它确实抓内部矛盾），只是**它的判别力依赖输入**：

- 只喂好数据 → 矛盾永远不存在 → 改坏了也绿（变异 1）；
- 旁边有 `assert.throws(门禁)` 时 → 门禁先红，它红不红看不出来（变异 2）；
- **喂坏数据** → 矛盾真的存在 → 改坏了就红（变异 3）。

**所以「弱证人」的修法是给它配对照，不是删掉它。** 删掉会丢掉「内部一致性」这一层。

### 本卡的两次「变异生成了断言」

变异验证在这里的作用不只是**检验**断言，它还**生成**了断言：

| 变异 | 逼出来的新断言 |
|---|---|
| 变异 3（自洽恒真） | 坏 fixture 上**也调**这个 helper，并断言它返回的 summary |
| 变异 5（掏空 else） | `if xor else` 覆盖断言 —— 没有它，「else 被删」完全静默 |

**这两条都不在原计划里。** 先有变异，才发现「这里缺一条断言」。

### 一条相关的局限：自洽 ≠ 有效

**自洽判据只能封住「内部矛盾」，封不住「算法本身错」** —— 如果十项计数里漏算了一项，
`releaseEligible === blockersAllZero` 照样成立（两边用的是同一个错算法）。

**兜住这一层的是「坏数据必须被拒绝」，不是自洽。** 两者要一起用：
- 自洽 → 抓「字段之间漂移」；
- 坏 fixture 必红 → 抓「算法算错」。

### 一处容易被误判成「强」的写法

`assert.ok(x)` / `assert.equal(x, 常量)` 这类**一次性**断言看起来是强的，但若它**同时**是
「恒真」的载体（例如 `x || true`），变异会**静默通过**。**唯一区分办法还是跑变异，不是读代码。**
