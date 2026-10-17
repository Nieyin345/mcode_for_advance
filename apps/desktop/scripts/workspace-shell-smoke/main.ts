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
  eq("默认外壳是 classic", DEFAULT_SHELL_PREF, "classic");
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
  eq("null → 默认", parseShellPref(null), "classic");
  eq("空串 → 默认", parseShellPref(""), "classic");
  eq("未知值 → 默认", parseShellPref("workspace-ish"), "classic");
  // 正向对照:同一函数的两种输出不可能被同一条"永远 X"的实现同时满足。
  check(
    "正向对照:透传与回落不能同时被常量实现满足",
    parseShellPref("workspace") !== parseShellPref("bogus"),
  );
}

section("A4. store 默认值与 setShellPref 落盘(setting.set)");
{
  const store = useSessionStore.getState();
  eq("store 初始 shellPref = classic", store.shellPref, "classic");

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
  eq("坏值行不炸,回落 classic", useSessionStore.getState().shellPref, "classic");

  // 缺行:同默认。
  useSessionStore.setState({ _initStarted: false, shellPref: "classic" });
  setApiStub("setting.getMany", async () => ({}));
  await useSessionStore.getState().init();
  eq("缺行保持默认 classic", useSessionStore.getState().shellPref, "classic");

  setApiStub("setting.getMany", null);
  setApiStub("project.list", null);
  setApiStub("session.listPinned", null);
  setApiStub("setting.get", null);
}

/* ═══════════════════ B. 抽取:App ⇄ ClassicShell ═══════════════════ */

section("B1. App.tsx:ClassicShell 恰好一次,工作区 JSX 不再内联");
{
  const app = read("src/renderer/App.tsx");
  const appClassic = app.match(/<ClassicShell[\s>]/g) ?? [];
  eq("★ App.tsx 渲染 <ClassicShell 恰好一次", appClassic.length, 1);
  check("App.tsx 导入了 ClassicShell", app.includes('from "./components/shell/ClassicShell.js"'));
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

section("B3. 挂载点不在条件分支里(壳偏好怎么翻都不卸载子树)");
{
  const app = read("src/renderer/App.tsx");
  const at = app.search(/<ClassicShell[\s>]/);
  if (at < 0) throw new Error("App.tsx no longer renders ClassicShell");
  const before = app.slice(0, at);
  // 1) `<WidePlanDialog />` 与 `<ClassicShell` 之间只许是空行与 JSX 注释
  //    (跨行 /* … */ 的内容行也算注释)。
  const between = before.slice(before.lastIndexOf("<WidePlanDialog />") + "<WidePlanDialog />".length);
  const betweenCode = between
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX block comments (multi-line)
    .trim();
  eq("★ <ClassicShell 前最近代码行是兄弟挂载 <WidePlanDialog />(隔着仅注释)", betweenCode, "");
  check(
    "★ 前一个真实元素确实是 <WidePlanDialog />",
    before.trimEnd().endsWith("*/}"),
    before.trimEnd().slice(-40),
  );
  check(
    "★ ClassicShell 与 SettingsOverlay 并列挂载(覆盖层不是三元替换)",
    /<ClassicShell[\s\S]{0,1600}<SettingsOverlay/.test(app),
  );
  // 【ARC-005 V2】壳偏好只许经 `variant` prop 进入,**不许**在 App 里换组件类型。
  // 判据两条:
  //   ① `variant={shellVariantOf(shellPref)}` 真的挂在 ClassicShell 上;
  //   ② App 里不存在 `x === "workspace" ? <SomeShell` 这类元素级三元 ——
  //      那会让 React 卸载整棵工作区子树(PTY cleanup → api.terminal.kill)。
  check(
    "★ App 把 shellPref 经 variant prop 传入(不换组件类型)",
    /<ClassicShell[\s\S]{0,200}variant=\{shellVariantOf\(shellPref\)\}/.test(app),
  );
  // 逐行扫:不许同一行里既有 shellPref 的三元又有壳元素(三元换类型 = 卸载子树)。
  const ternaryShellLines = app.split(String.fromCharCode(10)).filter((line) =>
    line.includes("shellPref") && line.includes("?") && (line.includes("<ClassicShell") || line.includes("<WorkspaceShell")));
  eq("★ App 里没有壳偏好的元素级三元(三元会卸载工作区子树)", ternaryShellLines.length, 0);
  const shellSrc = read("src/renderer/components/shell/ClassicShell.tsx");
  check("ClassicShellProps 有 variant", /variant\?:\s*ShellVariant/.test(shellSrc));
  check("默认 variant 是 classic(不传 = 原样)", /variant = "classic"/.test(shellSrc));
  // workspace 变体的两处 class 差异必须在位且**只**在 class 上。
  check("★ workspace 变体加侧栏最小宽度", /min-w-\[240px\]/.test(shellSrc));
  check("★ workspace 变体用 CDS 10px 圆角", /rounded-tl-\[10px\]/.test(shellSrc));
  const wsSrc = read("src/renderer/components/shell/WorkspaceShell.tsx");
  check("WorkspaceShell 只是 ClassicShell 的 variant 包装", /variant="workspace"/.test(wsSrc));
  check("shellVariantOf 只认 workspace", /pref === "workspace" \? "workspace" : "classic"/.test(wsSrc));
}

console.log(`\nworkspace-shell-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
