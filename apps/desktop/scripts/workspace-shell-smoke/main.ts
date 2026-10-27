/**
 * workspace-shell-smoke —— ARC-005 V1「双壳过渡」的地基回归网。
 *
 * 本切片只做两件事:把经典工作区外壳**逐字**抽成 `ClassicShell`,并铺好
 * `ui.shell` 偏好("classic" 默认 | "workspace")的完整流水线。本套钉住这两件:
 *
 *  A. **偏好真的落盘、真的水合** —— 不是像不像,而是同一个 store 走一遍:
 *     `setShellPref("workspace")` 必须把 `{key:"ui.shell", value:"workspace"}`
 *     交给 `setting.set`;下一次启动的 `init()` 从 `setting.getMany` 读到它时,
 *     store 必须落到 `shellPref:"workspace"`。坏值回落 "classic"(不炸)。
 *  B. **抽取是搬运,不是重写** —— App.tsx 里 `<ClassicShell` 恰好出现一次,
 *     且原来的工作区 JSX(`<WorkspaceInertShell>`/`data-testid="workspace-main"`)
 *     不再内联;ClassicShell.tsx 必须仍带全部承重标记(`workspace-main` /
 *     `<WorkspaceInertShell` / `<Titlebar mode="workspace"` / `<ThreePaneLayout` /
 *     `<BottomTerminalBar`),并且 `ClassicShell` 在 App 的挂载点上**不在任何
 *     条件分支里**(偏好怎么翻都不许卸载工作区子树 —— 不变量是 PTY/Monaco/
 *     草稿保活)。
 *
 * 正向对照(证明断言会红):A 里"读回 workspace"先对 `parseShellPref("workspace")`
 * 断言,再用 `parseShellPref("bogus")` 断言回落 —— 两者不可能同时为真,若解析器
 * 坏成"永远 classic"或"永远透传",必红。B 里"App 不再内联工作区 JSX"同样对
 * ClassicShell.tsx 做反查:同一段字符串在 ClassicShell 里必须**存在**。
 *
 * Run: scripts/workspace-shell-smoke/run.sh
 */
import "./prelude.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setApiStub, settingSetCalls, resetSettingSetCalls } from "./prelude.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  DEFAULT_SHELL_PREF,
  UI_SHELL_SETTING_KEY,
  parseShellPref,
} from "@renderer/components/shell/shellPrefs.js";
import { isDeviceLocalSettingKey, isSyncedSettingKey } from "@contracts/ipc/settingsSync";
import { ShellPreferenceSchema } from "@contracts/ipc";

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

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), "utf8");

/* ═══════════════════ A. 偏好:契约 + 落盘 + 水合 ═══════════════════ */

section("A1. 契约键与解析器");
{
  eq("设置键是 ui.shell", UI_SHELL_SETTING_KEY, "ui.shell");
  eq("新装机默认 Claude 风格 workspace", DEFAULT_SHELL_PREF, "workspace");
  check("schema 接受 classic", ShellPreferenceSchema.safeParse("classic").success);
  check("schema 接受 workspace", ShellPreferenceSchema.safeParse("workspace").success);
  check("schema 拒绝未知值", !ShellPreferenceSchema.safeParse("dual").success);
}

section("A2. 设备本地键(跟屏幕走,不跟账号同步)");
{
  check("★ ui.shell 在 DEVICE_LOCAL_SETTING_KEYS", isDeviceLocalSettingKey(UI_SHELL_SETTING_KEY));
  check("ui.shell 不在 SYNCED_SETTING_KEYS(不能被手机覆盖)", !isSyncedSettingKey(UI_SHELL_SETTING_KEY));
}

section("A3. 解析:合法值透传,坏值回落默认");
{
  eq("classic 透传", parseShellPref("classic"), "classic");
  eq("workspace 透传", parseShellPref("workspace"), "workspace");
  eq("null → 新装机默认 workspace", parseShellPref(null), "workspace");
  eq("空串 → 新装机默认 workspace", parseShellPref(""), "workspace");
  eq("未知值 → 防御回落 workspace", parseShellPref("workspace-ish"), "workspace");
  // 正向对照:同一函数的两种输出不可能被同一条"永远 X"的实现同时满足。
  check(
    "正向对照:透传与回落不能同时被常量实现满足",
    parseShellPref("classic") !== parseShellPref("bogus"),
  );
}

section("A4. store 默认值与 setShellPref 落盘(setting.set)");
{
  const store = useSessionStore.getState();
  eq("store 初始 shellPref = workspace", store.shellPref, "workspace");

  resetSettingSetCalls();
  await store.setShellPref("workspace");
  eq("乐观更新:store 立即变 workspace", useSessionStore.getState().shellPref, "workspace");
  const wrote = settingSetCalls.filter((c) => c.key === UI_SHELL_SETTING_KEY);
  eq("setting.set 收到恰好一次 ui.shell", wrote.length, 1);
  eq("写入的值是 workspace", wrote[0]?.value, "workspace");

  resetSettingSetCalls();
  await useSessionStore.getState().setShellPref("classic");
  eq("切回 classic 也落盘", settingSetCalls.filter((c) => c.key === UI_SHELL_SETTING_KEY)[0]?.value, "classic");
}

section("A5. 水合:下一次启动 init() 从设置表读回");
{
  // 重置 store 到出厂状态,然后让 init() 的 first-paint getMany 返回 workspace。
  // init() 是幂等的(_initStarted 守卫),所以为 smoke 复制一份新 store 状态:
  // _initStarted 回到 false、shellPref 回到默认。
  useSessionStore.setState({ _initStarted: false, shellPref: "classic" });

  const projectListRes = { projects: [] as unknown[] };
  const pinnedRes = { sessions: [] as unknown[] };
  setApiStub("setting.getMany", async () => ({ [UI_SHELL_SETTING_KEY]: "workspace" }));
  setApiStub("project.list", async () => projectListRes);
  setApiStub("session.listPinned", async () => pinnedRes);
  setApiStub("setting.get", async () => ({ value: null }));

  await useSessionStore.getState().init();
  eq("★ init() 把 ui.shell=workspace 水合进 store", useSessionStore.getState().shellPref, "workspace");

  // 再启动一次,这次设置表里是坏值 —— 必须退回 classic 而不是崩/透传。
  useSessionStore.setState({ _initStarted: false, shellPref: "classic" });
  setApiStub("setting.getMany", async () => ({ [UI_SHELL_SETTING_KEY]: "not-a-shell" }));
  await useSessionStore.getState().init();
  eq("坏值行不炸,回落 workspace", useSessionStore.getState().shellPref, "workspace");

  // 缺行:同默认。
  useSessionStore.setState({ _initStarted: false, shellPref: DEFAULT_SHELL_PREF });
  setApiStub("setting.getMany", async () => ({}));
  await useSessionStore.getState().init();
  eq("缺行保持默认 workspace", useSessionStore.getState().shellPref, "workspace");

  // 已经明确保存 classic 的老用户：即使新装机默认 workspace 也不能被升级覆盖。
  useSessionStore.setState({ _initStarted: false, shellPref: DEFAULT_SHELL_PREF });
  setApiStub("setting.getMany", async () => ({ [UI_SHELL_SETTING_KEY]: "classic" }));
  await useSessionStore.getState().init();
  eq("★ 旧版用户明确保存 classic：水合后依然 classic", useSessionStore.getState().shellPref, "classic");

  setApiStub("setting.getMany", null);
  setApiStub("project.list", null);
  setApiStub("session.listPinned", null);
  setApiStub("setting.get", null);
}

/* ═══════════════════ B. 抽取:App ⇄ ClassicShell ═══════════════════ */

section("B1. App.tsx:恰好挂一个壳,工作区 JSX 不再内联");
{
  const app = read("src/renderer/App.tsx");
  /* 【UI 重建 2026-10-27】App 现在挂的是 `ClaudeShellMount`（Claude 外观的
   * 装配层），不再是 `ClassicShell`。本节守的东西**一个字都没变**：
   *
   *   「App 里恰好挂**一个**壳组件，工作区 JSX 不内联在 App 里。」
   *
   * 所以断言从「认死 ClassicShell 这个名字」改成「认这两个壳中的一个，且恰好一个」。
   * 认死名字会让换壳这件事本身变成红 —— 而换壳正是这个仓库现在要做的事。
   *
   * ⚠️ **ClassicShell.tsx 仍然存在且必须保持完整**（下面那段反查照旧）：
   * 它是回退路径与承重标记的定义处，不是死代码。 */
  const mounts = [...app.matchAll(/<(ClassicShell|ClaudeShellMount)[\s>]/g)].map((m) => m[1]);
  eq("★ App.tsx 恰好挂一个壳组件", mounts.length, 1);
  check(
    "App.tsx 导入了那个壳",
    mounts[0] === "ClaudeShellMount"
      ? app.includes('from "./components/shell/ClaudeShellMount.js"')
      : app.includes('from "./components/shell/ClassicShell.js"'),
    mounts,
  );
  check(
    "★ App.tsx 不再内联 <WorkspaceInertShell>",
    !app.includes("<WorkspaceInertShell"),
    app.includes("<WorkspaceInertShell") ? "still inline" : undefined,
  );
  check(
    "★ App.tsx 不再内联 data-testid=\"workspace-main\"",
    !app.includes('data-testid="workspace-main"'),
  );
  check(
    "★ App.tsx 不再出现 <Titlebar mode=\"workspace\"(设置覆盖层用的是 settings 模式)",
    !/<Titlebar\s+mode="workspace"/.test(app),
  );
  check("App.tsx 不再内联 <ThreePaneLayout", !app.includes("<ThreePaneLayout"));
  check("App.tsx 不再定义 WorkspaceSidebar", !app.includes("function WorkspaceSidebar"));

  // 正向对照:同一段承重字符串在 ClassicShell.tsx 里必须存在 —— 否则这条
  // "App 里没有"可能只是因为搬运时把它弄丢了。
  const shell = read("src/renderer/components/shell/ClassicShell.tsx");
  check(
    "正向对照:workspace-main 移到了 ClassicShell(不是丢了)",
    shell.includes('data-testid="workspace-main"') && !app.includes('data-testid="workspace-main"'),
  );
}

section("B2. ClassicShell.tsx:承重标记必须全部在场");
{
  const shell = read("src/renderer/components/shell/ClassicShell.tsx");
  for (const marker of [
    'data-testid="workspace-main"',
    "<WorkspaceInertShell",
    '<Titlebar\n          mode="workspace"',
    "<ThreePaneLayout",
    "<BottomTerminalBar",
  ]) {
    check(`★ 含 ${JSON.stringify(marker)}`, shell.includes(marker));
  }
  check("导出 ClassicShell 组件", /export function ClassicShell\b/.test(shell));
  check("导出 ClassicShellProps 契约", /export interface ClassicShellProps\b/.test(shell));
}

section("B3. 挂载点不在条件分支里(切壳/切偏好都不卸载子树)");
{
  const app = read("src/renderer/App.tsx");
  /* 【UI 重建 2026-10-27】**本节的意图没变，被测结构变了。**
   *
   * 原来：App 里用 `variant={shellVariantOf(shellPref)}` 让 ClassicShell 换外观，
   * 判据要证明「不许用元素级三元换组件类型」（那会卸载整棵工作区 → PTY/Monaco 丢）。
   *
   * 现在：只有 `ClaudeShellMount` 一个壳，`shellPref` 不再决定组件类型 ——
   * **那个风险在这种结构下根本不存在**。但同一类风险还留着另一条路：
   * 「App 在某个条件分支里挂壳」（比如 `{ready && <ClaudeShellMount…>}`），
   * 一样会卸载子树。所以判据改为直接守那一条。
   *
   * 仍然保留的：
   *   - 壳与 `SettingsOverlay` **并列**挂载（覆盖层不是三元替换）；
   *   - App 里没有任何「按偏好三元切壳元素」的写法。 */
  const at = app.search(/<(ClassicShell|ClaudeShellMount)[\s>]/);
  if (at < 0) throw new Error("App.tsx 不再挂载任何壳组件");

  check(
    "★ 壳与 SettingsOverlay 并列挂载(覆盖层不是三元替换)",
    /<(ClassicShell|ClaudeShellMount)[\s\S]{0,1600}<SettingsOverlay/.test(app),
  );

  // ① 壳元素**不在任何 `?` / `&&` 三元里**：取它所在的那一行与上一行，
  //    出现 `cond ? <Shell` 或 `cond && <Shell` 即为卸载风险。
  const lines = app.split(String.fromCharCode(10));
  const shellLineIdx = lines.findIndex((l) => /<(ClassicShell|ClaudeShellMount)[\s>]/.test(l));
  const shellLine = shellLineIdx >= 0 ? lines[shellLineIdx]! : "";
  const prevLine = shellLineIdx > 0 ? lines[shellLineIdx - 1]! : "";
  check(
    "★ 壳元素不在条件分支里（三元 / && 短路都会卸载子树）",
    !/[?&]{1}\s*$/.test(prevLine.trimEnd()) && !/\?\s*$/.test(prevLine.trimEnd()) && !/\?[^?]*$/.test(shellLine),
    { prevLine: prevLine.trim().slice(-60), shellLine: shellLine.trim().slice(0, 60) },
  );

  // ② App 里没有「按偏好三元切壳」的写法。
  const ternaryShellLines = lines.filter((line) =>
    line.includes("shellPref") &&
    line.includes("?") &&
    (/<(ClassicShell|ClaudeShellMount|WorkspaceShell)/.test(line) || /<(ClassicShell|ClaudeShellMount)/.test(lines[lines.indexOf(line) + 1] ?? "")),
  );
  eq("★ App 里没有壳偏好的元素级三元(三元会卸载工作区子树)", ternaryShellLines.length, 0);

  /* ClassicShell 仍是回退路径的定义处，它的 variant 契约必须完好
   *（删它 = 回退能力没了，而且下面 B2 的承重标记也会跟着丢）。 */
  const shellSrc = read("src/renderer/components/shell/ClassicShell.tsx");
  check("ClassicShellProps 有 variant", /variant\?:\s*ShellVariant/.test(shellSrc));
  check("默认 variant 是 classic(不传 = 原样)", /variant = "classic"/.test(shellSrc));
  // workspace 变体的两处 class 差异必须在位且**只**在 class 上。
  check("★ workspace 变体加侧栏最小宽度", /min-w-\[240px\]/.test(shellSrc));
  check("★ workspace 变体用 CDS 10px 圆角", /rounded-tl-\[10px\]/.test(shellSrc));
  check("★ 只有 workspace 关闭可见分隔线，classic 保留画线且拖拽仍共用", /hideLine=\{isWorkspace\}/.test(shellSrc));
  const wsSrc = read("src/renderer/components/shell/WorkspaceShell.tsx");
  check("WorkspaceShell 只是 ClassicShell 的 variant 包装", /variant="workspace"/.test(wsSrc));
  check("shellVariantOf 只认 workspace", /pref === "workspace" \? "workspace" : "classic"/.test(wsSrc));
}

section("C. 主列几何按 shell variant 一致切换（Claude 风格不是只改左栏）");
{
  const shell = read("src/renderer/components/shell/ClassicShell.tsx");
  const pane = read("src/renderer/components/layout/ThreePaneLayout.tsx");
  check("★ ClassicShell 把 variant 交给主列布局", /<ThreePaneLayout\s+variant=\{variant\}/.test(shell));
  check("★ 布局明确定义 variant，设置/老布局不传时仍保持 classic",
    /variant\?: ShellVariant/.test(pane) && /variant = "classic"/.test(pane));
  check("★ workspace 主列仍使用 10px 圆角，右停靠为左缘、左停靠为右缘",
    /variant === "workspace"/.test(pane) &&
    /visibleDock === "left" \? "rounded-tr-\[10px\] rounded-br-\[10px\]" : "rounded-tl-\[10px\] rounded-bl-\[10px\]"/.test(pane) &&
    /visibleRightPaneGeometry\(rightSurface, rightOpen, rightDock, rightPlacement\?\.side === "bottom"\)/.test(pane));
  check("★ classic 主列仍保留历史 24px 左上/左下圆角，不破坏原工作区",
    /rounded-tl-3xl rounded-bl-3xl/.test(pane));
  check("★ 主列为同一 main 元素 class 切换，禁止双树互换造成 PTY/草稿被销毁",
    /<main\b[^>]*className=\{cn\(/.test(pane) && !/variant\s*===\s*"workspace"\s*\?\s*<main/.test(pane));
}

section("D. 复用本机 Claude Desktop v2 逆向：密度 token 仅作用于 workspace，保留经典和真实业务");
{
  const shell = read("src/renderer/components/shell/ClassicShell.tsx");
  const css = read("src/renderer/styles.css");
  const actions = read("src/renderer/components/layout/SidebarQuickActions.tsx");
  const stream = read("src/renderer/components/layout/StreamSidebar.tsx");
  const tree = read("src/renderer/components/layout/LeftBarParts.tsx");
  check("★ 同一挂载工作区拥有 shell variant 数据作用域（不覆盖其他页面）",
    /<WorkspaceInertShell\s+variant=\{variant\}/.test(shell) &&
    /data-ui-shell-variant=\{variant\}/.test(shell));
  /* 【UI 重建 2026-10-27】composer 圆角不再按壳变体分两档。
   *
   * 旧：`[data-ui-shell-variant="workspace"]` 下 14px，classic 保留 v1 的 20px。
   * 现在：两处都 `var(--m-radius-composer)` —— 生成本机 Claude 产物的
   * `--cds-radius-composer`（`.875rem × 16/17 ≈ 13.18px`）。**20px 从来就不是
   * Claude 的值**，它只是 Mcode 自己的旧配方；用户要外观一致，所以统一。
   *
   * 断言因此守「两处都走同一个 token」而不是「分档正确」——
   * 分档这件事本身已经不存在了，再钉它就是钉一个已废的设计。 */
  check("★ Composer 圆角两处都走 --m-radius-composer（Claude 真值，不分壳变体）",
    (css.match(/--composer-radius:\s*var\(--m-radius-composer\)/g) ?? []).length >= 2 &&
    !/--composer-radius:\s*20px/.test(css) &&
    !/--composer-radius:\s*14px/.test(css));
  check("★ 侧栏快捷入口有独立可测试的元素钩子，动作仍共用 store",
    actions.includes('data-sidebar-quick-actions') &&
    actions.includes('data-sidebar-quick-action="new"') &&
    actions.includes('data-sidebar-quick-action="search"') &&
    actions.includes('void startSession()') && actions.includes('setCommandPaletteOpen(true)'));
  check("★ 紧凑会话卡仍保留状态、分支、操作与键盘可达性",
    stream.includes('data-stream-session-row') &&
    stream.includes('statusLabel') &&
    stream.includes('worktreeBranch ||') &&
    stream.includes('tabIndex={0}') &&
    stream.includes('onContextMenu='));
  check("★ workspace 的快捷入口/会话卡 CSS 全部有作用域，不污染 classic",
    /\[data-ui-shell-variant="workspace"\]\s+\[data-sidebar-quick-action="new"\]/.test(css) &&
    /\[data-ui-shell-variant="workspace"\]\s+\[data-stream-session-row\]/.test(css));
  check("★ workspace 树侧栏会话行也同步 v2 密度，不只 stream 模式有效",
    tree.includes('data-tree-session-row') &&
    /\[data-ui-shell-variant="workspace"\]\s+\[data-tree-session-row\]/.test(css));
  check("★ 会话树仍保留原生键盘选择、未读、运行图标、工作树与主进程事件",
    tree.includes('tabIndex={0}') && tree.includes('showUnreadBadge') &&
    tree.includes('isRunning') && tree.includes('session.worktreePath') && tree.includes('onSelect();'));
}

section("E. Claude Desktop Header / 弹出菜单几何对齐");
{
  const titlebar = read("src/renderer/components/layout/Titlebar.tsx");
  check("★ 顶栏沿用 Claude 45px 高度与 16px 水平留白",
    titlebar.includes("h-[45px]") &&
    titlebar.includes("bg-inherit px-4"));
  check("★ 顶栏右侧操作采用上游 8px 控件间距",
    titlebar.includes('data-arc005-titlebar-actions="" className="flex shrink-0 items-center gap-2"'));
  check("★ 布局菜单使用 12px 浮层圆角、8px 行圆角与紧凑内边距",
    titlebar.includes('rounded-xl border border-edge bg-surface p-1.5 shadow-[var(--shadow-popover)]') &&
    titlebar.includes('min-h-8 w-full cursor-default items-center rounded-lg px-2.5 py-1.5 text-left text-xs'));
}

console.log(`\nworkspace-shell-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
