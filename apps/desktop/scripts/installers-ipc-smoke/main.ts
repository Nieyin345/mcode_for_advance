/**
 * Headless smoke for **「装/卸运行时和文档工具链」这条 IPC 路** ——
 * `main/ipc/runtimes.ts`(59 行)与 `main/ipc/toolchain.ts`(42 行)。
 *
 * 两个文件都是**零覆盖**,而它们守的东西不轻:一个能删掉用户花几百 MB 下下来的
 * 内核,另一个是「设置 → 内核」面板每次打开都要走的那条路。
 *
 * ## 这一套的判据立在**用户看到的那行字**上,不是立在机制上
 *
 * 本仓库有一类真 bug 就叫「不合理、不专业」:机制对、通知里那句话被别的东西挡在
 * 门外,可以静默错一整天。这里两处都吃过:
 *
 *  1. **`runtimes.remove` 的守卫说的是英文 jargon。**
 *     `remove()` 在有会话跑着时必须被拒 —— 那是文件头明写的意图,专门钉一条。
 *     但原来那句话是 `2 session(s) still have a running turn — stop them before
 *     removing a runtime`:全仓库的用户可见字符串要么走 i18n、要么是中文
 *     (同族的 `plugins.remove` 就是「请先停止再卸载插件」),只有这一句是英文
 *     缩写 + 术语。它直接进 `settings.runtimes.removeFailed` 的 `{error}` 槽位
 *     显示给用户。**已修**,断言钉的是修好之后的形状(含数字 + 「会话」+ 「先停」)。
 *
 *  2. **`toolchain.check` 曾经 parse 了一个空 schema。**
 *     不带参数 invoke 时 handler 收到的 `raw` 就是 `undefined`,而
 *     `z.object({}).parse(undefined)` 直接 `invalid_type` —— 面板一打开就报错。
 *     文件头记着这条教训,所以这里**专门调一次不带参数的 `check`**,并把
 *     `ToolchainCheckSchema.parse(raw)` 当变异点(撤掉修复必须红)。
 *
 * ## 还顺手查了这个形状的漏网之鱼(结论:没有)
 *
 * 「契约签名无参 → 渲染端空括号调 → handler 里 `parse(raw)`」这个形状,按构造扫了
 * 一遍 `main/ipc/` 全部 38 个文件 × `rpcMap` 的 48 条无参签名 × 渲染端/preload 的
 * 空括号调用(一次性审计脚本,已随 `.scholar_tmp/` 移出源码树):**0 条命中**。
 * 这一族的其余成员(`context.get` / `context.memoriesList` / `mcp.list` /
 * `skills.bundles` / `file.pickImages` / `browser.historyClear` / `library.typesGet`
 * 及 `*GroupsGet` / `*SuppressGet`)要么契约签名本来就是有入参、调用端也确实传了
 * `{}`,要么 handler 里写的是 `parse(raw ?? {})`(library 那一族的写法)。
 * 另有 4 条**定义了却没人引用**的空 schema(`RgInstallSchema` /
 * `GetNotificationPrefsSchema` / `RuntimesListSchema` / `VoiceModelListSchema`)——
 * 无害,但改那条路的人会以为校验是它在做;报告里说了,没动。
 *
 * ## 安装器全部换桩 —— 不许真下载、不许真装
 *
 *   - **runtimes**:`installRuntime` / `installRuntimeFromLocalPath` **一次都不调**
 *     (会真的去 registry 拿几百 MB 的 tarball,离线机器上还直接挂)。只调
 *     `removeRuntime` 那条路(纯 `rmSync`),而且它的访问器进不了:
 *     见下面「安全前提」。
 *   - **toolInstall**:`@main/env/toolInstall.js` 整个换成桩(`stubs/toolInstall.ts`)。
 *     理由不只是"快":真装 pandoc 要走 GitHub 下载、真装 python-deps 会**往用户自己的
 *     解释器里 pip install**,两者都是这台机器上不该发生的事。而且这个文件**此刻
 *     有别的代理在改** —— 换桩让本套只钉 `ipc/toolchain.ts` 自己的职责(校验入参、
 *     转发、把运行态贴到每一项上),不被邻居的改动带红。
 *   - **`checkToolchain` 不换桩**:它是纯探测(`where.exe` + `python -c`,只读),
 *     而且「不带参数也不许抛」这条判据要的就是真那条路。
 *   - **`runtimes.list` 真调**(§8):只读快照。唯一外发是"最新版本"那个有超时的
 *     查询,离线时会话照常返回。
 *
 * ## 安全前提(run.sh 里那两个 `mktemp -d` 是这套能跑的前提,不是洁癖)
 *
 *   - **runtimes 根**:真模块 `removeRuntime` 会 `rmSync(<root>/<agent>)`
 *     (`recursive`)—— 指到真目录就是删掉用户的内核。真模块在无头脚本下 root
 *     本来是 null,那时 `runtimeInstaller` 会落到 `app.getPath("userData")`。
 *     所以下面**先 `setManagedRuntimeRoot(RUNTIMES)` 并断言设上了**,设不上立刻
 *     `process.exit(1)` 再往下走。
 *   - **工具根**:`removeTool`(本次换成了桩)同理会 `rmSync(<root>/<tool>)`。
 *     同一条纪律:`setToolRoot(TOOLS_ROOT)` + 断言 + 设不上就退。
 *   - **数据根**:桩 `stubs/dataRoot.ts` 没设 `MCODE_SMOKE_DATA_ROOT` 就**抛** ——
 *     绝不回落到真库(sql.js 的 persist 是重写整个 `mcode.db`)。
 *
 * Run: scripts/installers-ipc-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组/集合比较。`Object.is` 对两个内容相同的数组是 false,断「正好是这几个」
 *  时用 `eq` 会红得莫名其妙。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ══════════════════════════════════════════════════════════════════════════
 *  0. 安全前提:三根都指到临时目录,**并先断言设上了再往下走**
 * ══════════════════════════════════════════════════════════════════════════ */

const DATA = mkdtempSync(join(tmpdir(), "mcode-installers-data-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { setManagedRuntimeRoot, getManagedRuntimeRoot } = await import(
  "@main/runtimes/managedRuntimeRoots.js"
);
const { setToolRoot, getToolRoot } = await import("@main/env/managedToolRoots.js");

/** run.sh 用 `mktemp -d` 建的那个盘;本套所有"安装物"都摆/落在它里面。 */
const RUNTIMES = process.env.MCODE_SMOKE_RUNTIME_ROOT ?? "";
check("★ runtimes 根由 run.sh 给了(没给就没法保证不写进用户目录)", RUNTIMES.length > 0, RUNTIMES);
if (!RUNTIMES) process.exit(1);
setManagedRuntimeRoot(RUNTIMES);
check(
  "★ runtimes 根已注册(否则 removeRuntime 会删用户真实 userData 里的内核)",
  getManagedRuntimeRoot() === RUNTIMES,
  getManagedRuntimeRoot(),
);
if (getManagedRuntimeRoot() !== RUNTIMES) process.exit(1);

const TOOLS_ROOT = process.env.MCODE_SMOKE_TOOL_ROOT ?? "";
check("★ 工具根由 run.sh 给了", TOOLS_ROOT.length > 0, TOOLS_ROOT);
if (!TOOLS_ROOT) process.exit(1);
setToolRoot(TOOLS_ROOT);
check(
  "★ 工具根已注册(否则 removeTool 会删用户真实 tools 目录)",
  getToolRoot() === TOOLS_ROOT,
  getToolRoot(),
);
if (getToolRoot() !== TOOLS_ROOT) process.exit(1);

/* ══════════════════════════════════════════════════════════════════════════
 *  1. fakeIpc:注册**真 handler**,按 channel 取回来调
 * ══════════════════════════════════════════════════════════════════════════ */

// 存的是**宽签名**(`...a: unknown[]`),不是 `(event, raw)`。后者过不了 `fn(null, ...passed)`
// —— TS 要求展开一个 `unknown[]` 时目标得是 rest 参数。handler 的实参个数由被测代码
// 自己决定,这里只是个传声筒。
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC, TOOLCHAIN_TOOL_IDS } = await import("@contracts/ipc");
const { registerRuntimesHandlers } = await import("@main/ipc/runtimes.js");
const { registerToolchainHandlers } = await import("@main/ipc/toolchain.js");
registerRuntimesHandlers(fakeIpc);
registerToolchainHandlers(fakeIpc);

/** 调一个通道。**不传第二个参数 = 不带参数 invoke**(raw 是 undefined),
 *  这正是 preload 里 `ipcRenderer.invoke(IPC.TOOLCHAIN_CHECK)` 的形状。 */
function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有注册 ${channel}`);
  // ⚠️ `...(cond ? args : [undefined])` 过不了类型 —— 三元里的 `args` 是
  // `unknown[]`、`[undefined]` 是元组,展开一个联合类型时 TS 要求两边都是元组。
  // 写成一句直白的:没有实参就显式传一个 undefined。
  const passed: unknown[] = args.length > 0 ? args : [undefined];
  return Promise.resolve(fn(null, ...passed));
}

/** 同 `call`,但把"handler 直接抛了"这件事**收成数据**再断。
 *
 *  ⚠️ 这不是防御性写法,是这条判据的核心:handler 里那圈 `try/catch` **是承重的**。
 *  去掉它,zod 的错会以 rejected promise 的形式逃出 IPC —— 而渲染端那条路
 *  (`RuntimesPanel.doRemove` / `doInstall`)只有 `try { … } finally { setBusy(false) }`,
 *  **一个 `catch` 都没有**。于是用户看到的是:按钮闪了一下、**什么错误都没有**。
 *  ToolchainSection 那边有 `catch`,但它 `setActionError(err.message)` —— 一屏 zod JSON。
 *
 *  所以入参不合法时正确的形状是"**resolve 一个 `{ok:false, error:人话}`**",而不是抛。 */
async function callSafe(
  channel: string,
  ...args: unknown[]
): Promise<{ rejected: string | null; value: unknown }> {
  try {
    return { rejected: null, value: await call(channel, ...args) };
  } catch (err) {
    return { rejected: err instanceof Error ? err.message : String(err), value: undefined };
  }
}

for (const ch of [
  IPC.RUNTIMES_LIST,
  IPC.RUNTIMES_INSTALL,
  IPC.RUNTIMES_INSTALL_LOCAL,
  IPC.RUNTIMES_REMOVE,
  IPC.TOOLCHAIN_CHECK,
  IPC.TOOLCHAIN_INSTALL,
  IPC.TOOLCHAIN_REMOVE,
]) {
  check(`通道注册上了:${ch}`, handlers.has(ch));
}

const { setRunningSessionIds, runningQueries } = await import("./stubs/runtimeManager.js");
const { setInstalling, setLastError, installs, removes } = await import("./stubs/toolInstall.js");
const { events, phasesFor, reset: resetEvents } = await import("./stubs/window.js");

/* ══════════════════════════════════════════════════════════════════════════
 *  2. RUNTIMES_REMOVE:有会话在跑 → 必须被拒,而且那句话要说人话
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n2. 有会话在跑时卸运行时");

const AGENT = "claude";
const agentDir = join(RUNTIMES, AGENT);
const versionDir = join(agentDir, "9.9.9");

/** 摆一份"看起来装过"的现场(直接写盘,不经过 installer)。 */
function seedClaude(): void {
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, "claude.exe"), "MZ fake\n");
  writeFileSync(join(versionDir, "package.json"), JSON.stringify({ version: "9.9.9" }));
}

seedClaude();
check("前提:那份安装物先真的在盘上", existsSync(versionDir));

setRunningSessionIds(["s1", "s2"]);
resetEvents();
runningQueries.length = 0;

const refused = (await call(IPC.RUNTIMES_REMOVE, { agent: AGENT })) as {
  ok?: boolean;
  error?: string;
};
const refusedText = refused.error ?? "";

eq("★ 有 2 个会话在跑 → ok:false", refused.ok, false);
check("★ 而且 disk 上那份内核**一个字节都没动**(守卫真的拦住了)", existsSync(versionDir), {
  versionDir,
});
check("★ 守卫真的去问了 RuntimeManager(不是凭空拒绝)", runningQueries.length > 0, runningQueries);
eq(
  "★ 守卫是**提前返回**的:被拒时下面一步(装/卸器)一个事件都没往外推",
  events.length,
  0,
);
check(
  "★ 错误里说清了**有几个**会话(用户据此知道去停什么)",
  refusedText.includes("2"),
  refusedText,
);
check("★ 错误里说的是「会话」,不是 session(s) 这种缩写", refusedText.includes("会话"), refusedText);
check("★ 错误里说清了要先停掉它们", /先.{0,4}停/.test(refusedText), refusedText);
// 这条是「不合理、不专业」那一类:英文 jargon 直接进 {error} 槽位显示给用户。
check(
  "★ 这句话里没有英文 jargon(session(s) / running turn / stop them)",
  !/session\(s\)|running turn|stop them|removing a runtime/i.test(refusedText),
  refusedText,
);
eq("被拒时没有任何东西被删(根里那份还在)", readdirSync(agentDir).join(","), "9.9.9");

/* ══════════════════════════════════════════════════════════════════════════
 *  3. RUNTIMES_REMOVE:没有会话在跑 → 要真的调到底
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n3. 没有会话在跑时卸运行时");

setRunningSessionIds([]);
resetEvents();

const removed = (await call(IPC.RUNTIMES_REMOVE, { agent: AGENT })) as { ok?: boolean; error?: string };
eq("★ 一个会话都没在跑 → ok:true", removed.ok, true);
check("★ 真的调到底了:那份安装物从盘上没了", !existsSync(agentDir), { agentDir });
check("★ 调到底了才报错为空", !removed.error, removed.error);
// ⚠️ 这里**故意不断言** "删完会推一条终态事件"。实测它不推 —— 见文件尾注 4:成功那条路
// 上一句 `emitProgress(..., "done", 1)` 也没有,`removeRuntime` 从头到尾不碰
// `sendToRenderer`。但那是**别的文件**里的行为(本次只准改这两个),而且**用户看不见**:
// `RuntimesPanel` 收到任何非 downloading/extracting 的相位都只是清进度 + 重列,而成功
// 那条路的重列由 `doRemove` 里 `await onReload()` 自己发起 —— 收敛路径不依赖事件。
// 所以这里钉**能看见的那一条**:RPC 的返回值就是这次操作的全部回执。

// 幂等:本来就没了,再删一次照样成功(而不是报错)。
const again = (await call(IPC.RUNTIMES_REMOVE, { agent: AGENT })) as { ok?: boolean };
eq("已经没装过时再删一次 → 仍然 ok:true(幂等)", again.ok, true);

// 三个 agent 都能走通;守卫是"看有几个会话",不是只认某一个 agent。
for (const agent of ["codex", "pi"] as const) {
  const r = (await call(IPC.RUNTIMES_REMOVE, { agent })) as { ok?: boolean };
  eq(`★ ${agent} 那条路也真的调到底了`, r.ok, true);
}

/* ══════════════════════════════════════════════════════════════════════════
 *  4. 入参不合法时报出来的那句话**是人话**(不是 zod 的 JSON 数组文本)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n4. 入参不合法时那句话是不是人话");

const bodyOf = (r: unknown): string => (r as { error?: string }).error ?? "";

/** 一条 RPC 的形状判据,统一走它 —— 三条都要成立:
 *    ① handler 自己**不 reject**(否则渲染端那个光秃秃的 try/finally 会把它吃掉,
 *       用户看到的是"什么都没发生");
 *    ② 说回来一句话;
 *    ③ 那句话是**人话**(不是 zod 的 JSON 数组文本)。
 *  单写一条会漏掉另两条 —— 实测:只断 ②③ 时,把 try/catch 撤掉、错误以 rejected
 *  promise 逃出去,照样全绿(那时 ②③ 根本没机会被求值)。 */
function checkInputError(label: string, r: { rejected: string | null; value: unknown }): void {
  check(`★ ${label}:handler 没有 reject(渲染端那条路没有 catch)`, r.rejected === null, {
    rejected: r.rejected,
  });
  const text = bodyOf(r.value);
  check(`${label}:说回来了一句话`, text.length > 0, { value: r.value });
  check(`★ ${label}:那句话是「入参不合法」这种人事话`, text.includes("入参不合法"), text);
  check(
    `★ ${label}:没有把 zod 的 JSON 形状漏出去(不含 [ / "code" / invalid_*)`,
    !/\[|"code"|invalid_(type|union|enum|literal|value)/.test(text),
    text,
  );
}

checkInputError(
  "给个不存在的 agent",
  await callSafe(IPC.RUNTIMES_REMOVE, { agent: "根本不是个 agent" }),
);
checkInputError("给个不是对象的东西", await callSafe(IPC.RUNTIMES_INSTALL, "这不是个对象"));
checkInputError(
  "installLocal 少给 localPath",
  await callSafe(IPC.RUNTIMES_INSTALL_LOCAL, { agent: AGENT }),
);

/* ══════════════════════════════════════════════════════════════════════════
 *  5. TOOLCHAIN_CHECK:**不带参数** invoke 不许抛
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n5. 不带参数打开面板(曾经一打开就报 invalid_type)");

// 这一条是本套存在的第二个理由:preload 里就是 `ipcRenderer.invoke(IPC.TOOLCHAIN_CHECK)`
// —— 一个参数都不给,handler 收到的 raw 是 `undefined`。
// `z.object({}).parse(undefined)` 直接 invalid_type,整个面板当场报错。
let raw: unknown = null;
let threw: string | null = null;
try {
  raw = await call(IPC.TOOLCHAIN_CHECK);
} catch (err) {
  threw = err instanceof Error ? err.message : String(err);
}
eq("★ 不带参数 invoke 不抛", threw, null);
const checkResult = raw as { tools?: Array<Record<string, unknown>> };
check("★ 交回来的是一份工具清单(不是 undefined)", Array.isArray(checkResult?.tools), raw);

const toolIds = (checkResult?.tools ?? []).map((t) => String(t.id)).sort();
same(
  "★ 清单正好是契约里那六个工具",
  toolIds,
  [...TOOLCHAIN_TOOL_IDS].sort(),
);
check("★ 每一项都带 components(面板靠它显示「缺什么」)", (checkResult?.tools ?? []).every(
  (t) => Array.isArray(t.components) && (t.components as unknown[]).length > 0,
), checkResult?.tools);

// 带 `{}` 也要能过 —— 面板之外的调用方(以及手机端那条 HTTP 桥)会传空对象。
let withEmptyObj: unknown = null;
try {
  withEmptyObj = await call(IPC.TOOLCHAIN_CHECK, {});
} catch (err) {
  threw = err instanceof Error ? err.message : String(err);
}
eq("传一个空对象 invoke 也不抛", threw, null);
check("带 {} 时结果形状一致", Array.isArray((withEmptyObj as { tools?: unknown })?.tools), withEmptyObj);

/* ══════════════════════════════════════════════════════════════════════════
 *  6. TOOLCHAIN_CHECK:运行态(正在装 / 上次报错)**贴到每一项上**了没有
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n6. 运行态有没有贴到每一项上");

const { isToolInstalling, lastToolError } = await import("@main/env/toolInstall.js");

// 先把现场摆成:latex 正在装、pandoc 上次装失败了。
setInstalling("latex", true);
setLastError("pandoc", "下载卡住(30 秒没有新数据)");

const stamped = (await call(IPC.TOOLCHAIN_CHECK)) as {
  tools: Array<{ id: string; installing?: unknown; lastError?: unknown }>;
};
const byId = new Map(stamped.tools.map((t) => [t.id, t]));

eq("★ 「正在装」贴到了 latex 上", byId.get("latex")?.installing, true);
eq("★ latex 是唯一一个在装的", stamped.tools.filter((t) => t.installing === true).length, 1);
eq("★ 「上次报错」贴到了 pandoc 上", byId.get("pandoc")?.lastError, "下载卡住(30 秒没有新数据)");
eq(
  "★ 别的工具没被这句话沾上(是按 id 贴的,不是整表一个值)",
  byId.get("zip-tools")?.lastError,
  "",
);
eq(
  "★ 每一项的 installing 都跟着 isToolInstalling 走(不是写死的 false)",
  stamped.tools.every((t) => t.installing === isToolInstalling(t.id as never)),
  true,
);
eq("没在装的那一项 installing 是 false", byId.get("pandoc")?.installing, false);
eq(
  "★ lastError 与 lastToolError 同源",
  stamped.tools.every((t) => t.lastError === lastToolError(t.id as never)),
  true,
);
check(
  "每一项都带这两个字段(缺了就是面板不知道状态)",
  stamped.tools.every((t) => typeof t.installing === "boolean" && typeof t.lastError === "string"),
  stamped.tools.map((t) => ({ id: t.id, installing: t.installing, lastError: t.lastError })),
);

// 复位,别把现场留给后面的断言。
setInstalling("latex", false);
setLastError("pandoc", "");

/* ══════════════════════════════════════════════════════════════════════════
 *  7. toolchain 的装/卸:校验入参 → 转发 → 原样交回
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n7. toolchain 的装/卸");

installs.length = 0;
const okInstall = (await call(IPC.TOOLCHAIN_INSTALL, { tool: "pandoc" })) as { ok?: boolean };
eq("装一个合法工具 → 原样交回桩的 ok:true", okInstall.ok, true);
same("★ 转发过去的正是校验后的那个工具名", installs, ["pandoc"]);

removes.length = 0;
const okRemove = (await call(IPC.TOOLCHAIN_REMOVE, { tool: "latex" })) as { ok?: boolean };
eq("卸一个合法工具 → 原样交回桩的 ok:true", okRemove.ok, true);
same("★ 卸载也转发对了", removes, ["latex"]);

// 枚举之外的工具名:契约那层就挡住了(`ToolchainToolSchema` 是 enum)。
checkInputError("枚举之外的工具名", await callSafe(IPC.TOOLCHAIN_INSTALL, { tool: "vim" }));
eq("★ 被挡下来的那次没有转发到桩(不该装的东西一个都没装)", installs.length, 1);

checkInputError("少给 tool 字段", await callSafe(IPC.TOOLCHAIN_REMOVE, {}));
eq("★ 同样没有转发到桩", removes.length, 1);

/* ══════════════════════════════════════════════════════════════════════════
 *  8. runtimes 的装:校验过了就转发(真下载那条路绝不在这里走)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n8. runtimes.list:面板首屏那张表");

// ⚠️ `RUNTIMES_INSTALL` / `RUNTIMES_INSTALL_LOCAL` **一次都不真调** ——
// `installRuntime` 会去 registry 拿几百 MB 的 tarball(见 run.sh 文件头)。校验那
// 条路 §4 已经验过了。下面只走 `list`,它是只读快照(唯一的网络动作是最新版本查询,
// 有超时兜底;离线时会话照常返回)。
setRunningSessionIds([]);
const listed = (await call(IPC.RUNTIMES_LIST)) as { runtimes?: Array<Record<string, unknown>> };
check("list 交回一张表", Array.isArray(listed?.runtimes), listed);
same(
  "★ 表里正好是三个 agent(claude / codex / pi)",
  (listed?.runtimes ?? []).map((r) => String(r.agent)).sort(),
  ["claude", "codex", "pi"],
);
check(
  "每一项都带面板要的字段(版本 / 来源 / 磁盘占用 / 错误尾巴)",
  (listed?.runtimes ?? []).every(
    (r) =>
      "expectedVersion" in r &&
      "installedVersion" in r &&
      "source" in r &&
      "diskBytes" in r &&
      "lastError" in r &&
      "installing" in r,
  ),
  listed?.runtimes,
);
// §3 已经把 claude 删干净了,所以这里应当是"没装"。
const claudeAfter = (listed?.runtimes ?? []).find((r) => r.agent === "claude");
eq("★ 删过的那一项在表里回到 installed:false", claudeAfter?.installed, false);
eq("★ 而且 lastError 是空串(是「没装」,不是「装坏了」)", claudeAfter?.lastError, "");

/* ── 尾声 ── */

rmSync(DATA, { recursive: true, force: true });
rmSync(RUNTIMES, { recursive: true, force: true });
rmSync(TOOLS_ROOT, { recursive: true, force: true });

console.log(`\ninstallers-ipc-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);

/* ─────────────────────────────────────────────────────────────────────────
 * 这次**查到但没改**的(都不是这两个文件的职责,列在这里免得下一个人重查):
 *
 * 1. 4 条**定义了却没人引用**的空 schema:`RgInstallSchema`(files.ts)、
 *    `GetNotificationPrefsSchema`(notifications.ts)、`RuntimesListSchema`
 *    (runtimes.ts —— 就是「list 不 parse」那条注释说的那个,留着当"输入类型"用)、
 *    `VoiceModelListSchema`(voice.ts)。无害,但改那条路的人会以为校验是它在做。
 * 2. `voice.getModelDir` 的契约签名**带一个入参**,渲染端却没有调用方
 *    (`GetVoiceModelDirSchema` 同样是空 schema)。要么签名该改成无参,要么那条
 *    RPC 还没接。两种都不像 bug,不动。
 * 3. `describeInputError` 的 `first?.message` 对 enum/union 那条路会漏出 zod 自带的
 *    英文("Invalid input" / "Invalid enum value…")。要翻成中文得自己按 `issue.code`
 *    映射一张表 —— 那是 `ipc/terminal.ts` 的收口,`main/ipc/` 下十几个文件都该共用
 *    它,但**不该由这两个文件单独开头**(一处改、十几处不一致比现在还糟)。
 * 4. **`runtimes.remove` 成功时不推 `runtimes:event`。** 实测两处都不推:
 *    `ipc/runtimes.ts` 从来不碰这条通道,`runtimeInstaller.removeRuntime` 也不碰
 *    (它只是 `rmSync` + 清缓存 + 打日志)。§3 因此故意不断言它。看着像"进度条会
 *    一直挂着",实际不会:`RuntimesPanel` 的清进度 + 重列**由 RPC 的返回值驱动**
 *    (`doRemove` 里的 `await onReload()`),收敛路径不依赖事件。真要让 RPC 与安装
 *    那条路同构(成功也推一条 `done`),改的是 `runtimeInstaller.ts` —— **本次的
 *    禁区**(别的代理正在改那个文件)。
 * ───────────────────────────────────────────────────────────────────────── */
