// 【T145】守卫：所有 smoke 的 run.sh，`cd` 之后不许再用 `dirname "$0"`。
//
// ## 它防的是什么
//
// run.sh 的常见形状是：
//
//     cd "$(dirname "$0")/../.."
//     source "$(dirname "$0")/../lib/esbuild-path.sh"   ← 这行会挂
//
// `cd` 之后 `$0` 仍是**调用者给的相对路径**；相对路径的基准已经变成新的 cwd
// （apps/desktop），于是拼出 `apps/desktop/apps/desktop/scripts/...` —— 不存在。
//
// 报错是 `line N: ... No such file or directory`，**看起来像套件本身坏了**，
// 不像路径问题。全量跑（run-smokes.mjs 用 `cwd: appDir` 调）看不出来，
// 只有「从仓库根单套跑」才暴露 —— 而那正是 CLAUDE.md 推荐的日常动作。
//
// ## 判据为什么不能是「文件里有没有 $0」
//
// 正确写法里 `$0` 也出现：
//
//     HERE=$(cd "$(dirname "$0")" && pwd)   ← 用 $0 是对的
//     cd "$HERE/../.."
//     source "$HERE/../lib/esbuild-path.sh" ← 不再用 $0
//
// 所以判的是 **`cd` 之后还用它**，不是「用了它」。
//
// ## ⚠️ 必须跳过注释
//
// `mcp-ipc-smoke/run.sh` 的注释里就有一句 `$(dirname "$0")` 在解释这个坑本身
// （而且它自己的代码早已是对的）。不剥注释，它会误报 —— 这正是 CLAUDE.md
// 「源码文本断言要剥注释」里那种形态。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS = join(import.meta.dirname, "..");
const DIRNAME_DOLLAR0 = 'dirname "$0"';

let checks = 0;
let failures = 0;
function check(name, ok, detail) {
  checks++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const suites = readdirSync(SCRIPTS)
  .filter((n) => n.endsWith("-smoke") && statSync(join(SCRIPTS, n)).isDirectory())
  .sort();

/**
 * 返回该 run.sh 里「cd 之后仍在用 dirname "$0"」的行号（1-based），没有就是 []。
 * 注释行（# 开头）跳过 —— 那些是解释，不是用法。
 */
function offendingLines(src) {
  const lines = src.split("\n");
  const cdIdx = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith("cd ")) cdIdx.push(i);
  if (cdIdx.length === 0) return []; // 没有 cd 的套件不受这个约束
  const firstCd = cdIdx[0];
  const hits = [];
  for (let j = firstCd + 1; j < lines.length; j++) {
    const s = lines[j].trim();
    if (s.startsWith("#")) continue; // ★ 注释不是用法
    if (lines[j].includes(DIRNAME_DOLLAR0)) hits.push(j + 1);
  }
  return hits;
}

console.log(`t145-runsh-path-smoke —— ${suites.length} 个 smoke 目录\n`);

// [1] 主判据：全部套件，cd 之后不许在用 dirname "$0"
const offenders = [];
for (const name of suites) {
  const file = join(SCRIPTS, name, "run.sh");
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue; // 没有 run.sh 的目录不是本套件的目标
  }
  const hits = offendingLines(src);
  if (hits.length) offenders.push(`${name}/run.sh:${hits.join(",")}`);
}
check(
  "★ 没有 run.sh 在 `cd` 之后仍用 `dirname \"$0\"`（从仓库根调用会拼错路径）",
  offenders.length === 0,
  offenders.slice(0, 25),
);

// [2] 覆盖性正控：扫描确实看到了文件（否则 [1] 会因为「一套都没读到」而恒绿）
const runShCount = suites.filter((n) => {
  try {
    return statSync(join(SCRIPTS, n, "run.sh")).isFile();
  } catch {
    return false;
  }
}).length;
check("★ 扫描确实读到了 run.sh（否则第 [1] 条会因为零输入而恒绿）", runShCount > 400, { runShCount });
check("存在使用 HERE 正确形状的样板（t138/t139/t140 之一）", suites.includes("t140-cn-tier-smoke"));

// [3] 判据自检：喂三个构造样本，确认它分得清「用法」和「注释」
const positive = [
  'set -euo pipefail',
  'cd "$(dirname "$0")/../.."',
  'source "$(dirname "$0")/../lib/esbuild-path.sh"',
].join("\n");
const negative = [
  'set -euo pipefail',
  'HERE=$(cd "$(dirname "$0")" && pwd)',
  'cd "$HERE/../.."',
  'source "$HERE/../lib/esbuild-path.sh"',
].join("\n");
const commentOnly = [
  'set -euo pipefail',
  'HERE=$(cd "$(dirname "$0")" && pwd)',
  'cd "$HERE/../.."',
  `# 从前这里写的是 $(dirname "$0")，cd 之后就失效了`,
  'source "$HERE/../lib/esbuild-path.sh"',
].join("\n");
const noCd = ['set -euo pipefail', 'source "$(dirname "$0")/../lib/esbuild-path.sh"'].join("\n");

check("★ 自检：cd 之后用 $0 的样本 → 抓到 1 行", offendingLines(positive).length === 1, offendingLines(positive));
check("★ 自检：HERE 正确形状 → 0 行", offendingLines(negative).length === 0, offendingLines(negative));
check("★ 自检：注释里提到 $0 → 0 行（剥注释生效）", offendingLines(commentOnly).length === 0, offendingLines(commentOnly));
check("★ 自检：没有 cd 的套件 → 0 行（这条约束不适用）", offendingLines(noCd).length === 0, offendingLines(noCd));

// [4] smokes-for.py 教给读者的命令必须能用：不得再从仓库根给相对路径
//
// ⚠️ 判据不能是「文件里出现过这个字符串」—— 修法的注释里就引用了那条坏命令
// （解释「从前是这条，为什么它坏」）。**注释不是用法**，和上面 [1] 同一个道理。
// 所以只认**非注释的 print 行**。
const smokesFor = readFileSync(join(SCRIPTS, "smokes-for.py"), "utf8");
const brokenPrint = smokesFor
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .filter((l) => /print\(.*bash apps\/desktop\/scripts\/<名字>\/run\.sh/.test(l));
check(
  "★ smokes-for.py 不再打印从仓库根会挂的那条命令（只认非注释行）",
  brokenPrint.length === 0,
  brokenPrint,
);

console.log(`\n${checks - failures}/${checks} passed; ${failures} failed`);
process.exit(failures ? 1 : 0);
