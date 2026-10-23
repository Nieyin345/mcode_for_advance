/**
 * 【T44】GenOffice 溯源套件的**防回退**守卫。
 *
 * ## 背景：这张卡曾经写错
 *
 * T44 原卡说「三套套件原地篡改真实 `genoffice/` 工作树造成并发竞争」。那张卡写在
 * 2026-10-23 19:04，而 **T31（`a10c705c`，15:03）已经把 `genoffice-source-smoke`
 * 改成 `git clone` 到副本上篡改**，t87 也早已使用 `os.tmpdir()` 副本，
 * `genoffice-vendor-freshness-smoke` 是纯读。
 *
 * 实测确认（C 会话，2026-10-23）：
 *   - 三套并发 3 轮 × 3 套 = **9/9 exit 0**；
 *   - Ctrl-C 中断 `genoffice-source-smoke` 之后 `git -C genoffice status` **为空**。
 *
 * **所以当前没有可修的缺陷。** 这套回归防的不是"现在坏了"，是**将来改回去**——
 * T31 之所以要修，恰恰因为有人曾经写成原地篡改；那次是怎么发生的，下一次还会怎么
 * 发生（为新套件图省事，直接对手边那个真实路径调 `writeFileSync`）。
 *
 * ## 三层判据，从便宜到贵
 *
 * 1. **静态守卫（毫秒级，主力）** —— 扫源码：`vendorReal` 只允许出现在**读**的
 *    位置（`existsSync` / `clone` 的源 / `git status` / `git rev-parse`）。出现任何
 *    写调用即失败。它不启动任何进程，所以能在每次跑测试时都跑。
 * 2. **并发全绿（~40s）** —— 三套同时跑，全部 exit 0。
 * 3. **中断后干净（~3s）** —— SIGINT 一套，真实 vendor 必须仍然逐字未变。
 *
 * 第 1 条是主力：它抓的是**任何人**改回原地写的那一次提交，不需要等某次全量恰好
 * 撞上并发窗口。第 2、3 条是行为层的确认，防的是静态扫描看不见的形态（比如把写
 * 藏进一个间接 helper）。
 *
 * ## 它不会把失败藏起来
 *
 * 三套被跳过（vendor 缺失）时这套**显式 SKIP 且退出码 0**，与三套自己的约定一致；
 * 但只要 vendor 在，任何一条红都是真红。
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repo = resolve(desktop, "../..");
const vendor = join(repo, "genoffice");
const SUITES_DIR = join(desktop, "scripts");
/** 需要"先把 vendor clone 到临时目录再篡改"的那几套（freshness 是纯读，不在此列）。 */
const NEEDS_CLONE = ["genoffice-source-smoke/main.cjs", "t87-genoffice-provenance-license-smoke/main.cjs"];
const GUARDED = [
  "genoffice-source-smoke/main.cjs",
  "genoffice-vendor-freshness-smoke/main.cjs",
  "t87-genoffice-provenance-license-smoke/main.cjs",
];

let total = 0;
let failures = 0;
function check(name, cond, detail) {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/* ── 1. 静态守卫 ───────────────────────────────────────────────────────── */
console.log("\n① 静态守卫:套件源码不得写真实 vendor 工作树");

/** 真实工作树的变量名（各套件自己的叫法）。 */
const REAL_VARS = ["vendorReal", "VENDOR"];
/** 写操作：出现即视为对真实工作树的写入。 */
const WRITE_CALLS = [
  "writeFileSync", "writeFile(", "appendFileSync", "appendFile(",
  "rmSync", "rm(", "unlinkSync", "unlink(", "cpSync", "copyFileSync",
  "mkdirSync", "renameSync", "truncateSync", "chmodSync", "symlinkSync",
];
/** `git` 子命令里会改工作树的那几个。 */
const GIT_WRITES = ["reset", "checkout", "clean", "commit", "add", "stash", "apply", "restore", "rm"];

for (const rel of GUARDED) {
  const file = join(SUITES_DIR, rel);
  if (!existsSync(file)) {
    check(`${rel} 存在`, false);
    continue;
  }
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  /**
   * 一行是不是"注释"（静态守卫不该被文档里的示例代码触发）。
   */
  const isComment = (t) => t.startsWith("*") || t.startsWith("//");

  /**
   * 从真实工作树**派生**出来的局部变量名。
   *
   * 为什么需要这一步 —— 第一版守卫只查"同行既有 vendorReal 又有写调用"，而真实的
   * 违规写法是**两行**的：
   *
   *     const file = path.join(vendorReal, "apps/docs/…");   ← 这行只有派生，没有写
   *     fs.writeFileSync(file, …);                            ← 这行只有写，没有 vendorReal
   *
   * 变异验证抓到了这个漏洞（把 `path.join(clone, …)` 改成 `path.join(vendorReal, …)`
   * 之后守卫仍然是绿的）。所以不能只看同行，要把**派生关系**追出来。
   *
   * 追法是保守的：只认 `const|let|var <名字> = … <realVar> …` 这一种形态，并且
   * **同一行里只允许出现一个被声明的名字**（`const a = …, b = …` 直接跳过，宁可漏报
   * 也不误报 —— 误报会让守卫变成噪声，最后被关掉）。
   */
  const derived = new Set();
  for (const line of lines) {
    const t = line.trim();
    if (isComment(t)) continue;
    const m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(t);
    if (!m) continue;
    if (!REAL_VARS.some((v) => new RegExp(`\\b${v}\\b`).test(line))) continue;
    // 同一行还有第二个 `x =` 声明（对象解构 / 多声明）→ 跳过，避免把不相干的名字
    // 也算成派生自真实工作树。
    if (/,\s*[A-Za-z_$][\w$]*\s*=/.test(t)) continue;
    derived.add(m[1]);
  }

  /** 一行是否触碰真实工作树（直接命名，或经由派生变量）。 */
  const touchesReal = (line) =>
    REAL_VARS.some((v) => new RegExp(`\\b${v}\\b`).test(line))
    || [...derived].some((d) => new RegExp(`\\b${d.replace(/\$/g, "\\$")}\\b`).test(line));

  // ① 写调用
  const offenders = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (isComment(t)) return;
    if (!touchesReal(line)) return;
    // 把自己算进来的声明行不算写（`const file = path.join(vendorReal, …)` 是派生的定义）
    const isDecl = /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(t);
    const writes = WRITE_CALLS.filter((w) => line.includes(w));
    if (writes.length > 0 && !(isDecl && writes.every((w) => w === "mkdirSync"))) {
      offenders.push({ line: i + 1, writes, text: t.slice(0, 120) });
    }
  });
  check(`${rel} 没有直接写真实 vendor 工作树`, offenders.length === 0, offenders.slice(0, 3));

  // ② `git` 写子命令
  const gitOffenders = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (isComment(t)) return;
    if (!touchesReal(line)) return;
    const mutating = GIT_WRITES.find((g) => new RegExp(`["'\`]${g}["'\`]`).test(line));
    if (mutating) gitOffenders.push({ line: i + 1, subcommand: mutating, text: t.slice(0, 120) });
  });
  check(`${rel} 没有对真实 vendor 跑会改工作树的 git 子命令`, gitOffenders.length === 0,
    gitOffenders.slice(0, 3));

  // 「必须 clone 到临时目录」：只对**需要篡改**的那两套要求。freshness 是纯读，
  // 它不该被强制 clone（那会让它为了过守卫而做无用功）。
  if (NEEDS_CLONE.includes(rel)) {
    // 判据：源码里必须出现 `git clone`，且目标落在临时目录（`os.tmpdir()` 或套件
    // 自己的 `base` 变量）。不做多行正则 —— 那种正则一旦写错就会变成"永远匹配"，
    // 反而让守卫失效。
    const hasClone = src.includes('"clone"') || src.includes("'clone'");
    const targetsTemp = src.includes("os.tmpdir()") || /\bpath\.join\(base\b/.test(src);
    check(`${rel} 把 vendor clone 到临时目录（而不是原地操作）`, hasClone && targetsTemp,
      { hasClone, targetsTemp });
  }
}

// 反向对照：守卫必须**能**抓到注入的违规形态（否则它是一条永远绿的断言）。
{
  const sample = [
    'fs.writeFileSync(path.join(vendorReal, "x"), "y");',
    'git(vendorReal, "reset", "--hard");',
    'execFileSync("git", ["-C", vendorReal, "checkout", "--", "."]);',
  ];
  const caught = sample.filter((line) => {
    const touchesReal = REAL_VARS.some((v) => new RegExp(`\\b${v}\\b`).test(line));
    if (!touchesReal) return false;
    const writes = WRITE_CALLS.filter((w) => line.includes(w));
    if (writes.length > 0) return true;
    return GIT_WRITES.some((g) => new RegExp(`["'\`]${g}["'\`]`).test(line));
  });
  check("守卫本身能抓到三种典型违规（防空过）", caught.length === 3,
    { caught: caught.length, of: 3 });
}

/* ── 2 & 3. 行为层 ──────────────────────────────────────────────────────── */
if (!existsSync(vendor)) {
  console.log("\n  skip vendor checkout absent —— 三套都会 skip，行为层无从验证");
  console.log(`\ngenoffice-suite-isolation-smoke: ${total - failures}/${total} 通过（行为层已跳过）`);
  process.exit(failures === 0 ? 0 : 1);
}

function git(...args) {
  return new Promise((ok, bad) => {
    const p = spawn("git", ["-C", vendor, ...args], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", bad);
    p.on("close", (code) => (code === 0 ? ok(out.trim()) : bad(new Error(`git ${args.join(" ")} exit ${code}`))));
  });
}

function runSuite(name) {
  return new Promise((ok) => {
    const p = spawn("bash", [join("scripts", name, "run.sh")], { cwd: desktop, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ code: code ?? 1, out }));
  });
}

function interruptSuite(name, afterMs) {
  return new Promise((ok) => {
    const p = spawn("bash", [join("scripts", name, "run.sh")], { cwd: desktop, windowsHide: true });
    const timer = setTimeout(() => p.kill("SIGINT"), afterMs);
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      ok({ code: code ?? 1, signal });
    });
  });
}

const NAMES = [
  "genoffice-source-smoke",
  "genoffice-vendor-freshness-smoke",
  "t87-genoffice-provenance-license-smoke",
];
const headBefore = await git("rev-parse", "HEAD").catch(() => null);
const statusBefore = await git("status", "--porcelain", "--untracked-files=all").catch(() => null);

console.log("\n② 并发跑三套（全部必须 0 退出）");
const started = Date.now();
const results = await Promise.all(NAMES.map(runSuite));
for (let i = 0; i < NAMES.length; i++) {
  const r = results[i];
  check(`${NAMES[i]} 在并发下 0 退出`, r.code === 0, {
    code: r.code,
    tail: r.out.split("\n").filter(Boolean).slice(-3),
  });
}
console.log(`  info 并发耗时 ${Date.now() - started}ms`);

console.log("\n③ 并发与中断之后，真实 vendor 必须逐字未变");
const statusAfter = await git("status", "--porcelain", "--untracked-files=all").catch(() => null);
check("并发跑完之后工作树未变", statusAfter === statusBefore, { before: statusBefore, after: statusAfter });

await interruptSuite("genoffice-source-smoke", 2500);
const headInterrupted = await git("rev-parse", "HEAD").catch(() => null);
const statusInterrupted = await git("status", "--porcelain", "--untracked-files=all").catch(() => null);
check("中断后 HEAD 未变", headInterrupted === headBefore, { before: headBefore, after: headInterrupted });
check("中断后工作树逐字未变（原地篡改若被中断，这条必红）",
  statusInterrupted === statusBefore, { before: statusBefore, after: statusInterrupted });

console.log(`\ngenoffice-suite-isolation-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
