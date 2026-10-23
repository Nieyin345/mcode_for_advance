# T44｜genoffice 三套并发安全 —— **防回退回归**（T31 已修复）

- Status: ready-for-agent
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
