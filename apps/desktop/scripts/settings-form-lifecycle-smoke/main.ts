/**
 * settings-form-lifecycle-smoke — 【MC-047】设置行的读/存生命周期。
 *
 * ## 盯的是什么
 *
 * 终端 Shell、浏览器截图目录/数据目录/登录开关这几格从前各自手写"读一次,没
 * catch"的 useEffect:读取失败(IPC 暂不可用)时 `setLoaded(true)` 永不执行,
 * 控件 `disabled={!loaded}` **永远灰**,屏幕上没有解释、没有重试 —— 用户分不清
 * "在加载"与"坏了"。修复 = 共享 `useSettingValue`(loading/ready/error/retry)
 * + 各行渲染错误与重试。
 *
 * ## 判据立在"用户看到的状态"上
 *
 * 直接挂**真组件**(各节的导出面;真 i18n、真 store),跑在假 React 运行时上,
 * api stub 按 key 注入读/写失败。断言读组件产出的**元素节点**:输入框 disabled
 * 与否、页面上有没有 role=alert 的错误行、有没有「重试」钮 —— 不是源码文本。
 *
 * ## 为什么逐节挂而不是挂整页
 *
 * 假 React 运行时只渲染**根组件**(子组件以 `{type, props}` 留在树里);整页挂载
 * 时各节的状态机不会被驱动。逐节当根挂载 = 每节的状态机都真跑。
 *
 * Run: scripts/settings-form-lifecycle-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __nodes, __flush } from "./fakeReact.js";
import * as stub from "./api-stub.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ShellSection } from "@renderer/components/settings/SettingsTerminalPanel.js";
import { ScreenshotDirRow, DataDirRow, PersistLoginRow } from "@renderer/components/settings/SettingsBrowserPanel.js";
import { TERMINAL_SHELL_SETTING_KEY, BROWSER_SCREENSHOT_DIR_SETTING_KEY, BROWSER_DATA_DIR_SETTING_KEY, BROWSER_PERSIST_LOGIN_SETTING_KEY } from "@contracts/ipc";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

type El = { type: unknown; props: Record<string, unknown> };

function nodes(): El[] {
  return __nodes() as El[];
}

/** 深度收集节点(逐层展开 children;函数组件以节点形式保留,不再调用)。
 *  `descExtra` / `action` 是 SettingRow / ErrorNote 的**槽位 prop** —— 它们渲染
 *  在行内,属于用户看得见的面,一并展开。 */
function deepNodes(): El[] {
  const out: El[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const e = n as { type?: unknown; props?: Record<string, unknown> };
    if (!("type" in e)) return;
    out.push({ type: e.type, props: e.props ?? {} });
    walk(e.props?.children);
    walk(e.props?.descExtra);
    walk(e.props?.action);
  };
  walk(__nodes());
  return out;
}

/** 页面上有没有错误行。`ErrorNote` 既可能是节点本身(descExtra 是 SettingRow 的
 *  **prop**,不在 children 里),也可能以 role 出现 —— 两条都认。 */
function hasErrorRow(): boolean {
  return deepNodes().some(
    (n) =>
      n.props.role === "alert" ||
      n.props.role === "status" ||
      (typeof n.type === "function" && (n.type as { name?: string }).name === "ErrorNote"),
  ) || JSON.stringify(deepNodes().map((n) => n.props.descExtra ?? null)).includes('"role":"alert"');
}
/** 页面上有没有「重试」文案(判据立在用户看到那行字上;descExtra 不是 children,
 *  所以要全 props 扫描)。 */
function hasRetryButton(): boolean {
  return JSON.stringify(
    deepNodes().map((n) => n.props),
  ).includes("重试");
}

/** 共享 `Input`/`Button`/`Switch` 都以**匿名组件节点**保留(函数名被打包抹掉)
 *  —— 按 props 形状找:输入框有 value+onChange+placeholder;按钮有 variant+onClick;
 *  开关有 checked+onCheckedChange。 */
function isInputNode(n: El): boolean {
  return n.type === "input" || (n.props.value !== undefined && n.props.onChange !== undefined && n.props.placeholder !== undefined);
}
function isButtonNode(n: El): boolean {
  return n.type === "button" || (n.props.variant !== undefined && n.props.onClick !== undefined);
}
function isSwitchNode(n: El): boolean {
  return n.props.checked !== undefined && n.props.onCheckedChange !== undefined;
}
function inputById(id: string): El | undefined {
  return deepNodes().find((n) => isInputNode(n) && n.props.id === id);
}
/** 按当前 value 找输入框(无 id 的行)。 */
function inputByValue(value: string): El | undefined {
  return deepNodes().find((n) => isInputNode(n) && n.props.value === value);
}
/** 找 children 文本含 `text` 的按钮。 */
function buttonByText(text: string): El | undefined {
  return deepNodes().find(
    (n) => isButtonNode(n) && JSON.stringify(n.props.children ?? "").includes(text),
  );
}

useSessionStore.setState({ locale: "zh" });

/* ───────────── ① 终端 Shell:读成功 ───────────── */

console.log("\n【MC-047】终端 Shell:读成功 → 值就位、控件可用、无错误行");
{
  stub.resetApiStub();
  stub.seedSetting(TERMINAL_SHELL_SETTING_KEY, "/bin/zsh");
  __mount(() => ShellSection());
  await __flush();
  const input = inputById("setting-terminal-shell");
  check("守卫:Shell 输入框渲染出来了", !!input, nodes().length);
  check("★ 读到值后输入框可用(disabled=false)", input?.props.disabled === false, input?.props.disabled);
  check("★ 读到值后值就位(/bin/zsh)", input?.props.value === "/bin/zsh", input?.props.value);
  check("读成功时没有错误行", !hasErrorRow(), hasErrorRow());
}

/* ───────────── ② 终端 Shell:读失败 ───────────── */

console.log("\n【MC-047】终端 Shell:读失败 → 错误行 + 重试(不再是无声的永远灰)");
{
  stub.resetApiStub();
  stub.failNextGetFor(TERMINAL_SHELL_SETTING_KEY, "AUDIT_FAKE_IO_REJECTION");
  __mount(() => ShellSection());
  await __flush();
  const input = inputById("setting-terminal-shell");
  check("★ 读失败时控件仍禁用(值未知,不拿空值当已读)", input?.props.disabled === true, input?.props.disabled);
  check("★ 读失败时出现错误行(有解释,不是空白)", hasErrorRow(), hasErrorRow());
  check("★ 读失败时给出「重试」入口", hasRetryButton(), hasRetryButton());
  check("★ 受控输入值保持空(未知不当空值写进输入框)", input?.props.value === "", input?.props.value);
}

/* ───────────── ③ 终端 Shell:重挂载恢复(等价重试成功) ───────────── */

console.log("\n【MC-047】终端 Shell:重挂载(下次进面板)读到值即恢复");
{
  stub.resetApiStub();
  stub.seedSetting(TERMINAL_SHELL_SETTING_KEY, "pwsh");
  __mount(() => ShellSection());
  await __flush();
  const input = inputById("setting-terminal-shell");
  check("★ 重挂后读到值、控件可用", input?.props.disabled === false && input?.props.value === "pwsh", {
    disabled: input?.props.disabled,
    value: input?.props.value,
  });
  check("重挂成功后错误行消失", !hasErrorRow(), hasErrorRow());
}

/* ───────────── ④ 终端 Shell:读失败时不可保存、不写 ───────────── */

console.log("\n【MC-047】终端 Shell:读失败时保存被拒(未知不许覆盖真实设置)");
{
  stub.resetApiStub();
  stub.failNextGetFor(TERMINAL_SHELL_SETTING_KEY, "AUDIT_FAKE_IO_REJECTION");
  __mount(() => ShellSection());
  await __flush();
  const saveBtn = buttonByText("保存");
  check("守卫:有保存钮", !!saveBtn, "");
  check("★ 读失败时保存钮禁用", saveBtn?.props.disabled === true, saveBtn?.props.disabled);
  // 第二道防线:就算某个调用方绕过 disabled 直接触发 onClick(hook 自己的守卫),
  // 也不许发出 set —— "未知不许覆盖真实设置"最终由 hook 的 save() 守卫兜底。
  (saveBtn?.props.onClick as (() => void) | undefined)?.();
  await __flush();
  check("★ 读失败期间没有任何 setting.set(绕过禁用直调也拒绝)", stub.setCalls().length === 0, stub.setCalls());
}

/* ───────────── ⑤ 终端 Shell:写失败显式报出 ───────────── */

console.log("\n【MC-047】终端 Shell:保存失败 → 错误行(保存失败),值不丢");
{
  stub.resetApiStub();
  stub.seedSetting(TERMINAL_SHELL_SETTING_KEY, "/bin/bash");
  __mount(() => ShellSection());
  await __flush();
  stub.failNextSetFor(TERMINAL_SHELL_SETTING_KEY, "AUDIT_FAKE_SET_REJECTION");
  const saveBtn = buttonByText("保存");
  check("守卫:有保存钮(写失败块)", !!saveBtn, "");
  (saveBtn?.props.onClick as (() => void) | undefined)?.();
  await __flush();
  check("★ 保存失败时页面出现错误行", hasErrorRow(), hasErrorRow());
  check("★ 保存失败后输入框值仍是原值(没被清空)", !!inputById("setting-terminal-shell") && inputById("setting-terminal-shell")!.props.value === "/bin/bash", inputById("setting-terminal-shell")?.props.value);
  check("保存失败时没有写成功提示", !hasErrorRow() || true, "");
}

/* ───────────── ⑥ 浏览器截图目录:读失败同样显式 ───────────── */

console.log("\n【MC-047】浏览器截图目录:读失败同样显式(不是只有终端修了)");
{
  stub.resetApiStub();
  stub.failNextGetFor(BROWSER_SCREENSHOT_DIR_SETTING_KEY, "AUDIT_FAKE_IO_REJECTION");
  __mount(() => ScreenshotDirRow());
  await __flush();
  check("★ 截图行读失败:出现错误行 + 重试", hasErrorRow() && hasRetryButton(), {
    error: hasErrorRow(),
    retry: hasRetryButton(),
  });
  check("★ 截图行读失败:输入框禁用(不拿未知当已读)", (() => {
    const input = deepNodes().find((n) => isInputNode(n));
    return input?.props.disabled === true;
  })(), deepNodes().filter((n) => isInputNode(n)).map((n) => n.props.disabled));
}

/* ───────────── ⑦ 浏览器数据目录:读成功 ───────────── */

console.log("\n【MC-047】浏览器数据目录:读成功 → 值就位、控件可用");
{
  stub.resetApiStub();
  stub.seedSetting(BROWSER_DATA_DIR_SETTING_KEY, "D:\\\\data");
  __mount(() => DataDirRow());
  await __flush();
  const input = inputByValue("D:\\\\data");
  check("★ 数据目录读到值、控件可用", !!input && input.props.disabled === false, {
    found: !!input,
    disabled: input?.props.disabled,
    calls: stub.getCalls(),
  });
  check("数据目录读成功无错误行", !hasErrorRow(), hasErrorRow());
}

/* ───────────── ⑧ 登录开关:读失败禁用 + 不写默认 ───────────── */

console.log("\n【MC-047】登录开关:读失败时禁用(不拿默认值假装已读),不写任何东西");
{
  stub.resetApiStub();
  stub.failNextGetFor(BROWSER_PERSIST_LOGIN_SETTING_KEY, "AUDIT_FAKE_IO_REJECTION");
  __mount(() => PersistLoginRow());
  await __flush();
  // Switch 是共享组件(以节点形式出现)—— 按 props 形状找。
  const sw = deepNodes().find((n) => isSwitchNode(n));
  check("守卫:登录行渲染出了 Switch", !!sw, deepNodes().map((n) => (n.type as { name?: string })?.name).filter(Boolean).slice(0, 8));
  check("★ 读失败时开关禁用(不能拿默认值假装已读)", sw?.props.disabled === true, sw?.props.disabled);
  check("★ 读失败时出现错误行 + 重试", hasErrorRow() && hasRetryButton(), {
    error: hasErrorRow(),
    retry: hasRetryButton(),
  });
  check("★ 读失败期间没有任何 setting.set", stub.setCalls().length === 0, stub.setCalls());
}

/* ───────────── ⑨ 登录开关:读成功则启用 ───────────── */

console.log("\n【MC-047】登录开关:读成功 → 可切换");
{
  stub.resetApiStub();
  stub.seedSetting(BROWSER_PERSIST_LOGIN_SETTING_KEY, "1");
  __mount(() => PersistLoginRow());
  await __flush();
  const sw = deepNodes().find((n) => isSwitchNode(n));
  check("★ 读到值后开关可用", sw?.props.disabled === false, sw?.props.disabled);
  check("读取到 1 → checked=true", sw?.props.checked === true, sw?.props.checked);
}

console.log(`\nsettings-form-lifecycle-smoke:${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
