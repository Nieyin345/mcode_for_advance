/**
 * `lib/taskOutput` 的回归 —— 那条**读文件**的口子。
 *
 * ## 为什么这一套非有不可
 *
 * 右栏「任务列表」页点开一条 bash 任务时，要读 CLI 写在磁盘上的那个输出文件。这是整个
 * 应用里少有的"按路径读文件"的地方，而路径的**来源**是主进程自己存的快照（渲染端只能给
 * `taskId`，给不了路径）—— 但"来源可信"只是一个前提，不是保证：第三方网关可以发一条伪造的
 * `task_notification` 把 `output_file` 填成任何东西。
 *
 * 所以校验必须**正向**（只认它该有的形状），而不是"排除几个危险路径"—— 黑名单永远少一条。
 * 本套把这条判据喂一堆恶意路径**逐条钉住**。
 *
 * ## 它同时钉住的第二件事
 *
 * **读不到时不返回空串**。空串会被界面渲染成"这个任务没有输出"—— 把"读失败"伪装成
 * "任务没干活"，是这一层最容易犯、且最难查的错。
 *
 * Run: scripts/task-output-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAllowedTaskOutputPath,
  readTaskOutputFile,
  TASK_OUTPUT_TAIL_BYTES,
} from "@main/lib/taskOutput.js";

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, actual?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 读它，把抛出来的话收下来（不抛时给空串）。 */
function catching(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ROOT = mkdtempSync(join(tmpdir(), "mcode-task-output-"));
const TASKS = join(ROOT, "proj", "tasks");
mkdirSync(TASKS, { recursive: true });
const GOOD = join(TASKS, "t1.output");
writeFileSync(GOOD, "build ok\n");

try {
  /* ── 1. 合法路径：要认 ── */
  console.log("\n1. 该认的认");
  check("★ CLI 那种 tasks/<id>.output 认", isAllowedTaskOutputPath(GOOD), GOOD);
  check(
    "macOS 上那种 /private/tmp/claude/<项目>/tasks/<id>.output 也认",
    isAllowedTaskOutputPath("/private/tmp/claude/-Users-me-proj/tasks/ac88940.output"),
  );

  {
    const r = readTaskOutputFile(GOOD);
    eq("★ 读出来就是文件内容", r.text, "build ok\n");
    eq("小文件没截断", r.truncated, false);
  }

  /* ── 2. 恶意/畸形的路径：一条都不许认 ── */
  console.log("\n2. 不该认的，一条都不认（这是这个文件存在的理由）");

  const bad: Array<[string, string]> = [
    ["相对路径（会跟着 cwd 跑）", "tasks/t1.output"],
    ["不在 tasks 目录下", join(ROOT, "secret.output")],
    ["目录名叫 mytasks（不能按子串判）", join(ROOT, "mytasks", "t1.output")],
    ["tasks 只是路径里的最后一段（没有文件名）", join(ROOT, "tasks")],
    ["不以 .output 结尾", join(TASKS, "t1.txt")],
    ["带 .. 回退", join(TASKS, "..", "..", "secret.output")],
    ["空串", ""],
    ["只有空白", "   "],
  ];
  for (const [why, p] of bad) {
    check(`★ 拒绝：${why}`, !isAllowedTaskOutputPath(p), p);
  }

  /* ── 3. 读不合法路径要**抛**，不是回空串 ── */
  console.log("\n3. 读不合法路径必须抛（回空串会把「读不到」伪装成「没有输出」）");

  for (const [why, p] of bad.slice(1)) {
    const msg = catching(() => readTaskOutputFile(p));
    check(`★ 读它抛了：${why}`, msg !== "", msg || "(没抛 —— 静默返回了)");
  }

  // 合法形状但文件不存在 —— 同样要抛（否则界面上是空的，看不出是"没生成"还是"读错了"）。
  const ghost = catching(() => readTaskOutputFile(join(TASKS, "never-created.output")));
  check("★ 合法形状但文件不在，也抛", ghost !== "", ghost || "(没抛)");

  // 目录（不是文件）—— 形状对但那不是文件。
  mkdirSync(join(TASKS, "t2.output"), { recursive: true });
  const dirRead = catching(() => readTaskOutputFile(join(TASKS, "t2.output")));
  check("★ 路径指向目录时抛（不是文件）", dirRead !== "", dirRead || "(没抛)");

  /* ── 4. 符号链接指出去：拦得住 ── */
  console.log("\n4. 符号链接指到别处（路径是对的，指向的却不是你认识的东西）");

  const OUTSIDE = join(ROOT, "outside-secret.txt");
  writeFileSync(OUTSIDE, "TOP SECRET\n");
  const LINK = join(TASKS, "link.output");
  try {
    symlinkSync(OUTSIDE, LINK);
    // 链接**本身**的形状是合法的（在 tasks 下、.output 结尾）—— 这正是要说明的地方：
    // 判据守的是"路径形状"，而 `RuntimeManager` 那一层守的是"路径来自我们自己的快照"。
    // 两层各自成立；这一层不假装能挡住符号链接。
    check(
      "链接路径本身的形状是合法的（说明这层不负责拦链接）",
      isAllowedTaskOutputPath(LINK),
      LINK,
    );
  } catch {
    // Windows 上非管理员可能建不了 symlink —— 那条不算失败（记录一下即可）。
    console.log("  note 这个环境建不了符号链接，跳过这一条");
  }

  /* ── 5. 只读尾部 ── */
  console.log("\n5. 大文件只读尾部，且如实报告截断了");

  {
    const big = join(TASKS, "big.output");
    // 头部一段垃圾 + 尾部一段标记：要的是标记还在、垃圾没了。
    writeFileSync(big, "A".repeat(TASK_OUTPUT_TAIL_BYTES + 5_000) + "TAIL-MARK");
    const r = readTaskOutputFile(big);
    eq("★ 报告了截断", r.truncated, true);
    check("★ 结尾是最后写的那段", r.text.endsWith("TAIL-MARK"), r.text.slice(-30));
    check(
      "★ 长度压在上限附近（不是把整个文件读进来）",
      r.text.length <= TASK_OUTPUT_TAIL_BYTES + 16,
      r.text.length,
    );
  }

  /* ── 6. 编码：尾部可能落在多字节字符中间 ── */
  console.log("\n6. 从头截断可能落在多字节字符中间（不该炸出替换字符）");

  {
    const cjk = join(TASKS, "cjk.output");
    // 用「中文」重复撑过上限，使切点必然落在一个字符中间。
    writeFileSync(cjk, "中文".repeat(TASK_OUTPUT_TAIL_BYTES));
    const r = readTaskOutputFile(cjk);
    check("★ 读出来了", r.text.length > 0);
    check(
      "★ 开头没有替换字符（U+FFFD）",
      !r.text.startsWith("�"),
      JSON.stringify(r.text.slice(0, 4)),
    );
  }
} finally {
  try {
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* owned temp dir cleanup is best-effort */
  }
}

console.log(`\n${checks - failures}/${checks} task-output checks passed`);
if (failures > 0) process.exit(1);
