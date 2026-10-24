# F003｜那道真正的墙：单文件限额，不是 DEFLATE

- Status: **done**（`b1045bb9` + `35a9a544`）
- Category: **P0 扩展主线**（VSIX 兼容第二步）
- Depends on: F002（`5e91296f` DEFLATE 已通）、T80（`ecb5035a`）、用户裁决「路线图为准，做 VSIX」
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
  - `apps/desktop/scripts/vsix-size-limits-smoke/`（新建）
  - `docs/planning/extension-vscode-compat.md`（只补 §4 的限额依据）
  - 本卡回写

## Required Skills
- `mcode-smoke`：阈值断言的变异。

---

## F002 的发现推翻了我写卡时的判断

**我在 F002 里写的是**「第 2 条（DEFLATE）是根：不认 DEFLATE，其余五条都没有意义」。

**F002 做完后实测**：把 `rainbow-csv` 的两个文件重新打包成 DEFLATE，**只有 33.7 KiB，远在 128 KiB 总限额内** —— **但仍然被拒**。

真正卡住的是**单文件限额**：

| 文件 | 实际大小 | 现限额 | 倍数 |
|---|---|---|---|
| `package.json` | **17,021 B** | 4,096 B | **4.2×** |
| `extension.js` | **136,516 B** | 24,576 B | **5.6×** |

**所以 DEFLATE 是必要条件，不是充分条件。我那张卡把一个必要条件写成了「根」。**

---

## 第一步：先查这两个数字有没有依据（**别急着改**）

`git show 68a7121c` 是这些限制最初被引入的提交。**它没有解释 4096 / 24576 从哪来。**

**所以第一件事是回答：这两个数是有依据的，还是 L1 原型阶段随手定的？**

要查的地方：

1. `docs/planning/extension-vscode-compat.md` §4（L1 实际限制）—— 有没有写理由；
2. `git log -S "4096" --oneline -- apps/desktop/src/main/modules/vscodeL1Bridge.ts`；
3. ARC-006 / MC-035 的相关卡（`tasks/archive/` 里可能有）；
4. **如果找不到依据，就明说「没找到依据」** —— 不要脑补一个理由。

**这一步的产出写进回写区，它会决定第二步怎么做。**

---

## 第二步：按结论动手

### 情况 A：`package.json` 的 4096 没有依据 → 放宽它

**放宽到能装真实扩展**（实测最大 17 KB，建议给到 **64 KiB** 留余量）。

**理由**：`package.json` 是**声明，不是代码**。它变大不会引入新能力，只是多了命令、配置项、
activationEvents。**放宽它不会让「能读进来但 API 全缺」的问题变严重** —— 那个问题只跟
`extension.js` 有关。

### 情况 B：`extension.js` 的 24 KiB —— **本卡不动，写清楚为什么**

**24 KiB 这道墙后面才是真正的难题**：`extension.js` 一旦能进，用户就会期望它**能跑**，
而现在 `require` 白名单只有 `"vscode"`，53 个 `vscode.*` 成员**一个完整实现都没有**。

**放宽 `extension.js` 的限额，等于承诺一个跑不起来的运行时。** 那是比「装不进来」更坏的体验：
装进去了、能列出、一调用就崩。

**所以本卡只放宽 `package.json`，`extension.js` 保持 24 KiB**，并在 `compat.md` §4 里写清这道墙的理由。

---

## 第三步：把「被哪道限制拒的」变成可断言的事实

**F002 的变异 M3 教了一件事**（它自己发现的）：

> 把 128 KiB 改成 16 MiB 只红 1 条 —— 不是覆盖不足，而是**放宽总尺寸后那个大包仍然被拒，
> 只是换成了条目限额拒**。所以「被拒绝」那条绿是**正确行为**。
> 真正该红的是「**被哪道限制拒的**」，而这条断言是我第一版没有的。

**所以本卡必须让错误信息可区分。** 现在四种拒绝各抛什么：

```ts
throw Error("VSIX size out of L1 bounds");                    // 总尺寸
throw Error("Missing or oversized VSIX manifest/entry");      // 单文件（笼统！）
```

**第二条把「manifest 超」和「main 超」混在一个消息里** —— 这正是 M3 那种情况无法断言的原因。

**要求**：拆成可区分的错误，例如：

```ts
throw Error("VSIX manifest exceeds 65536 B (got " + n + ")");
throw Error("VSIX main entry exceeds 24576 B (got " + n + ")");
```

**注意**：改错误信息会牵动现有的调用方与套件断言。**先 `grep` 谁在读这些字符串**

**⚠️ 我已经替你 grep 过了，这里有一处确定会撞**：

```ts
// apps/desktop/scripts/vsix-deflate-smoke/main.ts:195  （F002 建的）
!bigRes.ok && /size out of L1 bounds/.test(bigRes.error)
            && !/exceeds L1 bound|Missing or oversized/.test(bigRes.error),
```

**这条断言的正则里明确排除了 `Missing or oversized` 和 `exceeds L1 bound`。**
也就是说：**你把笼统那句拆开、让错误信息包含 "exceeds"，它会立刻红。**

**这是好事，不是障碍** —— 它证明 F002 那条断言真的在守「被哪道限制拒的」。
**你要做的不是绕过它，是理解它然后更新它**：

- 那条断言想守的是「大包被**总尺寸**那道拒，不是被别的道拒」；
- 拆开之后，总尺寸那条仍然报 `size out of L1 bounds`（不变），所以它的**主要条件仍成立**；
- 变的是它顺手排除掉的两个词中的 `exceeds` —— 而新的 manifest/main 消息会含这个词。
- **改法**：把排除项收窄到**只有总尺寸那条不会出现**的词，或者改成正面断言
  （「错误信息里包含具体限额数字」）。

**改它的时候保持它的原意**：它不是在验措辞，是在验**失败原因可区分**。
**如果你的新实现让「大包」和「manifest 超」报同一个错，那这条断言应该红，你不该改它。**

**先 `grep` 完整清单，别只信我这一条**：

```bash
grep -rn "oversized VSIX\|size out of L1\|exceeds the L1\|exceeds L1" apps/desktop/scripts/ apps/desktop/src/
```

改了要一起更新，别让旧套件无辜变红。

---

## 验收判据

1. **第一步的结论有出处**（有依据就引依据，没依据就写「没找到」）；
2. **`package.json` 限额放宽后，`rainbow-csv` 的 `package.json` 能读出来**（真实文件，不是造的）；
3. **`extension.js` 的 24 KiB 限额仍在**（负控：本卡不放宽它）；
4. **四种拒绝各自可区分**（总尺寸 / manifest 超 / main 超 / CRC 不符），各有一条断言；
5. **旧套件不无辜变红** —— 改了错误信息就同步更新它们的断言；
6. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| 把 manifest 限额改回 4096 | **1 条红**（真实 package.json 读不出） |
| **顺手把 extension.js 限额改成 16 MiB** | **1 条红**（负控：本卡不放宽它）—— **这条是防执行者顺手**，和 F002 的 M3 同型 |
| 错误信息退回笼统的一句 | **≥1 条红**（可区分性那组） |
| 去掉 CRC 校验 | **≥1 条红**（F002 已有的负控应保持） |

---

## 边界

**只改**：
- `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
- 新建 `apps/desktop/scripts/vsix-size-limits-smoke/`
- `docs/planning/extension-vscode-compat.md`（只补 §4 的限额依据，别重写全文）
- 本卡回写

**不碰**：
- `ModuleHost`（自有扩展路径）；
- `packages/contracts/**`；
- `tasks/F/F002-vsix-deflate.md`（已完成，别改）；
- `tasks/` 主目录与 `tasks/README.md`（另一个总控的）。

---

## 回写

1. **4096 / 24576 有没有依据** —— 引出处，或明说没找到；
2. 放宽后 `rainbow-csv` 的 `package.json` 读出来是什么（贴关键字段）；
3. 四种拒绝的错误信息原文；
4. 变异四条结果（预期 vs 实际）；
5. **改了错误信息之后，旧套件有没有变红** —— 有就说明影响了哪些；
6. 提交 SHA。

---

## 结果回写

### 1. 4096 / 24576 有没有依据 —— **没有，明说**

四条线索全查了：

| 查的地方 | 结果 |
|---|---|
| `git show 68a7121c`（限制最初引入） | **提交信息是空的**（只有标题，无正文） |
| `68a7121c` 新增的 compat.md 80 行 | grep `4096\|24576\|size\|limit` → **零命中** |
| `docs/planning/extension-vscode-compat.md` §4 | 从未写过理由（原 §4 只说「无动态 ZIP 解压器」，没提限额） |
| `tasks/archive/legacy-2026-10-22/` 的 `EXTENSION-ROADMAP-legacy.md` / `T14-extension-vscode-l2.md` | 两个数字**零命中** |
| 全仓 grep `4096 B\|24576\|24 KiB\|128 KiB` | 除我自己的 `.tmp/` 探针与新套件外，只有 **T80 的回写**命中 |

**T80 回写里那句话反而证明它当年就发现了歧义**：

> `「Missing or oversized」到底是 manifest 超 4 KiB 还是 entry 超 24 KiB？`

**但它只记录了边界值（4096 过 / 4097 红），没有记录为什么是这些值。**

**结论：4096 / 24576 是 L1 原型阶段随手定的安全边界，没有推导依据。**
所以放宽 `package.json` 不是「违反设计」，是「补上一个从未有过的决定」。

### 2. 放宽后 `rainbow-csv` 的 `package.json` 读出来是什么

用**真实文件字节**（17 021 B）+ 一个尺寸合规的占位 main（真实 main 超 24 KiB，本卡不放宽）：

```
真实 package.json 17021 B / extension.js 136516 B
包大小 4008 B
读取成功。package.json 关键字段：
  name=rainbow-csv  publisher=mechatroner  version=3.24.1
  displayName=Rainbow CSV
  commands 条数=24
  main=./extension

全真实包：被拒 → Error: VSIX DEFLATE main entry exceeds 24576 B (header declares 136516)
```

**验收判据第 2 条达成**（真实 package.json 能读，24 条命令都在）；第 3 条也成立（`extension.js` 那道墙还在）。

### 3. 四种拒绝的错误信息原文

```
总尺寸：  Error: VSIX size out of L1 bounds
manifest：Error: VSIX manifest exceeds 65536 B (got 65537)
main：    Error: VSIX main entry exceeds 24576 B (got 24577)
CRC：     Error: VSIX CRC mismatch
```

（`(got N)` 里是实际大小 —— 让排查时不用再猜「到底超了多少」。）

### 4. 变异四条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 manifest 改回 4096 | 红 3 条 | **红 5 条** |
| M2 顺手把 extension.js 改成 16 MiB | 红 2 条 | **红 5 条** |
| M3 错误信息退回笼统一句 | ≥1 条 | **红 5 条**（修过之后，见 §5） |
| M4 去掉 CRC 校验 | ≥1 条 | ✅ 红 1 条 |

**M1/M2 比预期多红是好事** —— 边界那条（`== 65536` 恰好通过）、真实尺寸那条也跟着红了，
说明断言不是只守一个点。

**M2 单独验过它红得对**（卡里要求「这次你要亲自验」）：

```
FAIL ★ main == 24577 B 被拒（24 KiB 这道墙还在）
FAIL ★ 拒绝信息点名 main 与 24576
FAIL ★ 136516 B（rainbow-csv 的 extension.js 实测大小）仍被拒 —— 有意为之
FAIL ★ 且拒绝理由是 main 限额（不是别的道）
```

**四条都在说同一件事：`extension.js` 那道墙被人放开了。**

### 5. ⚠️ M3 第一版 **0 条红** —— 发现一处死代码

**这是本卡最重要的发现，不是套件写错了，是我改的那处校验在 DEFLATE 路径上不可达。**

第一次跑 M3（把四句拆开的错误退回一句笼统的），套件 **21/21 全绿**。查下去：

**DEFLATE 包在解压前就用 `limitFor()` 卡了声明尺寸**（防止有人声称解压出 4 GiB 撑爆内存），
所以它**根本走不到** `manifest.byteLength > MANIFEST_LIMIT` 那道最终校验。

**也就是说：我改的那处拆细，对 DEFLATE 包是死代码，只有 STORE 包才走到它。**

**修法**：超限的 fixture 改用 **STORE** 造（STORE 没有「声明尺寸」这一步，
最终校验是它唯一的一道）。改完 M3 红 5 条，其中最关键的是：

```
FAIL ★ 四种拒绝的错误信息两两不同（真的可区分）
      {"all":["Error: VSIX size out of L1 bounds",
              "Error: Missing or oversized VSIX manifest/entry",
              "Error: Missing or oversized VSIX manifest/entry",
              "Error: VSIX CRC mismatch"]}
```

**两条一模一样 —— 正是「不可区分」的机器表达。**

（顺带：这也说明 F002 的变异 M3「只红 1 条」当时看着像覆盖不足，其实是同一个机制的两面。）

### 6. 改了错误信息之后，旧套件有没有变红

**有，而且是按卡预判的那一处。** `vsix-deflate-smoke:199` 的正则排除了
`exceeds L1 bound`，新消息是 `main entry exceeds 24576 B` —— 撞了上。

**但我没有放宽它，我按它的原意收紧了它**：

```ts
// 改前（按措辞排除）
!bigRes.ok && /size out of L1 bounds/.test(bigRes.error) && !/exceeds L1 bound|Missing or oversized/.test(bigRes.error),
// 改后（按数值正面断言）
!bigRes.ok && /size out of L1 bounds/.test(bigRes.error) && !/24576|65536|manifest|main entry/.test(bigRes.error),
```

**理由**：这条断言验的是「被哪道限制拒的」，不是措辞。**措辞会变，限额数字不会。**
同理 `main 那条` 从 `/exceeds L1 bound/` 改成 `/main entry/ && /24576/`。

**跑完三套全绿**：
```
vsix-deflate-smoke:      24/24 通过（F002 的）
vsix-size-limits-smoke:  21/21 通过（本卡的）
vscode-l1-smoke:         27/27 PASS（原有的，不受影响）
```

### 7. 提交

`b1045bb9`（6 文件，+436/−18）。`npx tsc --noEmit -p apps/desktop/tsconfig.json` exit 0。
四条变异全部红在正确位置，还原逐字节 `SAME (0ec0d480...)`。

### 8. 觉得不对但没改的

1. **`128 KiB` 总限额和「恰好 2 个 entry」同样没有依据** —— 和 4096 是同一批随手定的。
   本卡没动它们（卡里只让动单文件限额），但下一张卡如果要碰，**别以为它们有设计意图**。
2. **`extension.js` 那道墙后面的真难题没解**：要让 rainbow-csv 这种 136 KB 的入口进得来，
   得先有运行时（53 个 `vscode.*` 成员一个完整实现都没有）。**这不是「再放宽一个数字」能解决的**，
   建议单开一张卡评估「做运行时」vs「明确告知用户装得进但跑不了」。
3. **`limitFor()` 里对未知条目名直接 throw** —— 现在只有两个白名单条目，走不到；
   将来加条目时忘了配限额，会得到一句 `VSIX entry has no size limit configured` 而不是静默放行。
   这是有意的 fail-closed，但没写测试（新条目要同时改 schema 和这里，套件会先红）。
