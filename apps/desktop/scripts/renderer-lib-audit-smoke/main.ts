/**
 * 渲染库审计回归 —— `renderer/lib/` 里命令注册表 / 快捷键 / 路径 / 模型缓存的无头网。
 *
 * 本节的重点是**两处「同一条规则各写一份、然后漂了」**：
 *
 *  1. 「统一中间栏当前归谁」这条规则在**两份实现**里各写了一遍 ——
 *     `session.close` 走共享的 `editorCenterTarget` 私有 helper（带 `displayMode` /
 *     `widePanelOpen` / `centerTabFocus` 三个前置条件），`tab.close` 却在 `perform`
 *     里内联了一份**少了 `displayMode` / `widePanelOpen`** 的简化版。后果：宽屏面板
 *     开着时（中间栏被聊天列占着、编辑器其实**不在屏上**），`tab.close` 会把一个
 *     **看不见的**编辑器文件悄悄关掉，而用户在屏上看到的是会话标签 —— 该关的是它。
 *     两条命令在同一次按键意图下做出相反的决定。
 *  2. `path.isPathWithin` 的分隔符无关 + Windows 大小写规则，与 `relativePath` 的
 *     纯字符串比较规则 —— 前者刻意对 Windows 盘符/UNC 不区分大小写，后者不。钉住二者
 *     的现状，免得以后有人「统一」成错的。
 *
 * 判据立在**用户看到的后果**上：这次按下去，关掉的是哪个东西。
 *
 * Run: scripts/renderer-lib-audit-smoke/run.sh
 */
import "./prelude.js";
import { collectCommands } from "../../src/renderer/lib/commands.js";
import type { SessionState } from "../../src/renderer/stores/sessionStore.js";
import { isPathWithin, relativePath, resolveRelativePath, dirname, basename } from "../../src/renderer/lib/path.js";
import { checkoutArgsFor, remoteShortName } from "../../src/renderer/lib/branchRef.js";
import type { GitBranchInfo } from "@contracts/ipc";
import {
  resolveShortcut,
  resolveAllShortcuts,
  unbindOverrideFor,
  acceleratorToString,
  parseAcceleratorString,
  shouldDispatchInEditable,
  isFunctionKey,
  matchAccelerator,
  DEFAULT_SHORTCUTS,
  UNBOUND_ACCELERATOR,
} from "../../src/renderer/lib/shortcuts.js";
import {
  registerModel,
  getModelEntry,
  getBaseline,
  updateBaseline,
  disposeModel,
  getDisplayedPath,
  setDisplayedPath,
} from "../../src/renderer/lib/editorModelCache.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function section(t: string): void {
  console.log(`\n${t}`);
}

/* ─────────────────── 1. 中间栏归属：tab.close 与 session.close 必须同源 ─────────────────── */

section("1. 中间栏归属规则：两条关闭命令不许各写一份");

/** 造一个最小的 live store 桩，记录命令真正调了哪些动作。 */
function runClose(id: string, initial: Partial<SessionState>) {
  const calls: string[] = [];
  const state = {
    locale: "zh",
    displayMode: "tabs",
    widePanelOpen: false,
    centerTabFocus: "editor",
    activeProjectId: "p1",
    activeSessionId: "s1",
    ideActiveFileByProject: { p1: "/p/a.ts" },
    planTabActiveBySession: {},
    openTabs: ["s1"],
    sessionsByProject: { p1: [] },
    // 命令会调到的几个动作：
    closePlanDrawer: (sid: string) => calls.push(`closePlan:${sid}`),
    closeFileInIde: (f: string) => { calls.push(`closeFile:${f}`); return { closed: [f], blocked: [] as string[] }; },
    reportBlockedIdeClose: () => {}, // 只登记脏拦截提示，不影响“关了什么”的判据
    closeTab: (sid: string) => calls.push(`closeTab:${sid}`),
    ...initial,
  } as unknown as SessionState;
  const cmd = collectCommands(state).find((c) => c.id === id);
  if (!cmd) return { calls, missing: true };
  cmd.perform(state);
  return { calls, missing: false };
}

{
  // ★ 宽屏面板开着：中间栏显示的是聊天列（编辑器**不可见**），此刻「关闭」应关会话标签。
  //   session.close 一直这么判；tab.close 从前把不可见的文件关了 —— 这就是漂移。
  const tab = runClose("tab.close", { widePanelOpen: true, centerTabFocus: "editor" } as Partial<SessionState>);
  check("★ 宽屏面板下 tab.close 关的是会话标签(不关看不见的文件)", tab.calls.includes("closeTab:s1"), tab.calls);
  check("★ 宽屏面板下 tab.close 不关文件", !tab.calls.some((c) => c.startsWith("closeFile")), tab.calls);

  const sess = runClose("session.close", { widePanelOpen: true, centerTabFocus: "editor" } as Partial<SessionState>);
  check("同状态下 session.close 也关会话标签(两命令一致)", sess.calls.includes("closeTab:s1"), sess.calls);
}

{
  // 正控：非宽屏、编辑器聚焦且有活动文件 → 两条都该关**文件**。
  for (const id of ["tab.close", "session.close"]) {
    const { calls } = runClose(id, { widePanelOpen: false, centerTabFocus: "editor" } as Partial<SessionState>);
    check(`正控 ${id}:编辑器聚焦时关文件`, calls.includes("closeFile:/p/a.ts"), calls);
    check(`正控 ${id}:此时不关会话`, !calls.includes("closeTab:s1"), calls);
  }
}

{
  // 正控：编辑器聚焦但计划页签激活 → 关计划抽屉（不是文件、不是会话）。
  for (const id of ["tab.close", "session.close"]) {
    const { calls } = runClose(id, {
      widePanelOpen: false,
      centerTabFocus: "editor",
      planTabActiveBySession: { s1: true },
    } as Partial<SessionState>);
    check(`正控 ${id}:计划页签激活时关计划抽屉`, calls.includes("closePlan:s1"), calls);
    check(`正控 ${id}:关计划时不关文件/会话`, !calls.some((c) => c.startsWith("closeFile") || c.startsWith("closeTab")), calls);
  }
}

{
  // 正控：编辑器**未**聚焦（去看了聊天）→ 两条都关会话标签。
  for (const id of ["tab.close", "session.close"]) {
    const { calls } = runClose(id, { centerTabFocus: "chat" } as Partial<SessionState>);
    check(`正控 ${id}:编辑器未聚焦时关会话`, calls.includes("closeTab:s1"), calls);
  }
}

/* ─────────────────── 2. 路径：分隔符无关 + Windows 大小写（钉现状） ─────────────────── */

section("2. 路径包含/相对：分隔符无关 + Windows 大小写");

{
  const BS = "\\";
  const winRoot = "D:" + BS + "proj";
  check("★ Windows 反斜杠根:文件在项目里", isPathWithin(winRoot, "D:" + BS + "proj" + BS + "src" + BS + "a.ts"));
  eq("★ Windows 盘符大小写不同也算在里", isPathWithin("d:" + BS + "proj", "D:" + BS + "proj" + BS + "a.ts"), true);
  eq("同级前缀目录不算在里", isPathWithin(winRoot, "D:" + BS + "project-evil" + BS + "x.ts"), false);
  eq("POSIX 大小写敏感(Linux 语义)", isPathWithin("/Home/u/proj", "/home/u/proj/a.ts"), false);
  eq("空根一律拒绝", isPathWithin("", "/x/y.ts"), false);

  // relativePath 是**纯字符串**比较（不搞 Windows 大小写折叠）—— 钉现状：盘符大小写不同则
  // 判“不在 root 下”，原样返回。与 isPathWithin 的折叠是**刻意的不同**，别顺手“统一”。
  eq("★ relativePath 盘符大小写不同 → 不算相对(纯字符串)", relativePath("D:/proj/a.ts", "d:/proj"), "D:/proj/a.ts");
  eq("relativePath 同大小写 → 相对", relativePath("D:/proj/a.ts", "D:/proj"), "a.ts");
  eq("relativePath 无关根 → 原样返回", relativePath("/elsewhere/x.ts", "/proj"), "/elsewhere/x.ts");

  // resolveRelativePath 不许被 `..` 顶穿 root。
  eq("resolveRelativePath `..` 不越根(POSIX)", resolveRelativePath("/a/b", "../../../c"), "/c");
  eq("resolveRelativePath 消 `.`/`..`", resolveRelativePath("D:/proj/docs", "images/../img/a.png"), "D:/proj/docs/img/a.png");

  eq("dirname 文件 → 目录", dirname("foo/bar/baz.ts"), "foo/bar");
  eq("basename 文件 → 名", basename("foo/bar/baz.ts"), "baz.ts");
}

/* ─────────────────── 3. 快捷键：默认表 / 空键解绑 / 输入区放行 ─────────────────── */

section("3. 快捷键：解绑覆盖 + 输入区分发");

{
  // 空 key 覆盖 = 显式解绑（连默认键一起去掉）。
  eq("无覆盖时有默认键", resolveShortcut("command.palette", {})?.key, "k");
  eq("空键覆盖 → null(解绑)", resolveShortcut("command.palette", { "command.palette": UNBOUND_ACCELERATOR }), null);
  eq("无默认键的命令 unbindOverrideFor → null(删覆盖)", unbindOverrideFor("no.such.command"), null);
  eq("有默认键的命令 unbindOverrideFor → 空键覆盖", unbindOverrideFor("command.palette")?.key, "");

  // resolveAllShortcuts 里空键覆盖要从 effective 表里删掉（否则它会盖住默认键）。
  const all = resolveAllShortcuts({ "command.palette": UNBOUND_ACCELERATOR });
  check("空键覆盖后 effective 里没有该命令", !("command.palette" in all), Object.keys(all));

  // 序列化往返。
  eq("accelerator 往返 cmd+shift+f", acceleratorToString(parseAcceleratorString("cmd+shift+f")!), "cmd+shift+f");

  // 输入区分发：裸键放行、带修饰键拦截、F 功能键放行。
  eq("输入区裸键放行", shouldDispatchInEditable({ key: "b", cmd: false, shift: false, alt: false }), false);
  eq("输入区 Cmd+B 拦截", shouldDispatchInEditable({ key: "b", cmd: true, shift: false, alt: false }), true);
  eq("输入区 F5 放行(不产生字符)", shouldDispatchInEditable({ key: "f5", cmd: false, shift: false, alt: false }), true);
  eq("isFunctionKey f12", isFunctionKey("f12"), true);
  eq("isFunctionKey f13(不存在)", isFunctionKey("f13"), false);

  // 匹配：cmd 同时认 metaKey / ctrlKey。
  eq(
    "Ctrl+K 命中 cmd+k",
    matchAccelerator({ key: "k", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false } as KeyboardEvent, { key: "k", cmd: true, shift: false, alt: false }),
    true,
  );
}

/* ─────────────────── 4. 模型缓存：注册 / baseline / 处置 ─────────────────── */

section("4. Monaco 模型缓存：注册保 baseline、处置即回收");

{
  // 假模型只需 dispose()。
  let disposed = 0;
  const mk = () => ({ dispose: () => { disposed++; } }) as unknown as import("monaco-editor").editor.ITextModel;

  const m1 = mk();
  registerModel("/p/a.ts", m1, "content-v1");
  eq("注册后可取到 baseline", getBaseline("/p/a.ts"), "content-v1");
  eq("模型引用一致", getModelEntry("/p/a.ts")?.model, m1);

  // ★ 同路径重复注册（切回来重挂）：baseline 必须存活（未保存编辑状态不能丢），只换模型引用。
  const m2 = mk();
  registerModel("/p/a.ts", m2, "content-v1");
  eq("★ 重复注册保留 baseline（脏状态不丢）", getBaseline("/p/a.ts"), "content-v1");
  eq("重复注册刷新模型引用", getModelEntry("/p/a.ts")?.model, m2);

  updateBaseline("/p/a.ts", "content-v2");
  eq("更新 baseline 生效", getBaseline("/p/a.ts"), "content-v2");

  // 处置：删条目 + dispose 模型一次。
  disposeModel("/p/a.ts");
  eq("处置后条目没了", getModelEntry("/p/a.ts"), undefined);
  eq("处置后 baseline 没了", getBaseline("/p/a.ts"), undefined);
  check("处置会 dispose 模型", disposed >= 1, disposed);
  // 再处置无害（幂等）。
  disposeModel("/p/a.ts");
  check("重复处置不抛", true);

  // displayedPath 往返。
  setDisplayedPath("/p/x.ts");
  eq("displayedPath 往返", getDisplayedPath(), "/p/x.ts");
  setDisplayedPath(null);
  eq("displayedPath 清空", getDisplayedPath(), null);
}

/* ─────────────────── 5. 分支行点击:两个切换器共用一条判据 ─────────────────── */

section("5. 分支切换:远端短名 + 跟踪分支(两个切换器共用一条规则)");

{
  const b = (name: string, type: "local" | "remote" | "tag", current = false): GitBranchInfo =>
    ({ name, type, current, label: "", commit: "abc" }) as GitBranchInfo;

  eq("远端 origin/foo → 短名 foo", remoteShortName("origin/foo"), "foo");
  eq("远端多段 a/b/foo → 短名 b/foo(只去第一段)", remoteShortName("a/b/foo"), "b/foo");
  eq("无斜杠原样", remoteShortName("foo"), "foo");

  eq("当前分支 → 不 checkout", checkoutArgsFor(b("main", "local", true), new Set()), null);
  // 对象结果用 JSON 比(§5 的返回是 `{branch,newBranch?}`,Object.is 比不了)。
  const deep = (name: string, a: unknown, e: unknown): void => check(name, JSON.stringify(a) === JSON.stringify(e), { a, e });
  deep("本地分支 → 按名切", checkoutArgsFor(b("dev", "local"), new Set()), { branch: "dev" });
  deep("tag → 按名切(当本地分支处理)", checkoutArgsFor(b("v1.0", "tag"), new Set()), { branch: "v1.0" });
  // ★ 远端分支:本地已有同名短名 → 直接切;没有 → 建跟踪分支。
  deep("远端 + 本地已有同名 → 切本地短名", checkoutArgsFor(b("origin/foo", "remote"), new Set(["foo"])), { branch: "foo" });
  deep("远端 + 本地没有 → 建跟踪分支", checkoutArgsFor(b("origin/foo", "remote"), new Set()), { branch: "origin/foo", newBranch: "foo" });
}

/* ─────────────────── 6. 右栏标签 hydration 白名单须从 schema 派生 ─────────────────── */

section("6. 右栏标签白名单不许手抄一份枚举");

{
  // `sessionStore` 重启时给 `rightPanelTab` 做 hydration。从前那是一份**手抄的枚举**
  // (`tabRaw === "files" || … || "tasks"`),与 `RightPanelTabSchema` 漂过一次:
  // `browser` 只加进 schema、忘了那一行,用户选了它重启后右栏**悄悄**回到 files。
  // 判据:白名单必须从 `RightPanelTabSchema.options` 派生,不许再手抄枚举。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(process.cwd(), "src/renderer/stores/sessionStore.ts"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    "★ 右栏标签 hydration 从 RightPanelTabSchema.options 派生(不手抄枚举)",
    code.includes("RightPanelTabSchema.options"),
    "",
  );
  // `browser` 必须能被 hydration 接受(那次漏的正是它)—— 借契约 schema 验它确实在里面。
  const { RightPanelTabSchema } = await import("@contracts/ipc");
  check("契约 schema 里含 browser(派生白名单据此收下它)", RightPanelTabSchema.options.includes("browser"), [...RightPanelTabSchema.options]);
}

/* ─────── 7. webApi 的 localStorage 读取都要有 try 守卫 ─────── */

section("7. 手机壳的 localStorage 读取不许裸调");

{
  // `localStorage` 读时也会抛(`SecurityError`:存储被禁 / 嵌入式上下文)。`webApi` 里
  // `readAuth` / `readLocalSetting` / `themeSet` 都 guard 了,而 `themeGet` 那条**漏了**
  // —— 它在手机端 boot 的 hydrate 路上被调,抛出去会卡住整个手机壳。判据钉源码上:
  // 每一处 `localStorage.getItem(` 都得在它前面最近的 `try {` 之后。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(process.cwd(), "src/renderer/lib/webApi.ts"), "utf8");
  const unguarded: number[] = [];
  for (const m of src.matchAll(/localStorage\.getItem\(/g)) {
    const before = src.slice(0, m.index);
    // 从最近的函数体起点算:只要那一段里有 `try {` 就认它被守住了(webApi 里所有读取都在
    // 单个函数体内,不会跨函数)。
    const sinceFn = before.split(/\bfunction\s|\bconst\s+\w+\s*=\s*(?:async\s*)?\(/).pop() ?? before;
    if (!sinceFn.includes("try {") && !sinceFn.includes("try{")) {
      unguarded.push(src.slice(0, m.index).split("\n").length);
    }
  }
  check("★ webApi 里每处 localStorage.getItem 都有 try 守卫(存储被禁时不卡住手机壳)", unguarded.length === 0, unguarded);
}

/* ─────── 8. 统一标签栏:早退守卫必须与「四类标签来源」同一口径 ─────── */

section("8. 统一中栏标签条:早退守卫不许漏掉预览标签");

{
  // `UnifiedTabsBar` 一条栏里装**四类**标签来源:会话(`openTabs`)、文件(`openFiles`)、
  // 计划(`hasPlanTab`)、只读预览(`fileView`,来自 `fileViewStore`)。它**渲染**时把预览
  // 也算一份(`{fileView !== null && …}`),但**早退守卫**从前只数了前三类 —— 于是
  // 「只开着一个预览、其余都空」时整条栏 `return null` 收起:中间栏正显示着那个预览,
  // 顶上却一个标签都没有,用户以为"点了没反应"(同文件里预览标签那段注释写明了这个后果)。
  // 判据钉源码 —— 这条栏要 dnd-kit + zustand + ResizeObserver,跑不进无头。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/renderer/components/layout/UnifiedTabsBar.tsx"),
    "utf8",
  );
  // 先去注释,免得那句"守卫要含 fileView"的说明本身被当成证据(自证)。
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const guard = code
    .split("\n")
    .find((l) => l.includes("return null") && l.includes("tabs.length === 0"));
  check(
    "★ 早退守卫含预览标签来源(只开预览时不许把整条栏收起)",
    !!guard && guard.includes("fileView"),
    guard,
  );
  // 正控:渲染处确实按 `fileView !== null` 画那个预览标签 —— 守卫与渲染同一个口径。
  check(
    "渲染处也把预览当标签来源(fileView !== null)",
    code.includes("fileView !== null"),
    "",
  );
}

/* ─────── 9. 标题栏:活动会话那一行必须走共享 findSession(含流式兜底) ─────── */

section("9. 标题栏活动会话解析:不许漏掉流式行");

{
  // 「活动会话那一行在哪」这条规则在标签条与会话流侧栏里由**共享的** `findSession`
  // 解析 —— 它会兜到 `streamSessions`(会话流第 2 页以后的行只在那里,见它的注释)。
  // 而 `Titlebar` 的两处 chip(`ActiveThreadTitle` 标题 / `ActiveWorktreeChip` 工作树)
  // 从前**手抄**了一份只看 `s.sessions`(活动项目窗口,仅 SESSION_PAGE_SIZE 条)+
  // `pinnedSessions` 的版本:活动会话是流式行时,标题 chip 直接 `null` 消失 —— 而会话流
  // 侧栏点出来的正是这种行(`syncConfigFromSession` 的注释也记着"title chip vanished"
  // 这一类)。判据钉源码:标题栏里不许再有手抄的 `sessions.find(...activeSessionId)`,
  // 必须调共享的 `findSession`。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(process.cwd(), "src/renderer/components/layout/Titlebar.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    "★ 标题栏解析活动会话走共享 findSession(不手抄一份漏流的查找)",
    /findSession\(s\.sessionsByProject,\s*s\.pinnedSessions,\s*s\.streamSessions,\s*s\.activeSessionId\)/.test(code),
    "",
  );
  // 负控:手抄的那份特征 —— `s.sessions.find((x) => x.id === s.activeSessionId)` 不该再出现。
  check(
    "★ 标题栏不再手抄 `s.sessions.find(...activeSessionId)`",
    !/s\.sessions\.find\(\(x\) => x\.id === s\.activeSessionId\)/.test(code),
    "",
  );
}

console.log(`\nrenderer-lib-audit-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
