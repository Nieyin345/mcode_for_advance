/**
 * 【T140】`cn()` 必须保住 CDS 七档字号。
 *
 * ## 这套验的是什么
 *
 * 不验源码文本里有 `text-caption` —— T121/T133 就是这么验的，而它们在运行时
 * 一直是绿的假象：`cn()` 里的 `twMerge` 不认识那七个名字，把它当成颜色类，
 * 和 `text-content` 撞组后被丢掉，字号静默回落到 16px。
 *
 * **本套直接调 `cn()` 的真实实现**（`src/renderer/lib/cn.ts`），验它的输出。
 *
 * ## 三条负控为什么必须有
 *
 * 只要把「所有 text-* 都登记进 font-size 组」也能让正控全绿 —— 但那样
 * `text-content-muted` 和 `text-danger` 就再也不会互相覆盖了。所以负控验的是
 * **修复没有过度扩张**。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cn } from "../../src/renderer/lib/cn.js";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
/** 从 tailwind.config.js 里抽出 fontSize 的键名。不 import——它是 ESM 配置，
 *  直接读源码更稳（且能顺便验证「两处名字一致」这条）。
 *
 *  ⚠️ 用 `process.cwd()` 不用 `import.meta.url`：这套被 esbuild 打到临时目录
 *  再执行，`import.meta.url` 指向的是 `/tmp/mcode-t140-.../`，相对路径全错。
 *  `run.sh` 会先 `cd apps/desktop`，所以 cwd 就是包根。 */
function tailwindFontTierNames(): string[] {
  const src = readFileSync(join(process.cwd(), "tailwind.config.js"), "utf8");
  const block = src.match(/fontSize:\s*\{([\s\S]*?)\n\s{6}\},/);
  if (!block) return [];
  const names: string[] = [];
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s{8}([a-zA-Z][a-zA-Z0-9]*):\s*\[/);
    if (m) names.push(m[1]);
  }
  return names;
}

// ─────────────────────────────────────────────────────────────
// 1. 七个档位逐个：和 text-content 共存（主判据）
// ─────────────────────────────────────────────────────────────
console.log("\n[1] 档位与颜色共存（修复前这一整组都只剩 text-content）");

const TIERS = ["caption", "footnote", "code", "body", "prose", "heading", "title"] as const;

for (const tier of TIERS) {
  const out = cn(`text-${tier}`, "text-content");
  check(`text-${tier} + text-content → 两个都在`, out.includes(`text-${tier}`) && out.includes("text-content"), out);
}

// ─────────────────────────────────────────────────────────────
// 2. 档位之间仍能互相覆盖（负控：不是「全都保留」）
// ─────────────────────────────────────────────────────────────
console.log("\n[2] 档位覆盖仍生效");

eq("text-caption + text-xs → 只剩 text-xs", cn("text-caption", "text-xs"), "text-xs");
eq("text-xs + text-caption → 只剩 text-caption", cn("text-xs", "text-caption"), "text-caption");
eq("text-body + text-code → 只剩 text-code", cn("text-body", "text-code"), "text-code");

// ─────────────────────────────────────────────────────────────
// 3. 颜色 / 背景 / 间距的冲突解决没被破坏
// ─────────────────────────────────────────────────────────────
console.log("\n[3] 其它类的冲突解决未被破坏");

eq("text-content-muted + text-danger → 只剩 text-danger", cn("text-content-muted", "text-danger"), "text-danger");
eq("bg-surface + bg-surface-muted → 只剩后者", cn("bg-surface", "bg-surface-muted"), "bg-surface-muted");
eq("p-2 + p-4 → 只剩 p-4", cn("p-2", "p-4"), "p-4");
// 【T140】档位必须是**字号**组，不能是颜色组。
// 误登记成颜色时，它会和 text-content 撞组后被丢掉 —— 症状与「完全不登记」相同。
// 这一条与 [1] 是同一件事的两种读法，保留是因为它把「登记进哪一组」写明了。
check(
  "档位被当作字号而非颜色（与第 [1] 组同因，这里显式点名）",
  !cn("text-caption", "text-content").endsWith("text-content") ||
    cn("text-caption", "text-content").includes("text-caption"),
  cn("text-caption", "text-content"),
);

// ─────────────────────────────────────────────────────────────
// 4. 宽松输入形状也要正常（三参数、条件值、undefined）
// ─────────────────────────────────────────────────────────────
console.log("\n[4] 真实调用形状");

check(
  "三参数里夹一个 false 不影响档位",
  cn("text-caption", false, "text-content").includes("text-caption"),
  cn("text-caption", false, "text-content"),
);
check(
  "undefined 被忽略",
  cn("text-caption", undefined, "text-content").includes("text-caption"),
  cn("text-caption", undefined, "text-content"),
);

// ─────────────────────────────────────────────────────────────
// 5. 配置名与登记名一致（两处不同步时这条会红）
// ─────────────────────────────────────────────────────────────
console.log("\n[5] tailwind.config.js 的档位集合 === cn.ts 登记的集合");

const fromConfig = tailwindFontTierNames().sort();
const fromCn = [...TIERS].sort();
check(
  "两个集合完全相同",
  fromConfig.length > 0 && JSON.stringify(fromConfig) === JSON.stringify(fromCn),
  { fromConfig, fromCn },
);

// ─────────────────────────────────────────────────────────────
console.log(`\nt140-cn-tier-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
