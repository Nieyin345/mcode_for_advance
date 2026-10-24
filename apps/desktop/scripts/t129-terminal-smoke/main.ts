/**
 * 【T129】底部终端「默认关闭」与 PTY 保活的结构回归。
 *
 * ## 这套验什么，不验什么（诚实清单）
 *
 * **验不了**：真 PTY 在关开之间的 scrollback。那需要真起 Electron + 真 ConPTY，
 * 而本套不起 Electron。**所以「关掉再打开，scrollback 还在」这一条，本套只验
 * 「DOM 没有被卸载」这个必要条件，不验充分条件。**
 *
 * 判据是这样的：PTY 保活依赖「组件始终挂载」。挂载由三件事保证：
 *   1. 父容器**条件渲染的是外壳 div，不是 `bottomTerminal` 本身**；
 *   2. 关闭态用 `h-0`（高度塌陷）而不是 `return null`；
 *   3. `inert` + `aria-hidden` 让它在关闭时不可交互但仍在 DOM 里。
 *
 * 只要这三条在，xterm 实例与 node-pty 连接就活着 —— 那是 `TerminalPanel` 的
 * `useEffect` 清理函数决定的，而清理只在卸载时跑。
 *
 * **变异表第三行（把 BottomTerminalBar 改成条件渲染）就是模拟「卸载」**，
 * 如果它不红，说明这套没在守 PTY 保活。
 *
 * ## 为什么单独一套
 *
 * 现有的 `terminal-smoke` 是主进程层（`TerminalManager` + IPC），一行渲染端都不验。
 * 而 T129 的全部风险在渲染端：**改错一个字，所有 PTY 一起死，而界面看不出来。**
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

// `run.sh` 会 `cd apps/desktop` 后再跑，cwd 即包根。
// 不能用 `import.meta.dirname` —— esbuild 把本文件打到临时目录。
const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const store = read("src/renderer/stores/sessionStore.ts");
const layout = read("src/renderer/components/layout/ThreePaneLayout.tsx");
const bar = read("src/renderer/components/layout/BottomTerminalBar.tsx");
const titlebar = read("src/renderer/components/layout/Titlebar.tsx");

console.log("── 一、默认关闭 ──");

/* 初值必须是 false。这是这张卡的第一条验收判据。
 * ⚠️ 用带边界的正则：`bottomTerminalOpen: false` 后面可能跟逗号或换行，
 * 但 `bottomTerminalHeight:` 之类的同前缀键不能误伤。 */
const initialValue = /bottomTerminalOpen:\s*(true|false)/.exec(store);
check("sessionStore 里 bottomTerminalOpen 的初值是 false", initialValue?.[1] === "false", {
  found: initialValue?.[0] ?? "(未找到)",
});

/* 老用户的选择不能被覆盖 —— 如果这个键进了持久化列表，那么「改初值」会
 * 悄悄重置所有人。反过来，如果它不在持久化列表里，那它本来就每次启动都是 false，
 * 「默认关闭」这件事早就成立了，本卡只是把它钉住。
 *
 * 两种都合法，但**必须知道自己处在哪一种** —— 所以断言写的是「持久化字段列表里
 * 没有它」，并在回写里说明这意味着什么。 */
const paneFields = /type PanePersistedField\s*=\s*([^;]+);/.exec(store)?.[1] ?? "";
check("bottomTerminalOpen 不在 PanePersistedField 里（每次启动都是初值）",
  paneFields.length > 0 && !paneFields.includes("bottomTerminalOpen"),
  { paneFields });

console.log("\n── 二、关闭态不占布局 ──");

/* 关闭时外层容器是 `h-0`，且**不带 border-t**。
 * 这是「视觉上干不干净」那条 —— 只 h-0 不摘 border 的话，会留一条线。 */
check("关闭态用 h-0 塌陷高度（而不是卸载）",
  /bottomTerminalOpen\s*\?\s*"border-t"\s*:\s*"h-0"/.test(layout),
  { found: layout.match(/bottomTerminalOpen\s*\?[^,}]*/g)?.slice(0, 3) });
check("关闭态没有 border-t（h-0 分支里不带边框类）",
  !/h-0[^"]*border-t|border-t[^"]*h-0/.test(layout),
  {});
check("外层容器 overflow-hidden（保证内层边框被裁掉）",
  /shrink-0 overflow-hidden[^"]*transition-\[height\]/.test(layout),
  {});

console.log("\n── 三、★ PTY 保活的结构条件 ──");

/* 第 1 条：父容器条件渲染的是**外壳 div**，不是 `bottomTerminal` 本身。
 * 换句话说 `{bottomTerminal && (...)}` 里包的是 `<div className="h-0">`，
 * 而 `{bottomTerminal}` 作为**子节点**始终渲染。 */
check("ThreePaneLayout 始终渲染 {bottomTerminal}（条件在外壳，不在它本身）",
  /\{bottomTerminal\}/.test(layout),
  { found: layout.match(/\{bottomTerminal[^}]*\}/g) });

/* 第 2 条：关闭态用 inert + aria-hidden，而不是从 DOM 移除。 */
check("关闭态用 inert（不可交互但仍在 DOM）",
  /inert=\{!bottomTerminalOpen\}/.test(layout), {});
check("关闭态用 aria-hidden（对辅助技术隐藏）",
  /aria-hidden=\{!bottomTerminalOpen\}/.test(layout), {});

/* 第 3 条：BottomTerminalBar 自己**不卸载** —— 它用 `invisible` 隐藏，
 * 而不是 `return null` 或 `if (!active) return null`。
 * 这条是「变异 3」直接攻击的位置。 */
check("BottomTerminalBar 关闭时用 invisible 而不是返回 null",
  /!active && "invisible"/.test(bar) && !/if\s*\(\s*!active\s*\)\s*return\s+null/.test(bar),
  { found: bar.match(/!active[^,)]*/g) });
check("BottomTerminalBar 的 {active} 传给 TerminalPanel（不是条件渲染它）",
  /<TerminalPanel active=\{active\}/.test(bar),
  { found: bar.match(/<TerminalPanel[^>]*>/g) });

console.log("\n── 四、终端按钮找得到 ──");

/* 默认关闭之后，用户必须还能打开它。按钮在 Titlebar 上。 */
check("Titlebar 有终端开关按钮（onToggleBottomTerminal）",
  /onToggleBottomTerminal/.test(titlebar), {});
check("按钮的 aria-label 随开关状态变化（不是写死一句）",
  /aria-label=\{bottomTerminalOpen \?/.test(titlebar),
  { found: titlebar.match(/aria-label=\{[^}]*bottomTerminalOpen[^}]*\}/g) });

console.log("\n── 五、负控：别把「保活」写成「卸载」 ──");

/* 这一节的存在理由是：上面所有断言都可能全绿，而有人把 BottomTerminalBar
 * 改成 `{bottomTerminalOpen && <BottomTerminalBar/>}` —— 那时 §三 的第 1 条
 * （`{bottomTerminal}` 存在）仍然为真（它在别处），但语义已经变了。
 *
 * 所以这里直接读 ClassicShell 的传参，确认 `bottomTerminal=` 是无条件的。 */
const shell = read("src/renderer/components/shell/ClassicShell.tsx");
check("负控：ClassicShell 无条件传 bottomTerminal（没有挂在 bottomTerminalOpen 上）",
  /bottomTerminal=\{<BottomTerminalBar active=\{bottomTerminalOpen\} \/>\}/.test(shell),
  { found: shell.match(/bottomTerminal=\{[^}]*\}[^}]*\}[^}]*\}|\S*bottomTerminal=\S+/g)?.slice(0, 2) });

console.log(`\nt129-terminal-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
