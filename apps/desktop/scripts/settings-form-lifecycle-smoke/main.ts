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
import { translate } from "@renderer/lib/i18n/core.js";

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

/** 【T67】页面上有没有**保存成功**的提示段落。
 *
 *  对应 `SettingsTerminalPanel.tsx` 的 `{shell.saved && <p>{t("settings.terminal.shellSaved")}</p>}`。
 *  与 `hasRetryButton()` 同路：扫 `deepNodes()` 的 props，不依赖节点身份。
 *
 *  ⚠️ 文案**从词典取**，不硬编码中文：套件里 `useI18n()` 读
 *  `useSessionStore(s => s.locale)`，locale 未设置时 `translate` 回落 `zh`。
 *  硬编码会在改文案时**静默失配** —— 断言绿着，而它验的那句话已经不存在了。
 */
function hasSuccessNote(): boolean {
  return JSON.stringify(deepNodes().map((n) => n.props)).includes(
    translate("zh", "settings.terminal.shellSaved"),
  );
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
  // 【T67】这条之前是 `!hasErrorRow() || true` —— 三重错：恒真；判据查的是**错误行**
  // 而断言名说的是**成功提示**；且同一块上一条刚要求错误行必须存在（自相矛盾）。
  check("保存失败时没有写成功提示", !hasSuccessNote(), { successNote: hasSuccessNote() });
}

/* ── 【T67】终端 Shell:保存**成功** → 成功提示出现、错误行消失 ──────────────
 *
 * 为什么必须有这一块（而不只在上面那条里验「失败时没有成功提示」）：
 * 只有失败态断言的话，一个**恒假**的 `hasSuccessNote()` 也能让它绿 ——
 * 那正是「断言绿着但没验任何东西」的形态。成功态有一条常驻断言，
 * 两条合起来才证明这个判据**分得清**成功与失败。
 */
console.log("\n【MC-047】终端 Shell:保存成功 → 成功提示出现、错误行消失");
{
  stub.resetApiStub();
  stub.seedSetting(TERMINAL_SHELL_SETTING_KEY, "/bin/bash");
  __mount(() => ShellSection());
  await __flush();
  check("守卫:成功块里也有保存钮", !!buttonByText("保存"), "");
  check("保存前没有成功提示", !hasSuccessNote(), { successNote: hasSuccessNote() });
  const saveBtnOk = buttonByText("保存");
  (saveBtnOk?.props.onClick as (() => void) | undefined)?.();
  await __flush();
  check("★ 保存成功后页面出现成功提示", hasSuccessNote(), { successNote: hasSuccessNote() });
  check("★ 保存成功后没有错误行", !hasErrorRow(), hasErrorRow());
  check("保存成功时确实发出了 setting.set", stub.setCalls().length === 1, stub.setCalls());
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

/* ───────────── ⑥b 终端 Shell:点「重试」真的重发并恢复 ─────────────
 * 【MC-047 复核】此前这一套只验了「重试入口存在」,没点过它 —— 真 Electron U1 里
 * 点了。这里补同一条判据的无头版:计数 +1、错误行消失、控件恢复且值就位。 */
console.log("\n【MC-047】终端 Shell:点「重试」真的重发 setting.get 并恢复(不是摆设)");
{
  stub.resetApiStub();
  stub.seedSetting(TERMINAL_SHELL_SETTING_KEY, "/opt/fish");
  stub.failNextGetFor(TERMINAL_SHELL_SETTING_KEY, "AUDIT_FAKE_IO_REJECTION");
  __mount(() => ShellSection());
  await __flush();
  const getsBefore = stub.getCalls().filter((k) => k === TERMINAL_SHELL_SETTING_KEY).length;
  const retry = buttonByText("重试");
  check("守卫:读失败时有「重试」按钮可点", !!retry);
  (retry?.props.onClick as (() => void) | undefined)?.();
  await __flush();
  const getsAfter = stub.getCalls().filter((k) => k === TERMINAL_SHELL_SETTING_KEY).length;
  check("★ 点「重试」重发了 setting.get:terminal.shell(计数 +1)", getsAfter === getsBefore + 1, { getsBefore, getsAfter });
  check("★ 重试成功后错误行消失", !hasErrorRow(), hasErrorRow());
  const input = inputById("setting-terminal-shell");
  check("★ 重试成功后控件恢复可用且值就位", input?.props.disabled === false && input?.props.value === "/opt/fish", {
    disabled: input?.props.disabled,
    value: input?.props.value,
  });
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

/* ───────────── ⑩ 登录开关:保管库状态读失败显式 + 重试重发 ───────────── */

console.log("\n【M25】登录开关:凭据保管库状态读失败 → 错误行 + 重试,开关照常可用");
{
  stub.resetApiStub();
  stub.seedSetting(BROWSER_PERSIST_LOGIN_SETTING_KEY, "1");
  stub.failNextVaultStatus("AUDIT_FAKE_VAULT_REJECTION");
  __mount(() => PersistLoginRow());
  await __flush();
  check("★ 保管库状态读失败时出现错误行(不再静默)", hasErrorRow(), hasErrorRow());
  check("★ 保管库状态读失败时给出「重试」入口", hasRetryButton(), hasRetryButton());
  const sw = deepNodes().find((n) => isSwitchNode(n));
  check("★ 保管库状态读失败不阻塞开关(设置本身已读成功即可用)", sw?.props.disabled === false, sw?.props.disabled);
  // 点「重试」真的重发 browser.vaultStatus:计数 +1、错误行消失。
  const before = stub.vaultStatusCalls();
  const retry = buttonByText("重试");
  (retry?.props.onClick as (() => void) | undefined)?.();
  await __flush();
  check("★ 点「重试」确实重发了 browser.vaultStatus",
    stub.vaultStatusCalls() === before + 1, { before, after: stub.vaultStatusCalls() });
  check("★ 重试成功后保管库错误行消失", !hasErrorRow(), hasErrorRow());
}

/* ───────────── ⑪ 登录开关:保存被拒/恢复失败的**原因**在界面上可见 ───────────── */

console.log("\n【MC-023】登录开关:保管库保存被拒 / 恢复失败的原因要在设置页看得到");
{
  // 保存侧原因(加密抛错/旧明文擦除失败):主进程 vaultStatus().lastError。
  stub.resetApiStub();
  stub.seedSetting(BROWSER_PERSIST_LOGIN_SETTING_KEY, "1");
  stub.seedVaultStatus({ encryptionAvailable: true, lastError: "SYNTHETIC_SAVE_REASON_7" });
  __mount(() => PersistLoginRow());
  await __flush();
  const serialized = JSON.stringify(deepNodes().map((n) => n.props));
  check("★ 保存被拒的具体原因出现在界面上(不是只进日志)", serialized.includes("SYNTHETIC_SAVE_REASON_7"), {});
  check("★ 保存被拒有错误行(带标题,不是裸字符串)", hasErrorRow(), hasErrorRow());
}
{
  // 恢复侧原因(密文解不开/内容坏/全部注入被拒):主进程 vaultStatus().restoreError。
  stub.resetApiStub();
  stub.seedSetting(BROWSER_PERSIST_LOGIN_SETTING_KEY, "1");
  stub.seedVaultStatus({ restoreError: "SYNTHETIC_RESTORE_REASON_9" });
  __mount(() => PersistLoginRow());
  await __flush();
  const serialized = JSON.stringify(deepNodes().map((n) => n.props));
  check("★ 恢复失败的具体原因出现在界面上(从前解不开=没 Cookie)", serialized.includes("SYNTHETIC_RESTORE_REASON_9"), {});
  check("★ 恢复失败有错误行(用户知道为什么要重新登录)", hasErrorRow(), hasErrorRow());
}
{
  // 健康路径(防空过):无 lastError / restoreError → 一条保管库错误行都不该出现。
  stub.resetApiStub();
  stub.seedSetting(BROWSER_PERSIST_LOGIN_SETTING_KEY, "1");
  __mount(() => PersistLoginRow());
  await __flush();
  check("★ 健康路径:没有保管库错误行(防「永远在报」)", !hasErrorRow(), hasErrorRow());
}

/* ═════════ 【MC-026 复核】三个常用面板的「读失败 / 重试真重发 / 保存失败保留输入」 ═════════
 *
 * 上面各节挂的是 SettingRow 级的叶子;这一节按协调要求走**模型配置 / 引擎工具 /
 * 自动化**三个真实面板组件(它们自带多层组合:列表、表单、错误条、重试按钮)。
 *
 * 手法与上面相同:真组件 + 假 React 运行时 + 按 RPC 注入失败。`__mount` 只渲染**根**
 * 组件,子组件以 {type, props} 留在树里 —— 对这三个面板恰好够用,因为"读失败的状态
 * 与错误条"都长在根组件上,而「重试」按钮的 onClick 也挂在根组件的树里:
 *   - 模型配置: `listErrors` 状态 + 顶部 ErrorNote(根组件持有);
 *   - 引擎工具: `useRpc().error` + 根组件渲染的 ErrorNote;
 *   - 自动化:   WorkflowLibraryView 的 `listError` + 左栏重试。
 * 每个面板三条:错误可见 / 点重试真的重发(计数 +1)且成功后错误消失 / 保存失败时
 * 用户输入仍在(自动化那条:新建时 workbook.save 失败,错误可见)。
 */

import { CustomModelsPanel } from "@renderer/components/settings/CustomModelsPanel.js";
import { EngineToolsPanel } from "@renderer/components/settings/EngineToolsPanel.js";
import { WorkflowLibraryView } from "@renderer/components/settings/workflows/WorkflowLibraryView.js";

/** run.sh 生成的真实节点类型目录(内置清单;数据根/插件目录已换桩)。 */
const SMOKE_CATALOG = JSON.parse(process.env.MCODE_SMOKE_NODE_CATALOG ?? "null") as import("@contracts/nodeType").NodeTypeCatalog | null;
if (SMOKE_CATALOG === null) throw new Error("MCODE_SMOKE_NODE_CATALOG 未设置 —— 请用 run.sh 跑(它会生成真实节点类型目录)");

/** 收集一段子树里的全部元素节点(含 children / action / descExtra)。 */
function nodesOfTree(rootNodes: El[]): El[] {
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
  walk(rootNodes);
  return out;
}

/** 页面上所有可见文本(拼成一串),用于"错误原因/空态文案"这一类判据。 */
function textOf(nodes: El[]): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || n === false || n === true) return;
    if (typeof n === "string" || typeof n === "number") return void parts.push(String(n));
    if (Array.isArray(n)) return void n.forEach(walk);
    if (typeof n === "object") walk((n as { props?: { children?: unknown } }).props?.children);
  };
  for (const n of nodes) walk(n.props.children);
  return parts.join(" ");
}

/** 找 props 里带 `onClick` 且 children 文本含 label 的按钮节点。 */
function findButton(nodes: El[], label: string): El | undefined {
  return nodes.find((n) => {
    if (typeof n.props.onClick !== "function") return false;
    const kids = JSON.stringify(n.props.children ?? "");
    return kids.includes(label);
  });
}

/** 节点数组里有没有一个"看起来像 ErrorNote"的(role alert/status 或函数组件名)。 */
function hasErrorNote(nodes: El[]): boolean {
  return nodes.some(
    (n) => n.props.role === "alert" || n.props.role === "status" || (typeof n.type === "function" && (n.type as { name?: string }).name === "ErrorNote"),
  );
}

/* ───────── ⑫ 模型配置:provider 清单读失败 → 红条 + 重试,重试真重发、成功后消失 ───────── */
console.log("\n【MC-026 复核】模型配置:provider 清单读失败不再画成「还没有供应商配置」");
{
  stub.resetApiStub();
  stub.failNextPanel("customModel.list", "AUDIT_FAKE_MODELS_LIST_REJECTION");
  __mount(() => CustomModelsPanel());
  await __flush();
  const panelNodes = nodesOfTree(nodes());
  const text = textOf(panelNodes);
  check("★ 模型配置:claude 清单读失败出现可读错误条", hasErrorNote(panelNodes), text.slice(0, 200));
  check(
    "★ 模型配置:错误条里点名失败原因(注入原因原样可见,或标题为「供应商清单读取失败」)",
    text.includes("AUDIT_FAKE_MODELS_LIST_REJECTION") || text.includes("供应商清单读取失败"),
    text.slice(0, 300),
  );
  check("★ 模型配置:读失败时不冒充「还没有供应商配置」", !text.includes("还没有供应商配置"), text.slice(0, 300));
  const retry = findButton(panelNodes, "重试");
  check("守卫:模型配置的错误条带「重试」按钮", !!retry, panelNodes.filter((n) => typeof n.props.onClick === "function").map((n) => n.props.children));
  const before = stub.panelCalls("customModel.list");
  (retry?.props.onClick as (() => void) | undefined)?.();
  await __flush();
  check("★ 模型配置:点「重试」真的重发了 customModel.list(计数 +1)", stub.panelCalls("customModel.list") === before + 1, {
    before,
    after: stub.panelCalls("customModel.list"),
  });
  check("★ 模型配置:重试成功后错误条消失", !hasErrorNote(nodesOfTree(nodes())), textOf(nodesOfTree(nodes())).slice(0, 200));
  // 健康路径(防空过):无注入时没有任何错误条。
  stub.resetApiStub();
  __mount(() => CustomModelsPanel());
  await __flush();
  check("★ 模型配置健康路径:无错误条(防「永远在报」)", !hasErrorNote(nodesOfTree(nodes())));
}

/* ───────── ⑬ 引擎工具:engineTools.get 读失败 → 错误 + 重试真重发 ───────── */
console.log("\n【MC-026 复核】引擎工具:engineTools.get 读失败有可读错误与重试入口");
{
  stub.resetApiStub();
  stub.failNextPanel("engineTools.get", "AUDIT_FAKE_ENGINE_TOOLS_REJECTION");
  __mount(() => EngineToolsPanel());
  await __flush();
  const panelNodes = nodesOfTree(nodes());
  const text = textOf(panelNodes);
  check("★ 引擎工具:读失败出现错误条(带原因)", hasErrorNote(panelNodes) && text.includes("AUDIT_FAKE_ENGINE_TOOLS_REJECTION"), text.slice(0, 300));
  const retry = findButton(panelNodes, "重试");
  check("★ 引擎工具:错误条带「重试」入口(从前只有一行字)", !!retry);
  const before = stub.panelCalls("engineTools.get");
  (retry?.props.onClick as (() => void) | undefined)?.();
  await __flush();
  check("★ 引擎工具:点「重试」真的重发了 engineTools.get(计数 +1)", stub.panelCalls("engineTools.get") === before + 1, {
    before,
    after: stub.panelCalls("engineTools.get"),
  });
  check("★ 引擎工具:重试成功后错误条消失", !hasErrorNote(nodesOfTree(nodes())), textOf(nodesOfTree(nodes())).slice(0, 300));
  // 健康路径:无注入时正常列出引擎卡片(不误报)。
  stub.resetApiStub();
  __mount(() => EngineToolsPanel());
  await __flush();
  const healthyNodes = nodesOfTree(nodes());
  const engineCards = healthyNodes.filter((n) => typeof n.props.engine === "string" && n.props.state !== undefined);
  check(
    "★ 引擎工具健康路径:无错误条且三个引擎卡片真的渲染出来",
    !hasErrorNote(healthyNodes) && new Set(engineCards.map((n) => n.props.engine)).size === 3,
    { error: hasErrorNote(healthyNodes), engines: [...new Set(engineCards.map((n) => n.props.engine))] },
  );
}

/* ───────── ⑭ 自动化:工作流库读失败 → 红字 + 重试,重试真重发;保存失败保留输入 ───────── */
console.log("\n【MC-026 复核】自动化:库列表读失败可重试;保存失败时用户输入不被回弹");
{
  stub.resetApiStub();
  stub.failNextPanel("workflow.list", "AUDIT_FAKE_WORKFLOW_LIST_REJECTION");
  __mount(() =>
    WorkflowLibraryView({
      purpose: "automation",
      catalog: SMOKE_CATALOG,
      catalogError: null,
      onRetryCatalog: () => {},
      profiles: [],
      profileError: null,
      onSaveProfile: async () => true,
      onRemoveProfile: async () => {},
      onOpenNativeEditor: () => {},
    }),
  );
  await __flush();
  const panelNodes = nodesOfTree(nodes());
  const text = textOf(panelNodes);
  check("★ 自动化:库列表读失败出现可读错误(不是空白/加载中)", text.includes("工作流库读不出来") && text.includes("AUDIT_FAKE_WORKFLOW_LIST_REJECTION"), text.slice(0, 300));
  const retry = findButton(panelNodes, "重试");
  check("★ 自动化:错误旁有「重试」入口(从前只有一行红字)", !!retry);
  const before = stub.panelCalls("workflow.list");
  (retry?.props.onClick as (() => void) | undefined)?.();
  await __flush(80);
  check("★ 自动化:点「重试」真的重发了 workflow.list(计数 +1)", stub.panelCalls("workflow.list") === before + 1, {
    before,
    after: stub.panelCalls("workflow.list"),
  });
  check("★ 自动化:重试成功后错误消失", !textOf(nodesOfTree(nodes())).includes("工作流库读不出来"), textOf(nodesOfTree(nodes())).slice(0, 300));
}

/* ───────── ⑮ 自动化:列表健康但 doc 读失败 →「打不开」可见;保存失败错误可见且不崩 ───────── */
console.log("\n【MC-026 复核】自动化:打开文档失败要说出来(不是空白画布)");
{
  stub.resetApiStub();
  stub.failNextPanel("workflow.get", "AUDIT_FAKE_WORKFLOW_GET_REJECTION");
  __mount(() =>
    WorkflowLibraryView({
      purpose: "automation",
      catalog: SMOKE_CATALOG,
      catalogError: null,
      onRetryCatalog: () => {},
      profiles: [],
      profileError: null,
      onSaveProfile: async () => true,
      onRemoveProfile: async () => {},
      onOpenNativeEditor: () => {},
      focusWorkflowId: "auto-1",
    }),
  );
  await __flush(80);
  const text = textOf(nodesOfTree(nodes()));
  check("★ 自动化:doc 读取失败时点名「这个工作流打不开」并带原因", text.includes("这个工作流打不开") && text.includes("AUDIT_FAKE_WORKFLOW_GET_REJECTION"), text.slice(0, 400));
  // 健康路径:不注入时 focusWorkflowId 能真的打开文档(列表 → doc 读成功)。
  stub.resetApiStub();
  __mount(() =>
    WorkflowLibraryView({
      purpose: "automation",
      catalog: SMOKE_CATALOG,
      catalogError: null,
      onRetryCatalog: () => {},
      profiles: [],
      profileError: null,
      onSaveProfile: async () => true,
      onRemoveProfile: async () => {},
      onOpenNativeEditor: () => {},
      focusWorkflowId: "auto-1",
    }),
  );
  await __flush(80);
  const healthy = textOf(nodesOfTree(nodes()));
  check("★ 自动化健康路径:文档打开、无「打不开」错误", !healthy.includes("这个工作流打不开") && healthy.includes("每日整理"), healthy.slice(0, 300));
}

/* ───────── ⑯ 自动化:保存失败 → 错误可见、用户输入不被回弹清空 ───────── */
console.log("\n【MC-026 复核】自动化:保存失败时错误可见、编辑器里用户输入保持");
{
  stub.resetApiStub();
  // 打开一条已存在的自动化。假运行时只执行**根组件** —— 检查器(NodeInspector)以
  // 元素形式留在树里,它的 `doc` / `onUpdateWorkflow` props 就是用户键入所走的那条
  // 回调(输入框 onChange → onUpdateWorkflow → edit())。从这里驱动与真实键入同源。
  __mount(() =>
    WorkflowLibraryView({
      purpose: "automation",
      catalog: SMOKE_CATALOG,
      catalogError: null,
      onRetryCatalog: () => {},
      profiles: [],
      profileError: null,
      onSaveProfile: async () => true,
      onRemoveProfile: async () => {},
      onOpenNativeEditor: () => {},
      focusWorkflowId: "auto-1",
    }),
  );
  await __flush(80);
  type InspectorDoc = { id?: string; name?: string };
  const inspector = (): El | undefined =>
    nodesOfTree(nodes()).find((n) => {
      const doc = n.props.doc as InspectorDoc | undefined;
      return typeof n.props.onUpdateWorkflow === "function" && doc?.id === "auto-1";
    });
  const workingName = (): string | undefined => (inspector()?.props.doc as InspectorDoc | undefined)?.name;
  check("守卫:自动化打开后检查器渲染出来了(带 doc)", !!inspector(), nodesOfTree(nodes()).filter((n) => typeof n.props.onUpdateWorkflow === "function").length);
  (inspector()?.props.onUpdateWorkflow as ((patch: Record<string, unknown>) => void) | undefined)?.({ name: "用户改过的名字" });
  await __flush();
  check(
    "守卫:改名后工作副本里是用户输入",
    workingName() === "用户改过的名字",
    workingName(),
  );
  // 保存失败注入:点根树里的「保存」。
  stub.failNextPanel("workflow.save", "AUDIT_FAKE_WORKFLOW_SAVE_REJECTION");
  const saveBtn = findButton(nodesOfTree(nodes()), "保存");
  check("守卫:有保存按钮", !!saveBtn, nodesOfTree(nodes()).filter((n) => typeof n.props.onClick === "function").map((n) => n.props.children));
  (saveBtn?.props.onClick as (() => void) | undefined)?.();
  await __flush(80);
  type SaveStateShape = { kind?: string; message?: string };
  const saveLine = nodesOfTree(nodes()).find((n) => {
    const st = n.props.state as SaveStateShape | undefined;
    return typeof st === "object" && st !== null && st.kind === "error";
  });
  const saveState = saveLine?.props.state as SaveStateShape | undefined;
  check(
    "★ 自动化:保存失败后保存状态行是 error 且带注入原因(用户看得见)",
    saveState?.kind === "error" && String(saveState?.message ?? "").includes("AUDIT_FAKE_WORKFLOW_SAVE_REJECTION"),
    saveState,
  );
  check(
    "★ 自动化:保存失败后用户输入仍在(工作副本仍是用户改过的名字,没被回弹成已保存值)",
    workingName() === "用户改过的名字",
    { working: workingName(), saved: (inspector()?.props.savedDoc as InspectorDoc | undefined)?.name },
  );
}

console.log(`\nsettings-form-lifecycle-smoke:${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
