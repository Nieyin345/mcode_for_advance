/**
 * MAINT-2026-09 / M10 · worktree 删除边界冒烟
 *
 * 被测:`@main/lib/worktreeOps.ts` 的 removeWorktree(真 git、真 worktree add,
 * 只替换 electron / 仓库层 / RuntimeManager / 广播 / 日志)。
 *
 * 关注点 —— "哪些目录它有权递归删":removeWorktree 在路径**未注册**为本仓库
 * 工作树时会跳过全部数据安全闸(脏检查、补丁导出),直落 `rm -rf worktreePath`;
 * 而 IPC 层(`ipc/git.ts` 的 GIT_WORKTREE_REMOVE)只校验 repoPath —— 工作树按设计
 * 住在所有项目根之外,于是 worktreePath 完全由调用方决定。本套件钉死这条边界,
 * 同时守住它本来要修的两条自愈路径(半拆残留、旧受管根)不被误伤。
 */
import { mkdir, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { removeWorktree, createBranchedWorktree, createDetachedWorktree, mergeBackWorktree } from "@main/lib/worktreeOps.js";
import { sessionsByWorktree, runningIds } from "./stubs.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true).catch(() => false);
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}
function resetStubs(): void {
  sessionsByWorktree.length = 0;
  runningIds.length = 0;
}

const WT_ROOT = process.env.MCODE_M10_WT_ROOT as string;

/** 一个真仓库,带一个初始提交。 */
async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "mcode-m10-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "smoke@example.invalid");
  git(repo, "config", "user.name", "M10 Smoke");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "a.txt"), "hello\n", "utf8");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function main(): Promise<void> {
  const repo = await makeRepo();
  const cleanup: string[] = [repo];

  /* ── 1) 越界删除:未注册 + 与本仓库毫无关系的目录 ───────────────────────
   * 这是 P0 断言。模拟渲染端送来一个任意路径(错误的 UI 状态、被污染的
   * 渲染进程、或者只是用户在设置里改过受管根之后的陈旧条目)。
   * 期望:拒绝,且目录**一个字节都不能少**。 */
  {
    resetStubs();
    const victim = mkdtempSync(join(tmpdir(), "mcode-m10-victim-"));
    cleanup.push(victim);
    await mkdir(join(victim, "sub"), { recursive: true });
    await writeFile(join(victim, "sub", "important.txt"), "用户的东西\n", "utf8");

    const res = await removeWorktree(repo, victim);
    check("越界:拒绝删除不属于本仓库、也不在受管根下的目录", res.ok === false,
      `实际 ok=${res.ok}`);
    check("越界:目标目录及其内容原样保留",
      (await exists(join(victim, "sub", "important.txt"))),
      "目录已被递归删除 —— 任意路径 rm -rf");
  }

  /* ── 2) 正常路径:已注册的干净工作树可以删 ─────────────────────────── */
  {
    resetStubs();
    const wt = join(WT_ROOT, "clean-1");
    const c = await createDetachedWorktree(repo, wt);
    check("前置:干净工作树创建成功", c.ok === true, JSON.stringify(c));
    const res = await removeWorktree(repo, wt);
    check("正常:已注册的干净工作树删除成功", res.ok === true, JSON.stringify(res));
    check("正常:目录已消失", !(await exists(wt)));
  }

  /* ── 3) 数据安全闸:脏工作树,不给 force 必须拒 ───────────────────── */
  {
    resetStubs();
    const wt = join(WT_ROOT, "dirty-1");
    await createDetachedWorktree(repo, wt);
    await writeFile(join(wt, "a.txt"), "改过了\n", "utf8");
    const res = await removeWorktree(repo, wt);
    check("安全闸:脏工作树未加 force 被拒", res.ok === false, JSON.stringify(res));
    check("安全闸:被拒后目录仍在", await exists(wt));
    const forced = await removeWorktree(repo, wt, { force: true, exportPatch: true });
    check("安全闸:force 后删除成功", forced.ok === true, JSON.stringify(forced));
    check("安全闸:导出了补丁文件",
      !!forced.patchPath && (await exists(forced.patchPath)),
      `patchPath=${forced.patchPath}`);
    check("安全闸:目录已消失", !(await exists(wt)));
  }

  /* ── 4) 运行中的会话拦截删除 ─────────────────────────────────────── */
  {
    resetStubs();
    const wt = join(WT_ROOT, "busy-1");
    await createDetachedWorktree(repo, wt);
    sessionsByWorktree.push({ id: "s-busy" });
    runningIds.push("s-busy");
    const res = await removeWorktree(repo, wt);
    check("会话:运行中回合阻止删除", res.ok === false, JSON.stringify(res));
    check("会话:目录仍在", await exists(wt));
    runningIds.length = 0;
    const res2 = await removeWorktree(repo, wt);
    check("会话:停止后可删", res2.ok === true, JSON.stringify(res2));
  }

  /* ── 5) 自愈路径 A:受管根下的半拆残留(未注册但是我们自己的地盘) ── */
  {
    resetStubs();
    const stale = join(WT_ROOT, "stale-halftorn");
    await mkdir(join(stale, ".git-leftover"), { recursive: true });
    await writeFile(join(stale, "junk.txt"), "leftover\n", "utf8");
    const res = await removeWorktree(repo, stale);
    check("自愈A:受管根下的未注册残留仍被清理", res.ok === true, JSON.stringify(res));
    check("自愈A:残留目录已消失", !(await exists(stale)));
  }

  /* ── 6) 自愈路径 B:不在当前受管根下,但有会话行指着它(旧受管根) ─── */
  {
    resetStubs();
    const legacy = mkdtempSync(join(tmpdir(), "mcode-m10-legacyroot-"));
    cleanup.push(legacy);
    const stale = join(legacy, "old-wt");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "junk.txt"), "leftover\n", "utf8");
    sessionsByWorktree.push({ id: "s-legacy" });
    const res = await removeWorktree(repo, stale);
    check("自愈B:会话行引用的旧根残留仍被清理", res.ok === true, JSON.stringify(res));
    check("自愈B:残留目录已消失", !(await exists(stale)));
  }

  /* ── 7) 分支式工作树:已合并的 mcode/* 分支随工作树回收 ─────────── */
  {
    resetStubs();
    const wt = join(WT_ROOT, "branched-1");
    const c = await createBranchedWorktree(repo, wt);
    check("分支式:创建成功", c.ok === true, JSON.stringify(c));
    const res = await removeWorktree(repo, wt);
    check("分支式:删除成功", res.ok === true, JSON.stringify(res));
    const branches = git(repo, "branch", "--list", "mcode/*");
    check("分支式:未产生新提交时生成分支被回收", branches.trim() === "",
      `残留:${branches.trim()}`);
  }

  /* ── 8) merge-back 的同一条边界:未注册路径不得被自动提交 ──────────
   * mergeBackWorktree 拿到 worktreePath 的第一件事就是「脏就 git add -A &&
   * git commit」。路径同样来自调用方且同样没有校验,指向一个无关仓库时会
   * 把用户那边的工作区**静默提交**掉,再把它的历史合进项目仓库。 */
  {
    resetStubs();
    const foreign = mkdtempSync(join(tmpdir(), "mcode-m10-foreign-"));
    cleanup.push(foreign);
    git(foreign, "init", "-q", "-b", "main");
    git(foreign, "config", "user.email", "smoke@example.invalid");
    git(foreign, "config", "user.name", "M10 Smoke");
    await writeFile(join(foreign, "draft.txt"), "写了一半的东西\n", "utf8");
    git(foreign, "add", "draft.txt");
    git(foreign, "commit", "-q", "-m", "init");
    await writeFile(join(foreign, "draft.txt"), "还在改\n", "utf8");

    const res = await mergeBackWorktree(repo, foreign);
    check("merge-back:拒绝未注册为本仓库工作树的路径", res.ok === false,
      JSON.stringify(res));
    const st = git(foreign, "status", "--porcelain").trim();
    check("merge-back:无关仓库的工作区没有被自动提交", st !== "",
      "对方的未提交改动已被 commit 掉");
  }

  /* ── 9) 回归:合法的 merge-back 不能被新闸门误杀 ─────────────────── */
  {
    resetStubs();
    const wt = join(WT_ROOT, "mergeok-1");
    await createBranchedWorktree(repo, wt);
    await writeFile(join(wt, "b.txt"), "worktree 里的新文件\n", "utf8");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-q", "-m", "work in worktree");
    const res = await mergeBackWorktree(repo, wt);
    check("回归:已注册工作树可以正常合并回主仓库", res.ok === true, JSON.stringify(res));
    check("回归:主仓库拿到了工作树里的提交", await exists(join(repo, "b.txt")));
    await removeWorktree(repo, wt, { force: true });
  }
  for (const d of cleanup) await rm(d, { recursive: true, force: true }).catch(() => {});
  console.log(`\nmaint-m10-smoke: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("maint-m10-smoke crashed:", err);
  process.exitCode = 1;
});
