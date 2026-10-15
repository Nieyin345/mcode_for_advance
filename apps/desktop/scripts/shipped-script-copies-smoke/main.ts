/**
 * shipped-script-copies-smoke —— 【MC-008】同一份 Python **不许有两个副本**。
 *
 * ## 盯的是什么
 *
 * `workflows/assets.ts` 里的 Python 正文，与 `resources/presets/workflows.json` 里
 * **内联**的那份，是同一段逻辑的两个物理副本。台账 MC-008 用 node 求值比对过：
 * `MINERU_PY` 17404 字符逐字相等、`LIT_IMPORT_PY` 3503 字符逐字相等 —— **今天相等**。
 *
 * 问题在**明天**：这份相等**没有任何东西在守**。真实故障形态是——
 *
 *   修 MinerU 脚本的一个 bug → 改 `assets.ts` 的 `MINERU_PY` → 预设里那份没变
 *   → **用户实际跑的是旧版**。
 *
 * 更糟的是 `seed.ts` 落盘的 `mineru_transcribe.py` **没有任何预设引用它**（预设是内联的），
 * 所以"改对了文件、跑的是没改的副本"这条路上没有任何反馈。
 *
 * ## 判据
 *
 * ★ 断言**两处正文逐字相等**，且是**动态求值**出来的（真 import `assets.ts` 拿常量、
 * 真 JSON.parse 预设），不是"源码里包含某字符串"那种文本断言 —— 后者在两边一起改错时
 * 照样绿。
 *
 * 这条不断言"该不该内联"（那是 MC-008 的系统性修法，涉及改预设数据，属 MC-005/007 同片）。
 * 它只保证：**只要还有两个副本，它们就必须一模一样**。真按修法 2 改成引用之后，
 * 这条会自然失效并应被删掉。
 *
 * ## 它怎么跑
 *
 * `assets.ts` 是纯字面量、不 import 任何东西，esbuild 打包后直接 node 跑；
 * 预设 JSON 用相对路径读（cwd = apps/desktop）。
 *
 * Run: scripts/shipped-script-copies-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_PY, CHECK_CITATIONS_PY, MINERU_PY, LIT_IMPORT_PY } from "@main/workflows/assets.js";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 预设里所有内联成 Python 的 `params.code`。 */
function inlinePythonCodes(): { wf: string; node: string; code: string }[] {
  const raw = readFileSync(join(process.cwd(), "resources/presets/workflows.json"), "utf8");
  const doc = JSON.parse(raw) as { workflows?: { id?: string; nodes?: unknown[] }[] };
  const out: { wf: string; node: string; code: string }[] = [];
  for (const wf of doc.workflows ?? []) {
    for (const n of (wf.nodes ?? []) as Record<string, unknown>[]) {
      const params = (n.params ?? {}) as Record<string, unknown>;
      const code = params.code;
      if (typeof code === "string" && /python/i.test(code.slice(0, 300))) {
        out.push({ wf: wf.id ?? "?", node: String(n.id ?? "?"), code });
      }
    }
  }
  return out;
}

const inline = inlinePythonCodes();

/* ─────────── §A 预设里的内联脚本，每一份都必须有权威正文与之逐字相同 ─────────── */

console.log("\n§A 内联副本 ↔ 权威正文");
check("预设里确实还有内联 Python（若已改成引用，本套应删除）", inline.length >= 2, inline.map((i) => `${i.wf}/${i.node}`));

// 权威正文常量：名字 → 正文。LIT_IMPORT_PY 目前**没有**进 seed.ts，但它的活副本就是预设内联那份。
const AUTHORITIES: Record<string, string> = {
  MINERU_PY,
  LIT_IMPORT_PY,
  LIBRARY_PY,
  CHECK_CITATIONS_PY,
};

const matched = new Set<string>();
for (const { wf, node, code } of inline) {
  const hit = Object.entries(AUTHORITIES).find(([, body]) => body === code);
  if (hit) matched.add(hit[0]);
  check(
    `★ ${wf}/${node} 与某个权威常量逐字相同（改了 assets.ts 必须同步改预设）`,
    hit !== undefined,
    hit ? undefined : { codeLength: code.length, head: code.slice(0, 80) },
  );
}

/* ─────────── §B 每个「该有两份」的常量都真的被对上了 ─────────── */

console.log("\n§B 权威常量的覆盖");
// 这两个有内联孪生：MINERU_PY（wf_auto_convert）、LIT_IMPORT_PY（wf_auto_download）
check("★ MINERU_PY 在预设里有逐字相同的孪生", matched.has("MINERU_PY"));
check("★ LIT_IMPORT_PY 在预设里有逐字相同的孪生", matched.has("LIT_IMPORT_PY"));

/* ─────────── §C 落盘清单与预设引用对齐（MC-008 第 3 条）─────────── */

console.log("\n§C 落盘脚本清单");
{
  const seed = readFileSync(join(process.cwd(), "src/main/workflows/seed.ts"), "utf8");
  // seed 落的每个 scripts/*.py，其正文来源必须是 assets 的某个常量（不留手写副本）
  const shipped = [...seed.matchAll(/rel:\s*"scripts\/([\w.]+\.py)",\s*body:\s*(\w+)/g)];
  check("seed.ts 里的落盘脚本都从 assets 常量取正文（没有手写第二份）", shipped.length >= 3, shipped.map((m) => m[1]));

  const bodies = shipped.map((m) => m[2]);
  const looseBodies = bodies.filter((b) => !(b in AUTHORITIES));
  check("★ 每个落盘 body 都是 assets 导出的常量名", looseBodies.length === 0, looseBodies);

  // LIT_IMPORT_PY 常量**没有**被 seed 落盘 —— 这是 MC-008 记的孤岛。
  // 这里只如实记录这个事实，不判失败：该不该落盘是 MC-008 的系统性修法要定的。
  const litShipped = shipped.some((m) => m[2] === "LIT_IMPORT_PY");
  console.log(
    `  info LIT_IMPORT_PY ${litShipped ? "已" : "**未**"}进 seed 落盘清单` +
      `（台账 MC-008 记的孤岛；该不该落盘由 MC-008 的系统性修法定，本套不判）`,
  );
}

console.log(`\nshipped-script-copies-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
