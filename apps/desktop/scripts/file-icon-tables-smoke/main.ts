/**
 * file-icon-tables-smoke —— 图标表的**显式清单**必须与表里的实际取值一致。
 *
 * ## 盯的是什么
 *
 * `scripts/file-icon-subset/gen.mjs` 要读图标表，推导该把哪些图标打进
 * `fileIconCollection.json`。它是 `.mjs`，**import 不了 TS 常量**，只能读文本。
 *
 * 2026-10-15 拆分时把「扫文本」换成了「读显式清单」
 * （`fileIconTables.ts` 的 `REFERENCED_ICON_NAMES`）—— 扫文本有个静默失效模式：
 * 换个写法（比如 `export const EXT_ICON` 改成别的形状）就**找不到块**，
 * 而它**不会报错**，只会少打包几个图标，表现为「某些文件图标空白」。
 *
 * 代价是清单是**手写**的，会漂移。这条断言就是防它的：**逐字符核对**
 * 「清单里的名字集合」== 「两张表里实际出现的名字集合」。
 *
 * ## 判据
 *
 * - ★ 清单与表完全相等（少了 → 图标会漏打包；多了 → 白打包，且掩盖"表里已删"）；
 * - ★ 清单非空、无重复（重复说明是机械拼出来的，不是从表导出）；
 * - ★ `fileIcon.tsx` 的 `DEFAULT_ICON` 也在清单里（它不在表里，但也要打包）。
 *
 * ## 为什么这条能真的红
 *
 * 它**不读** `gen.mjs` 的产物，而是当场从两张表里重新数一遍 —— 所以
 * 「改了表忘了改清单」和「改了清单忘了改表」两个方向都会红。
 *
 * Run: scripts/file-icon-tables-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXT_ICON, NAME_ICON, REFERENCED_ICON_NAMES } from "@renderer/lib/fileIconTables.js";

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

/** 从表里当场重新数一遍用到的图标名。 */
function namesInTables(): Set<string> {
  const out = new Set<string>();
  for (const table of [EXT_ICON, NAME_ICON]) {
    for (const v of Object.values(table)) out.add(v);
  }
  return out;
}

const fromTables = namesInTables();
const fromList = new Set(REFERENCED_ICON_NAMES);

/* ─────────── §A 清单本身是干净的 ─────────── */

console.log("\n§A 清单的形态");
check("清单非空", REFERENCED_ICON_NAMES.length > 0, REFERENCED_ICON_NAMES.length);
check(
  "★ 清单无重复项",
  fromList.size === REFERENCED_ICON_NAMES.length,
  { total: REFERENCED_ICON_NAMES.length, unique: fromList.size },
);

/* ─────────── §B 清单与表逐字符一致（核心判据） ─────────── */

console.log("\n§B 清单 ↔ 表");
{
  const missingFromList = [...fromTables].filter((n) => !fromList.has(n));
  check("★ 表里用到的图标名全在清单里（少了 → 会漏打包）", missingFromList.length === 0, missingFromList);

  // DEFAULT_ICON 住在 fileIcon.tsx（它是逻辑不是数据），不在表里但要打包。
  const iconSrc = readFileSync(join(process.cwd(), "src/renderer/lib/fileIcon.tsx"), "utf8");
  const def = iconSrc.match(/const DEFAULT_ICON\s*=\s*"([^"]+)"/);
  check("fileIcon.tsx 里找得到 DEFAULT_ICON", def !== null);
  const defaults = new Set(def ? [def[1]] : []);

  const extraInList = [...fromList].filter((n) => !fromTables.has(n) && !defaults.has(n));
  check(
    "★ 清单没有表里不存在的名字（多了 → 白打包 / 掩盖已删项）",
    extraInList.length === 0,
    extraInList.slice(0, 20),
  );

  check(
    `★ DEFAULT_ICON（${def?.[1] ?? "?"}）在清单里`,
    def !== null && fromList.has(def[1]),
  );
}

/* ─────────── §C 表本身是完整的（防"表被截断"） ─────────── */

console.log("\n§C 表的规模");
// 这两个下限是拆分前的实测值（1360 扩展 + 1039 文件名，去重后 536 个图标名）。
// 设成下限而不是等值：加图标是正常的，**大幅缩水**才是问题。
check("EXT_ICON 条目数正常（≥1300）", Object.keys(EXT_ICON).length >= 1300, Object.keys(EXT_ICON).length);
check("NAME_ICON 条目数正常（≥1000）", Object.keys(NAME_ICON).length >= 1000, Object.keys(NAME_ICON).length);
check("清单规模正常（≥500）", REFERENCED_ICON_NAMES.length >= 500, REFERENCED_ICON_NAMES.length);

console.log(`\nfile-icon-tables-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
