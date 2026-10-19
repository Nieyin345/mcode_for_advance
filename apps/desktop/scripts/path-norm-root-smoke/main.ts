import { normPathKey } from "../../src/main/lib/pathNorm.js";
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Windows NT 10.0", maxTouchPoints: 0 }, configurable: true });
const { normWorktreeKey } = await import("../../src/renderer/lib/worktree.js");
let pass = 0, fail = 0;
function check(name: string, ok: boolean) {
 console.log((ok ? "PASS " : "FAIL ") + name);
 if (ok) pass++; else fail++;
}
for (const [raw, desired] of [["/", "/"], ["\\", "/"], ["C:\\", "c:/"], ["C:/", "c:/"], ["C:", "c:"], ["\\\\server\\share\\", "//server/share/"], ["\\\\server\\share", "//server/share/"], ["C:\\work\\", "c:/work"], ["", ""]]) {
 const main = normPathKey(raw);
 const ui = normWorktreeKey(raw);
 check("main path key " + JSON.stringify(raw), main === desired);
 check("renderer path key parity " + JSON.stringify(raw), ui === desired && ui === main);
}
check("root distinct from empty string", normPathKey("/") !== normPathKey(""));
check("drive root distinct from drive-relative path", normPathKey("C:\\") !== normPathKey("C:"));
check("UNC root distinct from UNC subfolder", normPathKey("\\\\server\\share\\") !== normPathKey("\\\\server\\share\\dir"));
console.log(`path-norm-root-smoke: ${pass}/${pass + fail}`);
if (fail) process.exitCode = 1;
