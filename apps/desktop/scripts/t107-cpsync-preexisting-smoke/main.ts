/**
 * 【T107】`cpSync` 的**第三种**形态：非 ASCII 源 + 目标已有同名文件。
 *
 * ## 三种形态（前两种由 T90/T92 记录）
 *
 * | # | 触发条件 | 现象 | `filter` 能救吗 |
 * |---|---|---|---|
 * | 1 | 非 ASCII 源，目标全新建 | `0xC0000409` 进程直接死 | ✅ 能 |
 * | 2 | 目标路径非 ASCII | 静默不复制 | ✅ 能（改用 JS 实现） |
 * | **3** | **非 ASCII 源 + 目标已有同名文件** | **抛出 `errno=0` 的错**，**信息还写着「The operation completed successfully」**，**实际什么都没拷** | ❌ **不能** |
 *
 * ## 为什么第 3 种最危险
 *
 * 它同时满足两个坏条件：
 *
 * - **抛错** —— 调用方若用 `try/catch` 当成「非致命」吞掉，就以为拷过了；
 * - **没做** —— 目标保持旧内容，而流程已经往下走。
 *
 * 实测（2026-10-24，`.tmp/t107-fixes.mjs`）：修前 `top=OLD-TOP inner=OLD-INNER`，
 * 也就是**一个字节都没写**，但错误信息却说自己成功了。
 *
 * ## 本套件验什么
 *
 * 1. **正控**：同样的两棵树，**ASCII 源** → 覆盖成功（证明问题只在非 ASCII）；
 * 2. **负控**：**非 ASCII 源** + 目标已存在 → 必须**被修法处理**，不能静默留旧内容；
 * 3. **修法本身**：三种修法各自能通过（证明它们等价）；
 * 4. **对照**：不加修法 → 必须红（证明这套件真的在验）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
}

const WORK = mkdtempSync(join(tmpdir(), "t107-cp-"));
process.on("exit", () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* cleanup */ } });

/**
 * 跑一次探针。
 *
 * `base` 决定源与目标路径是否含非 ASCII —— 用**目录名**注入，而不是改代码。
 * `fix` 是修法：`none` / `delete-first` / `temp-rename` / `manual`。
 */
function runProbe(base: string, fix: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [PROBE, base, fix], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: (r.stdout ?? "").trim() };
}

/** 从探针输出里取 `key=value`。 */
function field(out: string, key: string): string {
  const m = new RegExp(`${key}=([^\\s|]+)`).exec(out);
  return m?.[1] ?? "";
}

/* ───────────────────── 1. 正控：ASCII 源 + 目标已存在 ───────────────────── */

console.log("\n1. 正控：**ASCII 源** + 目标已存在同名文件 → 覆盖成功");
{
  const base = join(WORK, "ascii-base");
  const r = runProbe(base, "none");
  check("status === 0（没崩）", r.status === 0, r);
  check("目标被新的覆盖了（top=NEW）", field(r.out, "top") === "NEW", r);
  check("嵌套文件也被覆盖了（inner=NEW）", field(r.out, "inner") === "NEW", r);
}

/* ───────────────────── 2. 对照：非 ASCII 源 + 目标已存在，不修 ───────────────────── */

console.log("\n2. ★ 对照：**非 ASCII 源** + 目标已存在 + **不加修法** → 必须失败");
{
  // 这条是整个套件的靶子：它证明「不加修法就是坏的」。
  // 如果它绿了，说明这套件根本没复现出那个 bug。
  const base = join(WORK, "非ASCII-base");
  const r = runProbe(base, "none");
  const failed = r.status !== 0 || field(r.out, "top") !== "NEW";
  check("★ 不加修法时确实失败了（要么抛错，要么没覆盖）", failed, r);
  // 明确区分两种失败形态：我们测到的是「抛错 + 没覆盖」
  check("★ 而且是「抛错 + 目标仍是旧内容」这种最坏的形态",
    r.out.includes("THREW") && field(r.out, "top") === "OLD", r);
}

/* ───────────────────── 3. 三种修法都能救回来 ───────────────────── */

console.log("\n3. 三种修法：删后再拷 / 临时名再 rename / 手写递归");
{
  const base = join(WORK, "非ASCII-fixes");
  for (const [fix, label] of [
    ["delete-first", "先删后拷"],
    ["temp-rename", "拷到临时名再 rename"],
    ["manual", "手写递归 copyFileSync"],
  ] as const) {
    const r = runProbe(base, fix);
    check(`${label}：status === 0`, r.status === 0, r);
    check(`${label}：目标真的被覆盖（top=NEW）`, field(r.out, "top") === "NEW", r);
    check(`${label}：嵌套文件也覆盖（inner=NEW）`, field(r.out, "inner") === "NEW", r);
    check(`${label}：源目录没被破坏`, field(r.out, "srcIntact") === "true", r);
  }
}

/* ───────────────────── 4. 修法不能留下垃圾 ───────────────────── */

console.log("\n4. 修法不留临时目录残渣");
{
  const base = join(WORK, "非ASCII-leftover");
  for (const fix of ["delete-first", "temp-rename", "manual"] as const) {
    const r = runProbe(base, fix);
    check(`${fix}：没有 leftovers`, field(r.out, "leftovers") === "[]", r);
  }
}

console.log(`\nt107-cpsync-preexisting-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
