import { desktopCsp } from "../../src/main/lib/desktopCsp.js";
let ok = 0, bad = 0;
function check(name: string, cond: boolean, actual?: unknown): void {
  if (cond) { ok++; console.log("PASS " + name); }
  else { bad++; console.log("FAIL " + name + " " + String(actual)); }
}
const own = "file:///app/dist/renderer/index.html";
const normal = desktopCsp(own, own, "https://editor.example.test");
check("trusted main renderer receives CSP", !!normal && normal.includes("script-src"));
check("legitimate hash+query on trusted renderer retains policy", desktopCsp(own+"?frame=1#anchor", own, "https://editor.example.test") === normal);
check("external Office iframe retains its own headers", desktopCsp("https://editor.example.test/word/editor.html", own) === null);
check("unrelated local renderer never gets app CSP", desktopCsp("file:///app/dist/renderer/other.html", own) === null);
for (const [label, crafted] of [
  ["embedded tab", "file:///app/dist/ren\tderer/index.html"],
  ["embedded newline", "file:///app/dist/render\ner/index.html"],
  ["embedded CR", "file:///app/dist/renderer/in\rdex.html"],
  ["leading whitespace", "  " + own],
  ["trailing whitespace", own + "  "],
]) {
  check("★ deceptive URL with " + label + " must never receive trusted-renderer CSP",
    desktopCsp(crafted, own) === null, crafted);
}
console.log(`desktop-csp-boundary-smoke: ${ok}/${ok+bad}`);
if (bad) process.exitCode = 1;
