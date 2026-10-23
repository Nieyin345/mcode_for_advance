# T44｜genoffice 三套并发安全 —— **防回退回归**（T31 已修复）

- Status: done（2026-10-23 验收通过：15/15，提交 d1a5a0f7）
- Category: test（回归网）
- Priority: **P2**
- Depends on: **T31（`a10c705c`，已完成修复）**
- Exclusive writable files: 新建 `apps/desktop/scripts/genoffice-suite-isolation-smoke/`（或类似名），必要时 `apps/desktop/scripts/genoffice-source-smoke/main.cjs`（仅加断言，不改行为）。

## Required Skills
- `mcode-smoke`: 理解这个仓库的无头套件布局、`run.sh` 的 cwd 约束、变异验证。
- `codebase-design`: 判断静态守卫该盯哪个符号。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/genoffice-source-smoke/main.cjs`（**重点看 L28、L124-141、L244-247**）、`apps/desktop/scripts/genoffice-vendor-freshness-smoke/`、`apps/desktop/scripts/t87-genoffice-provenance-license-smoke/`、`git show a10c705c`。

## ⚠️ 这张卡的第一版写错了（总控失误，已更正）

**原卡说「`genoffice-source-smoke/main.cjs` 原地篡改真实 vendor 工作树」——那是 T31 修复前的代码。**

```
a10c705c  2026-10-23 15:03  fix(T31): unblock run-smokes --all and repair two stale GenOffice fixtures
466a4dae  2026-10-23 19:04  docs(tasks): open T44 - genoffice suites trample the real vendor tree
```

**T44 在修复之后 4 小时写的，描述的是修复前的状态。** 写卡时没核这条线，是总控的失误。

## 现状（C 会话实测，总控核实）

**T31 的修法已经是对的**：

```js
// main.cjs:128-132 —— 克隆到 OS 临时目录，只改副本
const fixtureRoot = path.join(base, "lineage-fixture");
const clone = path.join(fixtureRoot, "genoffice");
execFileSync("git", ["clone", "--local", "--no-hardlinks", vendorReal, clone], { ... });
```

```js
// main.cjs:244-247 —— **卡上完全没提到的**断言
check("real GenOffice vendor checkout was not modified", () => {
  assert.equal(git(vendorReal, "rev-parse", "HEAD"), realHead);
  assert.equal(git(vendorReal, "status", "--porcelain", "--untracked-files=all"), realHeadStatus);
});
```

`t87` 也用副本（`createVerifyRoot` → `os.tmpdir()`）；`genoffice-vendor-freshness-smoke` 纯读。

**实测三件事（C 会话）**：

| 实验 | 结果 |
|---|---|
| 并发 3 轮 × 3 套同时跑 | **9/9 全绿** |
| Ctrl-C 中断 `genoffice-source-smoke` | 真实 vendor `git status` **干净** |
| 克隆耗时（4764 文件） | **5.6 秒**（若真要改 (A)，成本可接受——但不需要改） |

## 那这张卡做什么

**不做「修并发」——没有可修的缺陷。做「防止回退」。**

T31 之所以要修，恰恰因为**曾经有人写成了原地篡改**。那次是怎么发生的，下一次还会怎么发生。现在**没有任何东西保证它将来仍然对**。

### 三条断言

#### ① 静态守卫（**主力，毫秒级，最便宜**）

断言 `genoffice-source-smoke/main.cjs`（以及其余 genoffice 套件）**不存在对真实 vendor 的写操作**：

- 任何 `writeFileSync` / `rmSync` / `appendFileSync` / `unlinkSync` 的参数里出现 `vendorReal` / `repoRootReal + "genoffice"` → 违规；
- 任何 `execFileSync("git", [...])` 的**非只读子命令**（`checkout` / `reset` / `stash` / `apply` / `commit` / `clean`）作用在真实 vendor 上 → 违规；
- 断言 `main.cjs` 里存在 `git clone` 到临时目录（正向证明而非只查反向）。

**这条最关键**：它不跑测试就能抓到「有人改回原地写」。

#### ② 中断后干净

启动 `genoffice-source-smoke`，跑到一半 `SIGINT`，然后断言：

```bash
git -C genoffice status --porcelain --untracked-files=all   # 必须为空
```

**T31 的 clone 方案保证了它，但没人验过。**

#### ③ 并发全绿

三套同时跑，全部 exit 0。已实测 9/9，固化成常驻回归。

## 验收判据

1. 新套件跑通，三条断言都真跑。
2. **变异验证**：
   - 把 `main.cjs` 的 `clone` 改成直接操作 `vendorReal` → **静态守卫必须红**；
   - 中断测试：人为在中断后留一个脏文件 → **断言必须红**。
3. 中断测试要有超时保护（不能挂）。
4. 双包 typecheck 通过。

## 边界

- **不改** `genoffice-source-smoke` 的**行为**（T31 的修法是对的），只允许加断言。
- **不碰** `genoffice/` 上游源码。
- **不碰** `ipc/index.ts`（E 的 T40）、`documentToolSurface.ts` / `genofficeCli.ts`（B 的 T43）、`renderer/`。
- **不批量改** 那 261 个 `$0` 脆弱的 `run.sh`（那是另一个决定，见下）。

## 关于 261 个 `$0` 脆弱套件（与本卡无关，记录一个决定）

442 个用 `esbuild-path.sh` 的套件里，261 个有同样的 `$0` 相对路径脆弱点：`cd "$(dirname "$0")/../.."` 之后再用 `$(dirname "$0")`。

**它们不是缺陷**（`run-all-smokes.sh` 会先 cd 到 `apps/desktop`），但**从仓库根手跑会失败，且错误信息看起来像套件坏了**。

**总控决定：不改那 261 个文件**（收益是省一次困惑，成本是 261 文件的 diff，在当前多会话并行下会让所有人分不清谁改了什么）。

**更有效的替代**：让 `esbuild-path.sh` 找不到时打印「请从 apps/desktop 运行」——一句话覆盖 261 个套件。**但这在 `scripts/lib/` 下，等本轮收口再处理，不在本卡范围内。**

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

`git add <明确路径>` 后**立刻** `git commit -m "<信息>" -- <明确路径>`。**`-m` 必须在 `--` 前面。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T44-genoffice-suite-concurrency.md` 末尾追加 `## 结果回写（2026-10-23）`：三条断言的实现、变异证据、中断测试的做法与超时保护、提交 SHA。

---

## 结果回写（2026-10-23，C 会话）

### 1. 根因复核:**原卡的根因描述在 T31 之后不成立**

时间线（`git log` 实测）：

```
a10c705c  2026-10-23 15:03  fix(T31): unblock run-smokes --all and repair two stale GenOffice fixtures
466a4dae  2026-10-23 19:04  docs(tasks): open T44 - genoffice suites trample the real vendor tree
```

**T44 原卡是在 T31 修复之后 4 小时写的,但描述的是修复前的代码。**

`git show a10c705c -- apps/desktop/scripts/genoffice-source-smoke/main.cjs` 的实际改动:

```
+ const vendorReal = path.join(repoRootReal, "genoffice");
+ const fixtureRoot = path.join(base, "lineage-fixture");
+ const clone = path.join(fixtureRoot, "genoffice");
+ execFileSync("git", ["clone", "--local", "--no-hardlinks", vendorReal, clone], {
```

现在全部篡改作用在 `clone` 上,且 L244-247 **显式断言真实 vendor 未变**:

```js
assert.equal(git(vendorReal, "rev-parse", "HEAD"), realHead);
assert.equal(git(vendorReal, "status", "--porcelain", "--untracked-files=all"), realHeadStatus);
```

`t87-genoffice-provenance-license-smoke` 同样早已用副本(`createVerifyRoot` → `os.tmpdir()`);
`genoffice-vendor-freshness-smoke` 是**纯读**。

### 2. 实测:竞争与脏状态**都不存在**

| 验证 | 结果 |
|---|---|
| 三套并发 × 3 轮(9 次运行) | **9/9 exit 0** |
| Ctrl-C 中断 `genoffice-source-smoke` 后 | `git -C genoffice status --porcelain --untracked-files=all` → **空** |
| `git clone --local` 耗时(4764 文件) | **5.6 秒**(若真要改 (A) 成本可接受) |

**所以本卡没有可修的产品缺陷。** 总控据此把卡改成「防回退回归」,Priority P1 → P2。

### 3. 交付:一套防回退回归,三层判据

新套件 `genoffice-suite-isolation-smoke`,**15 条**。三层按**成本从低到高**排,主力是第一层:

#### ① 静态守卫(毫秒级,主力)

扫三套的源码,断言 `vendorReal` 只出现在**读**的位置。它不启动任何进程,所以每次跑测试都能跑。

判据演进(这里有一次**真的被变异抓到**的返工,见 §4):

- **第一版**只查「同一行既有 `vendorReal` 又有写调用」。变异证明它**抓不到**真实违规形态 ——
- **第二版**改为**数据流追踪**:先找出所有 `const x = … vendorReal …` 的派生变量,
  再检查这些变量是否被写。因为真实的两行写法是:

```js
const file = path.join(vendorReal, "apps/docs/…");   // 这行只有派生,没有写
fs.writeFileSync(file, saved + "…");                  // 这行只有写,没有 vendorReal
```

派生追踪是**保守**的:只认 `const|let|var <单个名字> = … <realVar> …`,多声明/解构一律跳过 ——
宁可漏报也不误报,误报会让守卫变成噪声、最后被关掉。

另有两条配套断言:
- **必须 clone 到临时目录**(只对需要篡改的两套要求;freshness 纯读,不该被强制 clone);
- **守卫自身的防空过**:拿三种典型违规形态喂进判据,必须全部被抓到 —— 否则这就是一条永远绿的断言。

#### ② 并发全绿(~25-45s)

三套同时 spawn(cwd = `apps/desktop`,与 `run-all-smokes.sh` 一致),全部必须 exit 0。

#### ③ 中断后干净(~3s,有超时保护)

SIGINT `genoffice-source-smoke`(2.5s 后),然后断言 `git -C genoffice` 的 HEAD 与
`status --porcelain --untracked-files=all` **逐字未变**。

> 总控特别要求「要有超时保护,不能挂」——实现里 `setTimeout` 挂在子进程上,
> `close` 时清掉;子进程若无视 SIGINT 会自己退出(`run.sh` 的 `set -euo pipefail`),
> 不会无限等。

**vendor 缺失时显式 SKIP 并 exit 0**,与三套自己的约定一致 —— 不假装验过。

### 4. 变异验证(两次,第一次抓出了我自己守卫的漏洞)

| # | 变异 | 结果 |
|---|---|---|
| **M1** | `const file = path.join(clone, …)` → `path.join(vendorReal, …)` | **第一版守卫仍然绿** ← 漏洞 |
| **M1'** | 修好守卫后重做同一个变异 | **13/15**,detail 精确点名 `line 165/167/172` 的三处 `writeFileSync(file, …)` |

M1 那次**守卫没红**是本卡最有价值的发现:变异不是用来"证明修复有效"的装饰,它**测的是断言本身**。
如果没有这一轮,这套回归会带着一个「只抓同行写法」的盲区上线 —— 而那恰好**不是**真实违规的形态。

变异前 `cmp -s` 确认文件确实改了、`node --check` 确认语法完好(这一条是血的教训:
本会话更早时我的一次变异把 Python 转义写坏、跑出的"红"其实是 `SyntaxError`,
不是断言失败)。还原后 `cmp -s` 逐字节一致,SHA-256 回到 `33ed65bc…`。

### 5. 验证

| 项 | 结果 |
|---|---|
| `genoffice-suite-isolation-smoke` | **15/15**,exit 0 |
| `run-smokes.mjs --list --all` 发现 | ✅(计入总套数) |
| 三套单跑 | 全绿(由本套件 ② 覆盖) |
| 双包 typecheck | contracts **0**、desktop **0** |
| 中断后 `genoffice/` 工作树 | 干净(0 条) |

### 6. 边界遵守

- 只新增 `apps/desktop/scripts/genoffice-suite-isolation-smoke/`;
- **未改** `genoffice/` 上游源码;
- **未改** `ipc/index.ts`(A)、`documentToolSurface.ts` / `genofficeCli.ts`(B)、
  `renderer/`(C 的 T41)、`electron-u1/`(E);
- **未改** `run-all-smokes.sh` 的并发策略;
- **未动** 三套被测套件的一行代码(它们是健康的)。

### 7. 给将来的人

如果你正读到这套回归红了,按这个顺序判断:

1. **静态守卫红** → 有人对真实 `genoffice/` 写了东西。**先还原再谈别的**,
   然后看那条 `writeFileSync` / git 子命令是不是新加的。
2. **并发红** → 先单跑那套。单跑绿而并发红,说明有共享状态没被隔离。
3. **中断后脏** → 说明某套在真实工作树上做了不可回滚的写。这是**最严重**的形态,
   因为它会让人误以为 `genoffice-upstream.lock.json` 的补丁链坏了。
