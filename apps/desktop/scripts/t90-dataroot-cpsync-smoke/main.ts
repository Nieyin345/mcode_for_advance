/**
 * 【T90】`dataRoot.ts` 的两处 `cpSync` 在**非 ASCII 路径**上会不会崩。
 *
 * ## 为什么这一套必须用子进程
 *
 * `fs.cpSync` 在 Node 22 + Windows + 非 ASCII 路径下是 **native fast-fail**：
 * 进程直接死（`0xC0000409` / `0xC0000005`），**`try/catch` 接不住，`process.on('exit')`
 * 也不触发**。所以「在同一进程里断言」这个形态根本测不了 —— 测试进程会和被测进程
 * 一起消失，套件连「我失败了」都报不出来。
 *
 * 本套件的做法：
 *
 *   - 父进程（本文件）**自己从不碰非 ASCII 路径的 cpSync**；
 *   - 每个场景 `spawnSync` 起一个子进程跑 `probe.ts`，**读它的 `status`**；
 *   - 子进程崩了，父进程活着，`status` 就是证据。
 *
 * ⚠️ **必须用 `spawnSync(process.execPath, …)` 读 `status`，不能走 `bash`。**
 * bash 把 `>=128` 的退出码折叠成 127，于是 `0xC0000409`（崩溃）和
 * 「command not found」（脚本不存在）长得一模一样。T89 就是在这里误判过。
 *
 * ## 正负控
 *
 * | 场景 | 路径 | 期望 |
 * |---|---|---|
 * | 正控 | 纯 ASCII 的 from/to | 成功，文件真的复制了 |
 * | **负控** | **from 含非 ASCII** | **成功**（修复后）／ `status≠0`（修复前） |
 * | 负控 2 | to 含非 ASCII | 同上 |
 *
 * **两个负控都要有**：`dataRoot` 的两处调用里，`:150` 是 `from`、`to` 都可能是
 * 用户路径，`:198` 的 `to` 是用户**新选**的目录 —— 用户完全可能选一个中文目录名。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "probe.mjs");

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 600)}`}`);
  }
}

const WORK = mkdtempSync(join(tmpdir(), "t90-cpsync-"));
process.on("exit", () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* 清理失败 */ } });

/** 跑一次探针，把 `status` 与结果读回来。
 *
 * ⚠️ **不能只 `readdirSync(to)`**：`copyDataRootTo` 把 `from` 的**内容**复制进
 * `to`，而探针的 `from` 是一个目录 —— 结果落在 `to` 下（有嵌套时还在更深一层）。
 * 而且上游 issue #61878 报告过一种更坏的行为：**目标路径含重音字符时
 * `cpSync` 会「成功返回但一个文件都没复制」**。所以「目录存在」不等于「复制了」，
 * 必须真的找 `a.txt`。
 */
function runProbe(from: string, to: string): { status: number | null; signal: string | null; copied: string[]; stderr: string; result: string } {
  const r = spawnSync(process.execPath, [PROBE, from, to], { encoding: "utf8", timeout: 60_000 });
  const copied = findCopied(to);
  const result = (r.stdout ?? "").split("\n").find((l) => l.startsWith("PROBE_RESULT:")) ?? "";
  return { status: r.status, signal: r.signal, copied, stderr: (r.stderr ?? "").slice(0, 400), result };
}

/** 在 `to` 下递归找源里的两个关键文件（最多 4 层）。
 *
 * 返回**找到了哪些**，而不是布尔 —— 断言要能区分「全复制了」「只复制了一部分」
 * 「一个都没复制」三种情况。
 */
function findCopied(to: string, depth = 0): string[] {
  if (depth > 4) return [];
  let names: string[];
  try {
    names = readdirSync(to);
  } catch {
    return [];
  }
  const found: string[] = [];
  if (names.includes("a.txt")) found.push("a.txt");
  if (names.includes("b.txt")) found.push("b.txt");
  // 本层就找到了，不用再往下 —— `a.txt` 和 `b.txt` 在不同层时除外（b 在 nested/ 里）。
  if (found.length >= 2) return found;
  for (const name of names) {
    for (const hit of findCopied(join(to, name), depth + 1)) {
      if (!found.includes(hit)) found.push(hit);
    }
    if (found.length >= 2) break;
  }
  return found;
}

/** 造一个 `from` 目录，里面放两个文件（一个嵌套）。 */
function makeSource(name: string): string {
  const dir = join(WORK, name);
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "alpha\n", "utf8");
  writeFileSync(join(dir, "nested", "b.txt"), "beta\n", "utf8");
  return dir;
}

/* ───────────────────── 1. 正控：纯 ASCII 路径 ───────────────────── */

console.log("\n1. 正控：纯 ASCII 的 from/to → 不崩且真的复制了");
{
  const from = makeSource("ascii-src");
  const to = join(WORK, "ascii-dst");
  const r = runProbe(from, to);
  check("status === 0（没有崩）", r.status === 0, r);
  check("两个文件都复制过去了（含嵌套那个）",
    r.copied.includes("a.txt") && r.copied.includes("b.txt"), r);
}

/* ───────────────────── 2. 负控：from 含非 ASCII ───────────────────── */

console.log("\n2. ★ 负控：from 路径含中文 —— 修复前这里会让进程死");
{
  const from = makeSource("中文源目录");
  const to = join(WORK, "dst-from-cn");
  const r = runProbe(from, to);
  check("★ 子进程没有崩（status === 0）", r.status === 0, r);
  check("★ 文件真的复制过去了", r.copied.includes("a.txt"), r);
}

/* ───────────────────── 3. 负控：to 含非 ASCII ───────────────────── */

console.log("\n3. ★ 负控：to 路径含中文 —— 用户完全可能选一个中文目录");
{
  const from = makeSource("ascii-src-2");
  const to = join(WORK, "用户选的目标目录");
  const r = runProbe(from, to);
  check("★ 子进程没有崩（status === 0）", r.status === 0, r);
  check("★ 文件真的复制过去了", r.copied.includes("a.txt"), r);
}

/* ───────────────────── 4. 非 ASCII 不止中文 ───────────────────── */

console.log("\n4. ★ 影响面：Latin-1 / 西里尔 / emoji 同样会让 native path 崩");
{
  // 这条存在的意义：如果只测中文，会让人以为「这是中文特例」。上游 issue 里
  // 报的是编码回归（native 层按 UTF-16 处理 Windows 路径），与具体语言无关。
  for (const name of ["café-源", "Тест-источник", "emoji-😀"]) {
    const from = makeSource(name);
    const to = join(WORK, `dst-${name}`);
    const r = runProbe(from, to);
    check(`★ "${name}"：子进程没有崩`, r.status === 0, r);
  }
}

/* ───────────────────── 5. 探针本身没被绕过 ───────────────────── */

console.log("\n5. ★ 对照：探针确实在调 cpSync（不是空转）");
{
  // 如果探针什么都不做，上面全绿也没有意义。这里让它指向一个**不存在**的源：
  // `cpSync` 会抛 ENOENT，`copyDataRootTo` 按契约把它变成**返回值**（不是异常），
  // 探针打印 `err:复制失败:…`，退出码 0。
  //
  // 这个形态正好把「可捕获的失败」和「崩溃」分开：前者 status=0 + PROBE_RESULT:err，
  // 后者 status=0xC0000409 且**连 PROBE_RESULT 都没有**。
  const to = join(WORK, "dst-missing");
  const r = runProbe(join(WORK, "不存在的源"), to);
  check("★ 源不存在时是「可捕获的失败」，不是崩溃",
    r.status === 0 && r.result.startsWith("PROBE_RESULT:err:"), r);
}

console.log(`\nt90-dataroot-cpsync-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
