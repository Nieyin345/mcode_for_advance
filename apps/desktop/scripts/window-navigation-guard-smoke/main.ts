/** ARC-005 shell trust boundary: native window entry and external URL handoff.
 * No Electron process, network, or real OS open calls; fake webContents only.
 */
import { externalWindowUrl, isMainWindowEntry, installMainWindowNavigation } from "../../src/main/lib/windowNavigation.js";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); }
}

const entry = "file:///D:/app/main/index.html";
check("同一入口可改 query/hash", isMainWindowEntry(entry + "?t=1#section", entry));
check("不同页面不能继承主窗口权限", !isMainWindowEntry("file:///D:/app/main/other.html", entry));
check("不同协议不得继承主窗口", !isMainWindowEntry("https://example.com/", entry));
check("内联 LF 不得被 URL parser 删掉后冒充可信入口",
  !isMainWindowEntry("file:///D:/app/main/ind\nex.html", entry));
check("内联 TAB 不得被 URL parser 删掉后冒充可信入口",
  !isMainWindowEntry("file:///D:/app/main/ind\tex.html", entry));
check("主窗口源尾空白不得悄悄删掉",
  !isMainWindowEntry(entry + " ", entry));

check("正常 https URL 可以交系统浏览器", externalWindowUrl("https://example.com/path") === "https://example.com/path");
check("正常 mailto 可以交系统邮件应用", externalWindowUrl("mailto:help@example.com?subject=ok") !== null);
for (const protocol of ["javascript:alert(1)", "file:///C:/secret", "data:text/html,x"]) {
  check(`禁用 ${protocol.split(":")[0]} 弹窗协议`, externalWindowUrl(protocol) === null);
}
check("禁止 URL username/password 嵌入", externalWindowUrl("https://name:pass@example.com") === null);
for (const [name, raw] of [
  ["LF", "https://exa\nmple.com/link"],
  ["TAB", "https://exa\tmple.com/link"],
  ["CR", "https://exa\rmple.com/link"],
  ["尾空格", "https://example.com/link "],
] as const) {
  check(`★ 外链 ${name} 不能被规范化成另一个 URL 后悄悄打开`, externalWindowUrl(raw) === null, externalWindowUrl(raw));
}

// Check the real callbacks (not only helper assertions).
const handlers = new Map<string, (...args: any[]) => void>();
let openHandler: ((x: { url: string }) => { action: string }) | null = null;
const opened: string[] = [];
const warnings: string[] = [];
installMainWindowNavigation({
  on: (event: string, fn: (...args: any[]) => void) => { handlers.set(event, fn); return {} as never; },
  setWindowOpenHandler: (fn: (x: { url: string }) => { action: string }) => { openHandler = fn; },
} as never, entry, async (url) => { opened.push(url); }, (message) => warnings.push(message));
const state = { prevented: false, preventDefault() { this.prevented = true; } };
handlers.get("will-navigate")!(state, "file:///D:/app/main/index\n.html");
check("主窗口导航实际回调拒绝含控制符路径", state.prevented);
const redirect = { prevented: false, preventDefault() { this.prevented = true; } };
handlers.get("will-redirect")!(redirect, "https://outside.test", false, false);
check("子 frame redirect 不更改主窗口", !redirect.prevented);
handlers.get("will-redirect")!(redirect, "https://outside.test", false, true);
check("顶层 redirect 禁止跨到外站", redirect.prevented);
const popup = openHandler as unknown as (x: { url: string }) => { action: string };
check("无论 URL 是否允许，渲染端 popup 一律不新建权限窗",
  popup({ url: "https://example.com/a" }).action === "deny");
check("带 LF 的外链仍只返回 deny", popup({ url: "https://exa\nmple.com/a" }).action === "deny");
await Promise.resolve();
await Promise.resolve();
check("只能实际打开合法外链", opened.length === 1 && opened[0] === "https://example.com/a", opened);
check("警告不能泄漏外链 URL", warnings.every((w) => !w.includes("outside.test") && !w.includes("exa\\n")), warnings);

console.log(`window-navigation-guard-smoke:${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
