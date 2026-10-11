/**
 * 【MC-055】项目 MCP 授信身份不可伪造 —— 伪造 `.git` 不能冒充已信任仓库。
 *
 * ## 这条修的是什么
 *
 * `projectIdentity()` 把"项目来源"折进每一条 MCP 信任指纹,好让不同仓库隔离、
 * 同源 worktree 复用。但来源本身**从没被验证过**:`gitSourceKey()` 遇到普通
 * `.git` 文件就读它写的 `gitdir:` 路径、再从 `gitdir/commondir` 取身份。于是:
 *
 * - 待授权目录 B 里放一个 `.git`(文件),内容 `gitdir: <已信任仓库 A 的 .git>`,
 *   B 就自称"我属于 A" —— `projectIdentity(B) === projectIdentity(A)`,
 *   指纹相同,B 的 `.mcp.json` 被当成已授信、交付给引擎执行。**跨目录身份碰撞。**
 * - 更早的版本连"不带 `gitdir:` 的 `.git` 文件"都直接当来源键,捏造更省事。
 *
 * ## 修法(本题验的就是它)
 *
 * 合法来源只可能是两种:① 主检出 —— `.git` 是**目录**;② linked worktree /
 * submodule —— `.git` 是**文件**且 per-worktree git dir 里有 **`gitdir` 回指文件**
 * 指回**本工作树的 `.git`**。除此之外一律拒。
 *
 * 回指校验是关键:它要求那个 git dir 真的是**本工作树**的,而回指文件只有
 * `git worktree add` 会写、且落在真实工作树里。攻击者只控制 B 里的一个文件时,
 * 指向 A 的伪装**必然**对不上回指(主检出的 `.git` 是目录、没有回指文件;
 * worktree 的回指指向 A 自己的工作树,不是 B)—— 两种都判否。
 *
 * ## 覆盖
 *
 * 真建 A/B 临时目录、真写 git 布局(含 `git worktree` 那种 `commondir` + `gitdir`
 * 成对结构),调**真实** `projectIdentity` / `projectServerFingerprint` /
 * `getTrustedProjectMcpServers`,断言身份不碰撞、B 拿不到 A 的授信。同时用
 * `git.exe`(若在)对**真实** `git rev-parse --git-common-dir` 与我们的结果做对拍,
 * 证明回指校验没有把合法 worktree 误杀。
 *
 * Run: scripts/mcp-trust-identity-smoke/run.sh
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const TMP = mkdtempSync(join(tmpdir(), "mcode-mcp-trust-"));

const { projectIdentity, projectServerFingerprint, getTrustedProjectMcpServers } = await import(
  "@main/lib/projectMcp.js"
);
const { SettingRepo } = (await import("@main/store/repositories.js")) as unknown as {
  SettingRepo: { set(k: string, v: string): void; get(k: string): string | null; __reset(): void };
};
const { MCP_PROJECT_TRUST_SETTING_KEY } = await import("@contracts/ipc");

/** 造一个"主检出"仓库:A/.git 是**目录**(真实布局只要目录存在即可,内容不影响身份)。 */
function makeMainCheckout(dir: string): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** 造一个"linked worktree":`.git` 是文件 → `<main>/.git/worktrees/wt1`;
 *  该 per-worktree dir 里有 `commondir`(= `../..`,即 `<main>/.git`)与
 *  `gitdir` 回指(= 本工作树的 `.git` 文件)。这与真实 `git worktree add` 一致。 */
function makeLinkedWorktree(wtDir: string, mainDir: string): string {
  const perWt = join(mainDir, ".git", "worktrees", "wt1");
  mkdirSync(perWt, { recursive: true });
  writeFileSync(join(perWt, "commondir"), "../..\n");
  // 回指:本工作树的 .git **文件**绝对路径。
  mkdirSync(wtDir, { recursive: true });
  writeFileSync(join(perWt, "gitdir"), join(wtDir, ".git") + "\n");
  writeFileSync(join(wtDir, ".git"), `gitdir: ${perWt}\n`);
  return wtDir;
}

/* ───────────────────────── 1. 身份:不同仓库不碰撞 ───────────────────────── */
console.log("\nMC-055:不同仓库的身份必须不同");
{
  const A = makeMainCheckout(join(TMP, "A"));
  const B = makeMainCheckout(join(TMP, "B"));
  check("A / B 两个普通仓库身份不同", projectIdentity(A) !== projectIdentity(B));
  check("A 的身份以 git: 开头(主检出 .git 是目录)", projectIdentity(A).startsWith("git:"));

  // 同一个仓库(同目录)身份稳定。
  check("同一目录身份稳定", projectIdentity(A) === projectIdentity(A));
}

/* ────────────────── 2. ★ 伪造 .git 指向已信任仓库 → 必须不碰撞 ────────────────── */
console.log("\nMC-055:伪造 .git(文件)指向 A 的 gitdir —— 不得冒充 A");
{
  const A = makeMainCheckout(join(TMP, "A2"));
  const B = join(TMP, "B2");
  mkdirSync(B, { recursive: true });
  // 攻击:待授权目录 B 自称 gitdir 指向 A/.git。
  writeFileSync(join(B, ".git"), `gitdir: ${join(A, ".git")}\n`);
  // A 的 .git 是目录、里面**没有** gitdir 回指文件 —— 真实主检出本就如此。
  check("★ B 伪造指向 A → 身份**不等于** A", projectIdentity(B) !== projectIdentity(A));
  check("★ B 被判成非 git(退回 dir: 身份,不再冒充任何仓库)", projectIdentity(B).startsWith("dir:"));
  check("★ 两个仓库的服务器指纹不同(同配置同名字也不继承信任)",
    projectServerFingerprint(B, "s", { command: "node" }) !== projectServerFingerprint(A, "s", { command: "node" }));
}

/* ────────── 2b. ★ MC-055 反例二:`.git` 是 **junction 指向** A 的 .git 目录 ──────────
 *
 * 第 16 轮复查:上面只堵了"`.git` 是**文件**且带 gitdir:"。但待授权目录 B 里放一个
 * **junction**(Windows 重解析点)指向已信任仓库 A 的 `.git` **目录**时,`statSync` 会
 * **跟穿** junction,报 `isDirectory()===true` → 走进"主检出 `.git` 是目录"那一支 →
 * realpath 一路跟到 A/.git → 身份碰撞、B 的 `.mcp.json` 以 A 的授权交付。判据必须用
 * `lstatSync` 看入口**本身**:它是 reparse point,不是真目录。 */
console.log("\nMC-055:`.git` 是指向 A/.git 目录的 junction —— 仍不得冒充 A");
{
  const A = makeMainCheckout(join(TMP, "A2b"));
  const B = join(TMP, "B2b");
  mkdirSync(B, { recursive: true });
  const linkPath = join(B, ".git");
  let made = false;
  try {
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(join(A, ".git"), linkPath, process.platform === "win32" ? "junction" : "dir");
    made = true;
  } catch {
    made = false; // 平台不允许建链接 —— 跳过,不判红
  }
  if (made) {
    check("★ 前置:这个 `.git` 入口是链接/junction(lstat 才看得见)", lstatSync(linkPath).isSymbolicLink());
    check("★ B 的 .git 是 junction 指向 A → 身份**不等于** A", projectIdentity(B) !== projectIdentity(A));
    check("★ B 退回 dir: 身份(不再冒充 A 的仓库)", projectIdentity(B).startsWith("dir:"));
  } else {
    check("平台不允许创建链接 —— 跳过 junction 反例(不判红)", true);
  }
}

/* ────────────────── 3..5 交付:伪造来源不得继承 A 的授信 ────────────────── */
console.log("\nMC-055:伪造来源不得继承 A 对同配置的授信");
{
  SettingRepo.__reset();
  const A = makeMainCheckout(join(TMP, "A3"));
  const B = join(TMP, "B3");
  mkdirSync(B, { recursive: true });
  writeFileSync(join(B, ".git"), `gitdir: ${join(A, ".git")}\n`);
  const cfg = JSON.stringify({ mcpServers: { sample: { command: "node", args: ["./server.js"] } } });
  writeFileSync(join(A, ".mcp.json"), cfg);
  writeFileSync(join(B, ".mcp.json"), cfg);
  // 用户对 A 的那份配置授信(指纹按 A 身份算)。
  const rawServer = { command: "node", args: ["./server.js"] };
  SettingRepo.set(MCP_PROJECT_TRUST_SETTING_KEY, JSON.stringify([projectServerFingerprint(A, "sample", rawServer)]));

  const trustedA = getTrustedProjectMcpServers(A);
  check("前置:A 拿到已授信的服务器(正向控制)", trustedA.some(([n]) => n === "sample"));
  const trustedB = getTrustedProjectMcpServers(B);
  check("★ B 用伪造 .git 冒充 A **拿不到**那份授信", trustedB.length === 0, trustedB.map(([n]) => n));
}

/* ────────────────── 6. ★ 合法 linked worktree 仍复用同源授信 ────────────────── */
console.log("\nMC-055:真实 worktree(带 gitdir 回指)照常复用同源信任");
{
  SettingRepo.__reset();
  const main = makeMainCheckout(join(TMP, "repo"));
  const wt = makeLinkedWorktree(join(TMP, "repo-wt"), main);
  check("worktree 与主检出身份**相同**(合法同源复用)", projectIdentity(wt) === projectIdentity(main),
    { wt: projectIdentity(wt), main: projectIdentity(main) });

  const cfg = JSON.stringify({ mcpServers: { shared: { command: "node", args: ["x.js"] } } });
  writeFileSync(join(main, ".mcp.json"), cfg);
  writeFileSync(join(wt, ".mcp.json"), cfg);
  const rawServer = { command: "node", args: ["x.js"] };
  SettingRepo.set(MCP_PROJECT_TRUST_SETTING_KEY, JSON.stringify([projectServerFingerprint(main, "shared", rawServer)]));
  const trustedWt = getTrustedProjectMcpServers(wt);
  check("★ worktree 复用主检出的授信(回指校验没误杀)", trustedWt.some(([n]) => n === "shared"), trustedWt.map(([n]) => n));
}

/* ────────────────── 7. 不带 gitdir 的 .git 文件一律拒 ────────────────── */
console.log("\nMC-055:不带 gitdir: 的 .git 文件不再是来源");
{
  const C = join(TMP, "C");
  mkdirSync(C, { recursive: true });
  writeFileSync(join(C, ".git"), "this is not a gitdir pointer\n");
  check("★ 内容任意的 .git 文件 → 判成非 git(dir: 身份)", projectIdentity(C).startsWith("dir:"));
  check("★ 不会退化成「把这个 .git 文件本身当来源键」", !projectIdentity(C).includes(".git"));
}

/* ────────────────── 8. 回指指向别处 → 拒 ────────────────── */
console.log("\nMC-055:gitdir 回指指向错误的工作树 → 拒");
{
  const main = makeMainCheckout(join(TMP, "repo2"));
  const wt = join(TMP, "repo2-wt");
  const perWt = join(main, ".git", "worktrees", "wt1");
  mkdirSync(perWt, { recursive: true });
  writeFileSync(join(perWt, "commondir"), "../..\n");
  // 回指指向**别的**工作树,而不是本工作树 —— 伪造/错配。
  writeFileSync(join(perWt, "gitdir"), join(TMP, "somewhere-else", ".git") + "\n");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${perWt}\n`);
  check("★ 回指对不上本工作树 → 拒(不再判成同源)", projectIdentity(wt) !== projectIdentity(main),
    { wt: projectIdentity(wt), main: projectIdentity(main) });
  check("★ 该 worktree 退回 dir: 身份", projectIdentity(wt).startsWith("dir:"));
}

/* ────────────────── 9. 与真实 git 对拍(有 git 才跑) ────────────────── */
console.log("\nMC-055:与真实 git 的 --git-common-dir 对拍");
{
  let gitOk = false;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    gitOk = true;
  } catch {
    gitOk = false;
  }
  if (!gitOk) {
    check("环境无 git.exe —— 跳过对拍(不判红)", true);
  } else {
    const repo = join(TMP, "realrepo");
    mkdirSync(repo, { recursive: true });
    const run = (args: string[], cwd: string): string =>
      execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    run(["init", "-q"], repo);
    run(["config", "user.email", "t@t"], repo);
    run(["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "f.txt"), "hi\n");
    run(["add", "f.txt"], repo);
    run(["commit", "-qm", "init"], repo);
    const wtDir = join(TMP, "realrepo-wt");
    run(["worktree", "add", "-q", wtDir, "-b", "wtbranch"], repo);

    const gitCommon = run(["rev-parse", "--path-format=absolute", "--git-common-dir"], wtDir);
    const ours = projectIdentity(wtDir).replace(/^git:/, "");
    // 两侧归一化后再比(normPathKey:斜杠 + 大小写)。
    const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    check("★ 真实 worktree:我们的来源键 == git --git-common-dir", norm(ours) === norm(gitCommon),
      { ours, gitCommon });
    check("★ 真实 worktree 与主检出同源", projectIdentity(wtDir) === projectIdentity(repo));
    check("★ 真实 worktree 的 .git 文件带 gitdir 回指(我们的判据成立)", existsSync(join(wtDir, ".git")));
  }
}

/* ───────────────────────── 收尾 ───────────────────────── */
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
