/**
 * `ensureWorkflows()` 的升级规则:没改过的旧版换成新版,改过的不动。
 *
 * 见 run.sh 顶上那段为什么。数据根是 `$MCODE_SMOKE_DATA_ROOT`(run.sh 建的临时目录)。
 *
 * Run: scripts/workflow-seed-smoke/run.sh
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureWorkflows, workflowsRoot, SHIPPED_RECORD_FILE, LEGACY_SHIPPED_SHA256, shippedHashOf } from "@main/workflows/seed.js";
import { LIBRARY_PY, CHECK_CITATIONS_PY, MINERU_PY } from "@main/workflows/assets.js";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
}

const legacyModule = process.argv[2];
if (!legacyModule) throw new Error("用法:node smoke.mjs <legacy.mjs>");
const legacy = (await import(pathToFileURL(legacyModule).href)) as { LIBRARY_PY: string };

const at = (rel: string): string => join(workflowsRoot(), rel);
const read = (rel: string): string => readFileSync(at(rel), "utf8");
const LIB = "scripts/library.py";
const CIT = "scripts/check_citations.py";

console.log("\n新装:全部写出来,并记下发了哪一版");
{
  const r = ensureWorkflows();
  check("library.py 写出来了且是当前版", read(LIB) === LIBRARY_PY);
  check("转录脚本也在", read("scripts/mineru_transcribe.py") === MINERU_PY);
  check("报告里列了新写的文件", r.written.includes(LIB), r);
  check("★ 记下了发出去的是哪一版", existsSync(at(SHIPPED_RECORD_FILE)));
  const again = ensureWorkflows();
  check("再跑一次什么都不动(幂等)", again.written.length === 0 && again.upgraded.length === 0 && again.keptModified.length === 0, again);
}

console.log("\n老安装(没有记录):真发过的旧版被认出来并升级");
{
  rmSync(at(SHIPPED_RECORD_FILE));
  writeFileSync(at(LIB), legacy.LIBRARY_PY, "utf8");
  check("前提:旧版确实和当前版不一样", legacy.LIBRARY_PY !== LIBRARY_PY);
  check("前提:旧版在已知原版清单里", (LEGACY_SHIPPED_SHA256[LIB] ?? []).includes(shippedHashOf(legacy.LIBRARY_PY)));
  const r = ensureWorkflows();
  check("★ 没改过的旧版 library.py 换成了当前版", read(LIB) === LIBRARY_PY, read(LIB).slice(0, 80));
  check("★ 报告里说升级了它", r.upgraded.includes(LIB), r);
  check("升级后当前版含屏蔽逻辑", read(LIB).includes("suppress_reason"));
}

console.log("\nWindows 换行:CRLF 的原版不算改过");
{
  writeFileSync(at(LIB), LIBRARY_PY.replace(/\n/g, "\r\n"), "utf8");
  const r = ensureWorkflows();
  check("当前版的 CRLF 副本不当成用户改过", !r.keptModified.includes(LIB) && !r.upgraded.includes(LIB), r);
  writeFileSync(at(LIB), legacy.LIBRARY_PY.replace(/\n/g, "\r\n"), "utf8");
  rmSync(at(SHIPPED_RECORD_FILE));
  const r2 = ensureWorkflows();
  check("★ 旧版的 CRLF 副本也认得出、照样升级", r2.upgraded.includes(LIB) && read(LIB) === LIBRARY_PY, r2);
}

console.log("\n用户改过的:一律不动");
{
  const mine = `${LIBRARY_PY}\n# 我自己加的一行\n`;
  writeFileSync(at(LIB), mine, "utf8");
  const r = ensureWorkflows();
  check("★ 改过的 library.py 原样留着", read(LIB) === mine);
  check("★ 报告里说留着它(启动日志要提醒)", r.keptModified.includes(LIB), r);

  rmSync(at(SHIPPED_RECORD_FILE));
  const oldMine = `${legacy.LIBRARY_PY}\n# 在旧版上改过\n`;
  writeFileSync(at(LIB), oldMine, "utf8");
  const r2 = ensureWorkflows();
  check("★ 在旧版上改过的也不动(老安装没有记录时)", read(LIB) === oldMine && r2.keptModified.includes(LIB), r2);
}

console.log("\n以后的版本:按记录认原版");
{
  // 模拟「上一版发的是 X」:把 X 写进文件、记录里记 X 的哈希;这一版发的是 CHECK_CITATIONS_PY。
  const prev = "# 上一版发的 check_citations.py\nprint('old')\n";
  writeFileSync(at(CIT), prev, "utf8");
  const record = JSON.parse(readFileSync(at(SHIPPED_RECORD_FILE), "utf8")) as Record<string, string>;
  record[CIT] = shippedHashOf(prev);
  writeFileSync(at(SHIPPED_RECORD_FILE), JSON.stringify(record), "utf8");
  const r = ensureWorkflows();
  check("★ 记录里那一版原封未动 → 换成新版", read(CIT) === CHECK_CITATIONS_PY && r.upgraded.includes(CIT), r);
}

console.log("\n删掉的文件:重新写回(「恢复原版」的老办法照样管用)");
{
  rmSync(at(LIB));
  const r = ensureWorkflows();
  check("删掉后重启就写回当前版", read(LIB) === LIBRARY_PY && r.written.includes(LIB), r);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
