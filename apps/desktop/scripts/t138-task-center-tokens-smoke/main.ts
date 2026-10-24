/**
 * 【T138】任务中心（`TaskCenterPanel` / `TaskListPanel`）的字号与圆角判据。
 *
 * ## 这套守什么
 *
 * 1. **零硬写字号** —— 两个文件里不许再有 `text-[Npx]` / `text-[N.em]`。
 *    唯一的例外是注释：`TaskCenterPanel:429` 在解释「为什么不照抄另一个面板」
 *    时引用了那边的 `text-[10.5px]`，那是**记录**不是用法。
 * 2. **零 `13px`** —— 13 不在 T121 七档里（11/12/14/15/16/20 + code 12）。
 * 3. **圆角走 token** —— 不许再出现裸 `rounded`（4px，且下次调 token 它不跟着变）。
 * 4. **七档确实被用上了** —— 不是「删掉了硬写值但也没换成档位」。
 *
 * ## 为什么读源码而不是渲染
 *
 * 这两个组件的样式全在 className 字符串里，没有可 import 的纯函数。
 * 渲染验证要起 Electron（`arc005-visual-baseline` 那条路），而那是另一层。
 *
 * ⚠️ **读源码必须剥注释**（T119 的 94 处就是栽在 `includes` 把注释算命中）。
 * 这里统一走 `sourceHas` / `stripComments`。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripComments } from "../lib/sourceText.js";

let total = 0;
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

// run.sh 会先 `cd` 到 apps/desktop —— 用 cwd 而不是 import.meta.url。
// 打包产物在临时目录里，`import.meta.url` 指向那里，不是仓库。
const APP = resolve(process.cwd());
const REPO = resolve(APP, "../..");
const FILES = [
  "apps/desktop/src/renderer/components/ide/TaskCenterPanel.tsx",
  "apps/desktop/src/renderer/components/ide/TaskListPanel.tsx",
];

const raw = new Map<string, string>();
const code = new Map<string, string>();
for (const f of FILES) {
  const src = readFileSync(join(REPO, f), "utf8");
  raw.set(f, src);
  code.set(f, stripComments(src));
}

/** 抠出所有 `text-[...]` 用法（已剥注释）。 */
function hardcodedSizes(src: string): string[] {
  return src.match(/text-\[[^\]]+\]/g) ?? [];
}

console.log("── 一、零硬写字号（剥注释后）──");

for (const f of FILES) {
  const name = f.split("/").pop();
  const hits = hardcodedSizes(code.get(f)!);
  check(`★ ${name} 无 text-[...] 硬写值（实际 ${hits.length}）`, hits.length === 0, { hits });
}

/* ── 正控：注释里那个 `text-[10.5px]` 确实还在（证明剥注释真的在剥，不是全文没命中）── */
check(
  "★ 正控：原文里仍有注释态的 text-[10.5px]（证明剥注释在工作，而不是文件里压根没有）",
  hardcodedSizes(raw.get(FILES[0])!).length > 0 && hardcodedSizes(code.get(FILES[0])!).length === 0,
  { rawCount: hardcodedSizes(raw.get(FILES[0])!).length, codeCount: hardcodedSizes(code.get(FILES[0])!).length },
);

console.log("\n── 二、13px 一处不剩（不在七档里）──");

for (const f of FILES) {
  const name = f.split("/").pop();
  check(`★ ${name} 无 13px`, !code.get(f)!.includes("13px"));
}

console.log("\n── 三、圆角走 token ──");

for (const f of FILES) {
  const name = f.split("/").pop();
  const src = code.get(f)!;
  /* 裸 `rounded` = 4px，且不跟 token 走。找 className 里不接 - 的 rounded。 */
  const bare = src.match(/\brounded(?![-\w])/g) ?? [];
  check(`★ ${name} 无裸 rounded（实际 ${bare.length}）`, bare.length === 0, { bare });
  const tokens = src.match(/rounded-\[var\(--radius-[a-z-]+\)\]/g) ?? [];
  check(`★ ${name} 至少用了一处 radius token（实际 ${tokens.length}）`, tokens.length > 0, { tokens });
}

console.log("\n── 四、七档确实被用上（按文件守下限，不按总量）──");

/**
 * ⚠️ **为什么按文件守下限，不按总量**（T133 / T132 的教训）：
 *
 * 「总量 ≥ N」在两种改写下都是绿的：
 *   ① 删一处、别处补一处 —— 总量守恒；
 *   ② **只删不补** —— 总量减少，但只要还 ≥ N 就绿。
 *
 * 变异 2（删掉一处 `text-caption` 且不补任何档位）在第一版里 **0 条红**，
 * 因为当时只有一条 `text-caption 被用上（> 0）`。
 *
 * 所以这里逐文件记**下限**，数字来自迁移时的实际替换输出。
 *
 * ## 2026-10-24 调整：TaskCenterPanel 的 caption 从 17 降到 16
 *
 * `FilterChip` 那一处**不再是 `text-caption`**，改成内联 `fontSize`。
 * 原因见第六节：`cn()` 的 twMerge 会丢掉自定义档位（T140）。
 *
 * **这不是「删一处少一处」的钻空子** —— 第六节有专门断言把它钉住：
 * chip 必须**确实**有 11px 字号，只是表达方式换成了内联。
 */
const MIGRATED: Record<string, { caption: number; footnote: number }> = {
  "TaskCenterPanel.tsx": { caption: 16, footnote: 3 },
  "TaskListPanel.tsx": { caption: 19, footnote: 0 },
};

for (const [name, min] of Object.entries(MIGRATED)) {
  const f = FILES.find((p) => p.endsWith("/" + name))!;
  const src = code.get(f)!;
  for (const [tier, floor] of Object.entries(min)) {
    if (floor === 0) continue;
    const n = (src.match(new RegExp(`(?<![\\w/-])text-${tier}(?![\\w/-])`, "g")) ?? []).length;
    check(`★ ${name} 仍有 ${floor} 处 text-${tier}（实际 ${n}）`, n >= floor, { n, floor });
  }
}

console.log("\n── 五、负控：禁区没有被误改 ──");

/* 这两个文件不该出现下划线风格之外的档位 —— 防止迁移时顺手把 heading/title 也塞进来。 */
for (const f of FILES) {
  const name = f.split("/").pop();
  const src = code.get(f)!;
  check(`★ ${name} 没有 text-heading / text-title（任务中心不该用标题档）`, !/\btext-(heading|title)\b/.test(src));
}

console.log("\n── 六、FilterChip 的字号必须真的生效（T140 的局部规避）──");

/**
 * ## 为什么单独守这一条
 *
 * `cn()` 是裸 `twMerge`，它不认识我们扩展的档位名（`caption`/`footnote`/
 * `code`/…），把 `text-caption` 归进「颜色」组 —— 与同一次 `cn()` 里的
 * `text-content` 同组冲突，**先出现的被丢掉**。字号于是静默回落到根继承值
 * （16px，因为 `html/body` 没设 `font-size`）。
 *
 * 后果是可见的：chip 从 11px 变 16px，筛选条从两行挤成三行，把任务列表
 * 往下推一整行 —— 而 `TaskCenterPanel.tsx:420-427` 的注释写明了「两行筛选条
 * 会把列表往下推」正是当初不照抄药丸形状的理由。
 *
 * 全仓同类失效 29 处，根因修复在 `tasks/T140`。这里只管**这一处**
 * 已经被视觉基线抓到、并且是 T138 引入的回归。
 *
 * ## 判据为什么是「内联 fontSize」而不是「className 里有 text-caption」
 *
 * 因为后者**恰恰是坏的那个**。写 `text-caption` 会被 twMerge 丢掉，
 * 而断言源码里「有 text-caption」照样绿 —— 那是「判据测中间量而非目标」
 * 的典型形态（`memory/evidence-tools-can-lie`）。
 *
 * 断言必须落在**真正决定渲染的那一层**。
 */
const centerSrc = code.get(FILES[0])!;
check(
  "★ FilterChip 用内联 fontSize 定 11px（而不是会被 twMerge 丢掉的 text-caption）",
  /style=\{\{\s*fontSize:\s*"11px"/.test(centerSrc),
  { found: /style=\{\{\s*fontSize:\s*"([^"]+)"/.exec(centerSrc)?.[1] ?? null },
);
check(
  "★ 负控：FilterChip 的 className 里不再同时出现 text-caption 与 text-content系",
  // 抠出 FilterChip 函数体的 className 部分，确认没有档位类
  !/className=\{cn\(\s*"[^"]*\btext-caption\b/.test(centerSrc),
);
check(
  "★ 内联 fontSize 与 caption 档一致（11px / 16px 行高）—— 改档时要两边一起改",
  /style=\{\{\s*fontSize:\s*"11px",\s*lineHeight:\s*"16px"\s*\}\}/.test(centerSrc),
);

console.log(`\nt138-task-center-tokens-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
