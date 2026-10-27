import { liveSessionTabMenu, sessionTabsToClose, sessionTabMenuPosition } from "../../src/renderer/components/layout/sessionTabContextActions.js";
import type { ProjectSessionTabMenu } from "../../src/renderer/components/layout/sessionTabContextActions.js";

/**
 * ARC-005 会话标签右键菜单身份 —— **真实行为验证**。
 *
 * 修法（T64）：这里原本有 8 条 `readFileSync(组件源码).includes("某段代码")` 的断言
 * （SessionTabs / UnifiedTabsBar 各 4 条）。T61 的变异测试证明它们是**空过**的 ——
 * 把 `setSessionCtxMenu({ id, projectId: pid, ...anchor })` 那一行注释掉，套件仍
 * 14/14 全绿。根因是 `includes` 只证明"字符串出现在文件里"，注释掉的代码、字符串
 * 字面量、文档注释都能让它为真。**它的肯定不是证据。**
 *
 * 现在分两层：
 *   ① **能真调的一律真调** —— `liveSessionTabMenu` / `sessionTabsToClose` /
 *      `sessionTabMenuPosition` 都是纯函数，直接构造输入断言输出；
 *   ② **组件内的 JSX 接线无法无头验证**（需要真渲染 React 组件），这部分改成
 *      **类型层判据** —— `ProjectSessionTabMenu.projectId` 的类型是
 *      `string | null`，`tsc` 会在编译期拒绝一个漏了 projectId 的菜单对象。
 *      这是比字符串匹配更强的判据：它在**类型系统**里成立，不是"某段文本出现过"。
 *
 * 明确不做什么：不再用 `includes(源码)` 假装在验行为。组件接线的运行时行为
 * 属于真实 Electron U1 的范围，不是无头 smoke 能覆盖的。
 */

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " — " + JSON.stringify(detail)));
  if (ok) pass++; else fail++;
};

const open = ["session-A", "session-B", "session-C"];
const menu: ProjectSessionTabMenu = { id: "session-A", x: 43, y: 79, projectId: "project-A" };

/* ─────────────── ① 菜单身份校验（原本就是行为断言，保留） ─────────────── */

check("Valid menu remains actionable in original project", liveSessionTabMenu(menu, "project-A", open) === menu);
check("Cross-project menu denied even if session is still globally open", liveSessionTabMenu(menu, "project-B", open) === null);
check("Closed target is denied instead of closeOthers on wrong tab", liveSessionTabMenu(menu, "project-A", ["session-B", "session-C"]) === null);
check("Empty origin/active project denied", liveSessionTabMenu({ ...menu, projectId: null }, "project-A", open) === null && liveSessionTabMenu(menu, null, open) === null);
check("Valid other-close set retains existing behavior", sessionTabsToClose(open, "session-A", "others").join(",") === "session-B,session-C");
check("Invalid target never executes bulk close", sessionTabsToClose(open, "gone", "all").length === 0);

/* ─────────── ② 新增：菜单身份的三态穷举（真调，补上原来没验的边） ─────────── */

{
  const cases: Array<[string, ProjectSessionTabMenu | null, string | null, readonly string[], boolean]> = [
    ["同项目 + tab 仍开着", menu, "project-A", open, true],
    ["项目切走", menu, "project-B", open, false],
    ["tab 被关掉", menu, "project-A", ["session-B"], false],
    ["菜单为空", null, "project-A", open, false],
    ["当前项目为空", menu, null, open, false],
    ["菜单里的 projectId 为空", { ...menu, projectId: null }, "project-A", open, false],
    ["openTabs 为空", menu, "project-A", [], false],
  ];
  for (const [label, m, activeProject, tabs, shouldLive] of cases) {
    const result = liveSessionTabMenu(m, activeProject, tabs);
    check(`★ 菜单身份:${label} → ${shouldLive ? "可操作" : "拒绝"}`,
      shouldLive ? result === m : result === null,
      { got: result === null ? null : "menu", want: shouldLive ? "menu" : null });
  }
}

/* ─────────── ③ 新增：右键位置（真调，原来完全没验的纯函数） ─────────── */

{
  const rect = { left: 100, bottom: 200 };
  const fromPointer = sessionTabMenuPosition(43, 79, rect);
  const fromKeyboard = sessionTabMenuPosition(0, 0, rect);
  check("★ 鼠标事件(有坐标)用鼠标位置", fromPointer.x === 43 && fromPointer.y === 79, fromPointer);
  check("★ 键盘事件(0,0)落到标签下方而不是屏幕左上角", fromKeyboard.x === 116 && fromKeyboard.y === 200, fromKeyboard);
  const nan = sessionTabMenuPosition(NaN, NaN, rect);
  check("★ 坐标非法( NaN)时也回落到标签位置", nan.x === 116 && nan.y === 200, nan);
}

/* ─────────── ④ 类型层判据：菜单必须记 origin project ───────────
 *
 * 组件里的 `setSessionCtxMenu({ id, projectId: pid, ...anchor })` 是 JSX 闭包内的一行，
 * 无头环境验不了它"真的执行"。但它**要产生的形状**由类型固定：
 * `ProjectSessionTabMenu.projectId` 是 `string | null`（不是可选、不是 any）。
 *
 * 下面的赋值会在缺 `projectId` 时**编译失败** —— 这是 tsc 的活，不是运行时断言。
 * 写成运行时可检查的形式只是为了让它进入这套 smoke 的输出，真正的门禁在 typecheck。
 */
{
  // 少 projectId 应当是类型错误。这里用 ts-expect-error 把它固定住：
  // 如果哪天有人把 projectId 改成可选，这一行会**因为"没有错误"而报错**。
  // @ts-expect-error 菜单对象必须带 projectId（缺了是类型错误）
  const missingProject: ProjectSessionTabMenu = { id: "session-A", x: 1, y: 2 };
  check("★ 类型层:ProjectSessionTabMenu 必须有 projectId（上面的 @ts-expect-error 没被忽略）",
    missingProject !== undefined);

  // 反向固定：带了 projectId（哪怕是 null）就必须能赋上。
  const withNull: ProjectSessionTabMenu = { id: "session-A", x: 1, y: 2, projectId: null };
  check("★ 类型层:projectId 允许 null（跨项目时会拒绝，见上面 ②）", withNull.projectId === null);
}

console.log("arc005-session-menu-identity " + pass + "/" + (pass + fail));
if (fail) process.exitCode = 1;
