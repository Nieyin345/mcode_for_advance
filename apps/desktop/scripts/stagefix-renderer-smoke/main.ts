/** ARC-005: isolated regressions for chat HTML cache and editor navigation. */
import { codeCacheKey, getCodeHtml, setCodeHtml, codeHtmlCache, fnv1a } from "../../src/renderer/lib/markdownCache.js";
import { getLastCursor, setLastCursor } from "../../src/renderer/lib/editorNav.js";

let total = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  total++;
  const passed = Object.is(actual, expected);
  console.log(`  ${passed ? "PASS" : "FAIL"} ${name}${passed ? "" : ` — actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`}`);
  if (!passed) failed++;
}

console.log("Stagefix: precise cache keys and safe navigation positions");
// Deterministic 32-bit FNV collision (not random / probability-dependent).
const a = "o74jt443mci0";
const b = "pxn6d9dlz685";
check("fixture exhibits a real FNV32 collision", fnv1a(a), fnv1a(b));
const keyA = codeCacheKey(a, "ts", "dark");
const keyB = codeCacheKey(b, "ts", "dark");
check("distinct code never shares a cache key even under FNV32 collision", keyA !== keyB, true);
codeHtmlCache.clear();
setCodeHtml(keyA, "<pre>code A</pre>");
check("colliding other code cannot render first code's HTML", getCodeHtml(keyB), undefined);
check("exact code cache hit remains usable", getCodeHtml(keyA), "<pre>code A</pre>");

// Using one NUL between fields is ambiguous when the inputs contain NUL.
check(
  "language/text boundary cannot impersonate another code block",
  codeCacheKey("a\u0000b", "c", "dark") !== codeCacheKey("a", "b\u0000c", "dark"),
  true,
);
check("cache key separates different themes", codeCacheKey(a, "ts", "dark") !== codeCacheKey(a, "ts", "light"), true);

const callerPos = { line: 3, column: 6 };
setLastCursor("/fixture/one.ts", callerPos);
callerPos.line = 800;
check("caller mutation after set cannot change the saved cursor", getLastCursor("/fixture/one.ts")?.line, 3);
const returnedPos = getLastCursor("/fixture/one.ts");
if (returnedPos) returnedPos.column = 900;
check("caller mutation of returned cursor cannot change cache", getLastCursor("/fixture/one.ts")?.column, 6);

setLastCursor("/fixture/bad-zero.ts", { line: 0, column: 1 });
check("zero-based legacy cursor normalizes to Monaco line 1", getLastCursor("/fixture/bad-zero.ts")?.line, 1);
setLastCursor("/fixture/bad-negative.ts", { line: -1, column: 1 });
check("negative cursor line is never persisted", getLastCursor("/fixture/bad-negative.ts"), undefined);
setLastCursor("/fixture/bad-nan.ts", { line: Number.NaN, column: 1 });
check("NaN cursor position is not persisted", getLastCursor("/fixture/bad-nan.ts"), undefined);
setLastCursor("/fixture/bad-inf.ts", { line: 1, column: Infinity });
check("infinite cursor position is not persisted", getLastCursor("/fixture/bad-inf.ts"), undefined);

console.log(`stagefix-renderer-smoke: ${total-failed}/${total} PASS`);
if (failed) process.exitCode = 1;
