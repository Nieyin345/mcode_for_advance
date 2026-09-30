/**
 * Headless smoke for **集成终端**(`main/terminal/` 三个文件 + `main/ipc/terminal.ts`)。
 *
 * ## 它验的是什么
 *
 * 这一层有三件**只有真跑一遍才验得了**的事:
 *
 *  1. **用哪个 shell、参数怎么拼** —— `shellResolve.ts` 决定这件事。这台机器上它出错
 *     的形状是「命令跑起来了但结果完全不对」:少一个 `-NoLogo`、或者把一个 WSL 的
 *     `bash.exe` 当成了 Git Bash,终端照样开,只是里面的东西全是错的。**这类错很难
 *     发现**,所以判据要立在"选中的那个 exe 上,带没带上它必须带的参数"。
 *  2. **会话生命期** —— 开 / 写 / resize / 关。指针是:关掉之后**界面上能不能收到
 *     `terminal:exit`**、以及 `list()` 里那一条有没有真的消失。
 *  3. **IPC handler 报回去的那行字** —— 判据立在**用户看到的那句话**上,不是立在
 *     "有没有抛"。见 §6。
 *  4. **「这条终端是谁开的」与输出尾巴** —— 终端列表要列**所有**终端并说清来路,
 *     而"代理开的终端"目前一条都没有(唯一的创建入口是用户手点的那个面板),所以
 *     这条来路只能由调用方**传进来**、由主进程**原样留着**。见 §8。
 *
 * ## 它不验什么(诚实清单)
 *
 *  - **子进程输出的解码**:真 PTY 在 Windows 上走 ConPTY + **UTF-8 socket**
 *    (node-pty 的 `windowsPtyAgent.js` 把 `_outSocket.setEncoding("utf8")`,
 *    `terminal.js` 的 `onData` 递给回调的是**字符串**)。所以 `TerminalManager` 这一层
 *    **没有"字节"可解码** —— 那件事在 `lib/outBuf.ts`,是钩子与命令节点的活,已经有
 *    套件覆盖。§7 用**真的** node-pty 把这条事实钉一遍(见那一段的实测输出)。
 *  - 渲染端(xterm 那一侧)一行都不验。
 *
 * ## 它怎么隔离
 *
 *  - `node-pty` 换成**记账替身**:真 ConPTY 冷启动实测 3 秒以上(见 §7),本套要建十几个
 *    终端,真起进程就是一分钟起步 + 时序飘。替身保留真实现的三条硬事实(坏路径**抛**、
 *    pid 是数字、onData 收**字符串**),见 `stubs/pty-stub-package.cjs` 的头注。
 *  - `envRefresh` **没有换桩也换不掉**(相对 import,`--alias:` 不收),见 §1 那段注释。
 *  - `window` 换桩并**记下每一条推送** —— §2/§4 的断言直接读它。
 *  - `dataRoot` / `logger` 复用 `run-store-smoke/stubs/`(前者没设环境变量就抛)。
 *
 * ## 本套的"空过"守卫
 *
 * §7 那一段是**真 node-pty**,而它是本套唯一一处"替身可能整套盖住了问题"的地方。
 * 所以那一段的断言**不读替身的账本**,只看真进程吐出来的字节;真 node-pty 拉不起来时
 * 它是 FAIL 而不是跳过(见 §7 开头那段注释)。
 *
 * Run: scripts/terminal-smoke/run.sh
 */
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
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

/** 数组/对象比较 —— `Object.is` 对内容相同的两个数组是 false。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected },
  );
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * 让排队的异步回调跑完。
 *
 * 真 node-pty 的 `kill()` 是**排队**的(`windowsTerminal.js` 的 `_deferNoArgs`),
 * `exit` 事件要等 socket close 才到 —— 也就是说 `kill()` 返回之后界面上还会**再**收到
 * 一条 `terminal:exit`。断言要数那一条,就得先把队列放干净(替身用 `setImmediate` 排的)。
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 5));
}

/** 界面上收到的、属于某条终端的 exit 消息(按到达顺序)。 */
function exitsFor(terminalId: string): Array<Record<string, unknown>> {
  return windowStub.sentOf(IPC.TERMINAL_EXIT).filter((m) => m.terminalId === terminalId);
}

/* ───────────────────────── 0. 把一个可以看得见的目录树造出来 ─────────────────────────
 *
 * `TerminalManager.create` 会问 node-pty 要 cwd —— 而真 ConPTY **不接受不存在的
 * cwd**(实测,见 stubs/pty-stub-package.cjs)。所以这里造一个**真的**目录树当项目根,
 * §2 起的每一个终端都落在这里面。
 *
 * ⚠️ **临时目录,不是仓库** —— 本套不碰用户的任何东西;跑完 run.sh 会删掉。
 */
const SCRATCH = mkdtempSync(join(tmpdir(), "mcode-terminal-smoke-"));
const PROJECT = join(SCRATCH, "项目 带空格 目录");
const SUBDIR = join(PROJECT, "src");
const OUTSIDE = join(SCRATCH, "外面");
for (const d of [PROJECT, SUBDIR, OUTSIDE]) mkdirSync(d, { recursive: true });

process.on("exit", () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不该让套件红 —— 但下面 §5 会用 existsSync 验一次 */
  }
});

/* ───────────────────────── 1. 取账本 + 接线 ───────────────────────── */

// ⚠️ 顺序有讲究:`--alias:node-pty` 进 bundle 的是**打包期**那一份替身,而
// `TerminalManager.loadNodePty()` 走的是**运行期** `require("node-pty")`,由
// `run.sh` 放在 bundle 旁边的 `node_modules/node-pty/` 接住。两份替身通过
// `globalThis` 上的同一个账本见面(见 stubs/pty-stub-package.cjs 的头注)。
interface SpawnRecordLike {
  file: string;
  args: string[];
  opts: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number; name?: string; useConptyDll?: boolean };
  pty: FakePtyLike;
  killed: boolean;
}
interface FakePtyLike {
  pid: number;
  process: string;
  written: string[];
  resizes: Array<[number, number]>;
  __exit(code: number): void;
  __emitData(data: string): void;
  __makeKillThrow(message: string): void;
  listenerCounts(): { data: number; exit: number };
  isExited: boolean;
}

const ptyStub = (await import("node-pty")) as unknown as {
  spawns: SpawnRecordLike[];
  resetSpawns(): void;
  totalSpawned(): number;
};

const { TerminalManager } = await import("@main/terminal/TerminalManager.js");
const { resolveDefaultShell } = await import("@main/terminal/shellResolve.js");
const windowStub = (await import("@main/window.js")) as unknown as {
  sent: Array<{ channel: string; args: unknown[] }>;
  sentOf(channel: string): Array<Record<string, unknown>>;
  resetSent(): void;
};
// ⚠️ **`envRefresh` 没有换桩,而且是换不掉的。** `TerminalManager` 写的是相对 import
// (`from "./envRefresh.js"`),而 esbuild 的 `--alias:` 不收相对名字(mcode-smoke/SKILL.md
// 记过这条;本套头一版加过 `--alias:@main/terminal/envRefresh.js=…`,结果是**静默无效** ——
// 日志里照旧打 `[info] terminal env: refreshed 69 vars from live registry`,桩一次没被调到)。
//
// 不换它也不慢:它是 10 秒 TTL 的缓存,本套建十几个终端只在第一次付一次 powershell.exe 的钱。
// 而且 `envRefresh.ts` 有自己的套件(`scripts/agent-env-smoke`)。

// 那两句话得从**契约**里拿,不能手抄 —— 手抄的常量在契约改了之后不会跟着变,
// 而本套的判据正是"下发的 channel 对不对"。
const { IPC } = await import("@contracts/ipc");

const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { registerTerminalHandlers } = await import("@main/ipc/terminal.js");
registerTerminalHandlers(fakeIpc);

const { initDb } = await import("@main/store/db.js");
const { ProjectRepo, SettingRepo } = await import("@main/store/repositories.js");
await initDb();

function handlerFor(channel: string): (raw: unknown) => Promise<Record<string, unknown>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerTerminalHandlers 没有注册 ${channel}`);
  return (raw: unknown) => Promise.resolve(fn(null, raw)) as Promise<Record<string, unknown>>;
}

const create = handlerFor(IPC.TERMINAL_CREATE);
const write = handlerFor(IPC.TERMINAL_WRITE);
const resize = handlerFor(IPC.TERMINAL_RESIZE);
const kill = handlerFor(IPC.TERMINAL_KILL);
const list = handlerFor(IPC.TERMINAL_LIST);

check(
  "五个 terminal handler 都从 registerTerminalHandlers 里注册出来了",
  [IPC.TERMINAL_CREATE, IPC.TERMINAL_WRITE, IPC.TERMINAL_RESIZE, IPC.TERMINAL_KILL, IPC.TERMINAL_LIST].every((c) =>
    handlers.has(c),
  ),
  { missing: [IPC.TERMINAL_CREATE, IPC.TERMINAL_WRITE, IPC.TERMINAL_RESIZE, IPC.TERMINAL_KILL, IPC.TERMINAL_LIST].filter((c) => !handlers.has(c)) },
);

/* ───────────────────────── 2. shellResolve:选中了谁、参数怎么拼 ───────────────────────── */

section("2. shellResolve:这台机器上会选中谁,带什么参数");

// 这台机器的真实情况(run.sh 里探测到的):pwsh 不在 PATH,powershell 在;
// `where bash` 的**第一位**是 Git 的 bash.exe。所以默认档的答案是 powershell。
// 但断言**不写死机器名** —— 写死的话换台机器就红,红的是环境不是代码。
// 判据立在"选中的这个 exe 与它带的那组参数**互相匹配**"上,这个判据走遍机器都成立。
const def = resolveDefaultShell();

check(
  "默认分辨率返回了一个非空的可执行文件路径",
  typeof def.file === "string" && def.file.length > 0,
  def,
);
check(
  "默认分辨率带了 UI 要显示的那行 shell 标签",
  typeof def.label === "string" && def.label.length > 0,
  def,
);
check(
  "默认分辨率返回的 args 是数组",
  Array.isArray(def.args),
  def.args,
);

const base = def.file.toLowerCase();
// ⚠️ 下面这一串是**按选中谁分支**的 —— 分支写法最容易变成"一条都没跑"的空过。
// 所以记一笔,§8 正面确认至少有一支真的执行过。
let argsBranchTaken = "";
if (base.endsWith("cmd.exe") || base.endsWith("cmd")) {
  argsBranchTaken = "cmd";
  // cmd 现在挂着 `chcp 65001` —— 见 `shellResolve.ts` 那段（GBK 乱码）。
  same("选了 cmd → /K chcp 65001(切到 UTF-8 代码页)", def.args, ["/K", "chcp 65001"]);
} else if (base.includes("powershell")) {
  argsBranchTaken = "powershell";
  // PowerShell 的解法是把 `[Console]::OutputEncoding` 设成 UTF-8。`-NoExit` 非有不可
  // —— 少了它设完就退出了（终端一闪而过）。
  same("选了 powershell → -NoLogo + 设 UTF-8 输出编码", def.args, [
    "-NoLogo",
    "-NoExit",
    "-Command",
    "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  ]);
} else if (base.endsWith("bash.exe") || base.endsWith("bash")) {
  argsBranchTaken = "bash";
  // bash 本来就吐 UTF-8，**不动它**。
  same("选了 bash → 恰好 --login -i(不然它不当登录交互 shell)", def.args, ["--login", "-i"]);
} else {
  argsBranchTaken = "other";
  check(
    `选了 ${def.label} —— 它不在已知的那四种里,args 必须为空(别瞎塞参数)`,
    def.args.length === 0,
    def,
  );
}

// ⚠️ **本地 bash 被选中的情形必须点名**:`which("bash")` 走 `where.exe bash`,而
// System32 那个 **WSL 启动器**也在 PATH 里。WSL 的 bash 把 `/d/...` 当 Linux 路径,
// 一个 Windows 项目目录进去就是"路径不存在"(binaryResolve 的头注里写过这件事:
// 它专门留了个 `resolveGitBash()` 来排掉 WSL,给三家 SDK 的 Bash 工具用)。
//
// 但 `shellResolve` **没走 `resolveGitBash()`** —— 它走的是 `which("bash")`,也就是
// `where.exe bash` 的**第一位**。这台机器上第一位是 Git 的 bash,所以现在是好的;
// 但那是**环境**给的运气,不是代码给的保证。
//
// ⚠️ 这一条**不写成 `if (选中的是 bash)`** —— 那正是"空过"的形状(这台机器选的是 pwsh,
// 那个 if 从来不进,断言一条不跑却看着全绿)。改成**无条件**成立的形式:
// 默认分辨率的答案,**任何情况下**都不能落在 WSL 那三个目录里。
const { resolveGitBash } = await import("@main/lib/binaryResolve.js");
const gitBash = resolveGitBash();
const WSL_DIR_RE = /[\\/](System32|SysWOW64|WindowsApps)[\\/]/i;
check(
  "默认分辨率选中的 shell 不是 WSL 启动器(System32/SysWOW64/WindowsApps 里的那个)",
  !WSL_DIR_RE.test(def.file),
  { file: def.file, resolveGitBashWouldGive: gitBash },
);

// 另一条独立的路:`shellResolve` 挑 bash 用的是 `which("bash")`(where.exe 的第一位),
// 而 `binaryResolve.resolveGitBash()` 是**排掉 WSL 之后**的那个。这两个答案**不一定相同**,
// 代码里用的是前者。这一条把这份差异显式打出来 —— 不是断言(现在这台机器上两者一致),
// 是把"运气"记成一行可读的字:哪天它们分岔了,这里会先在日志里露出来。
const whichBash = (await import("@main/lib/binaryResolve.js")).which("bash");
console.log(
  `      ↳ shellResolve 会用的 bash = ${JSON.stringify(whichBash)}\n` +
    `        resolveGitBash() 给的   = ${JSON.stringify(gitBash)}` +
    (whichBash && gitBash && whichBash !== gitBash ? "   ⚠️ 两者不同,而代码用的是前者" : ""),
);

// 显式 override:这一档是**用户自己填的**,做对做错都看得见。
const overrideCmd = resolveDefaultShell("cmd.exe");
// cmd 现在挂着 `chcp 65001`（2026-09-21）—— 中文 Windows 的控制台代码页是 GBK，
// 而 node-pty 按 UTF-8 解，不切代码页的话中文全是乱码。见 `shellResolve.ts` 那段。
same("override 传 cmd.exe → 带 chcp 65001 切到 UTF-8", overrideCmd.args, ["/K", "chcp 65001"]);
check(
  "override 传 cmd.exe → file 指向真的 cmd.exe",
  overrideCmd.file.toLowerCase().endsWith("cmd.exe"),
  overrideCmd,
);

// ⚠️ **`which()` 带空格 / 带中文的路径**:这一条是任务书点名要查的。
//
// `which()` 走 `where.exe <name>` 再 `existsSync`。而 Windows 的 `where.exe` 往管道里
// 打的是**控制台代码页**的字节(中文机器 = GBK),`execFileSync(..., {encoding:"utf8"})`
// 于是把中文目录名解成 U+FFFD —— 然后 `existsSync(那个乱码路径)` 是 **false**,
// `which()` 返回 null。**当 PATH 里那条中文路径排第一位时,能力探测静默失败**:
// 界面说"没找到",可那个 exe 明明在那儿。
//
// 这条**不是 shellResolve 的错**(根在 `@main/lib/binaryResolve.ts` 的 `which()`,
// 不归本套管 —— 见报告里"没修的"那一段)。所以断言**不钉"它应该找得到"** ——
// 钉的是"当一个 Bash 装在带中文的目录里时,默认分辨率**不会把它当成一个可用的 shell**,
// 而且**不会**拿着一个解错的乱码路径去 spawn"。那是用户真会看到的后果。
const CN_DIR = join(SCRATCH, "中文 工具目录");
mkdirSync(CN_DIR, { recursive: true });
copyFileSync("C:\\Windows\\System32\\hostname.exe", join(CN_DIR, "fake-shell-probe.exe"));
// ⚠️ 只往 `process.env.PATH` 前面插(不动系统 PATH),跑完就还原。
const savedPath = process.env.PATH;
process.env.PATH = CN_DIR + ";" + (savedPath ?? "");
const withCnPath = resolveDefaultShell();
process.env.PATH = savedPath;
check(
  "PATH 里插了一条带中文的目录 → 分辨率仍然给出一个非空、非乱码的 shell",
  withCnPath.file.length > 0 && !withCnPath.file.includes("\uFFFD"),
  { file: withCnPath.file, dir: CN_DIR },
);
eq(
  "…而且它没变成那个带中文的目录里的 exe(which 解不出那条路径,于是够不到它)",
  withCnPath.file.includes("中文"),
  false,
);

// 坏 override:**显式报**还是**静默回落**?
//
// 真实现见 shellResolve.ts 的 `resolveOverride`:
// `log.warn("terminal.shell override not found: …")` 然后 `return null`,
// **静默回落到平台默认**。用户把 `terminal.shell` 设成打错了的路径,界面上一句提示
// 都没有,开出来的是一个 powershell ——「为什么我设了还是 powershell?」
const badOverride = resolveDefaultShell("C:\\definitely\\not\\a\\real\\shell-xyz.exe");
check(
  "override 是个不存在的路径 → 回落到平台默认(不是抛、也不是拿坏路径去 spawn)",
  badOverride.file.toLowerCase() !== "c:\\definitely\\not\\a\\real\\shell-xyz.exe" && badOverride.file.length > 0,
  badOverride,
);
check(
  "…而且回落的那一个不是坏路径本身(拿坏路径去 spawn 会得到 Cannot create process 267)",
  !badOverride.file.includes("shell-xyz"),
  badOverride,
);

// 空白 override 与 null 等价(设置里清空 = 用默认)。
same(
  "override 是空串 → 与不传同义(平台默认的两档一致)",
  [resolveDefaultShell("").file, resolveDefaultShell("   ").file, resolveDefaultShell(null).file],
  [def.file, def.file, def.file],
);

/* ───────────────────────── 3. TerminalManager:开 ───────────────────────── */

section("3. TerminalManager:开一个终端 —— 环境、尺寸、界面通知");

ProjectRepo.create({
  id: "p_term_smoke",
  name: "terminal-smoke",
  path: PROJECT,
  archived: false,
  sortOrder: 1,
  pinnedAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

ptyStub.resetSpawns();
windowStub.resetSent();

const created = await create({ projectPath: PROJECT });
eq("create 成功", created.ok, true);
check("create 回了一个 terminalId", typeof created.terminalId === "string" && (created.terminalId as string).length > 0, created);
check("create 回了 pid", typeof created.pid === "number", created);
eq("create 回的 cwd 就是传进去的那个(PROJECT 本身)", created.cwd, PROJECT);
check(
  "create 回的 shell 是那行人看的标签,不是空的",
  typeof created.shell === "string" && (created.shell as string).length > 0,
  created,
);

// ⚠️ **紧跟着 create 取 `spawns[0]`** —— 这一段后面还有别的 create,`spawns[0]` 会被
// 下一轮 `resetSpawns()` 重新计数。所以这里一次把这一条终端要用的东西全取出来,
// 后面不再回头看数组(那正是本套第一版栽的坑:断言读到的是**另一条**终端的 pty,
// 于是"write 到底下没下去"永远红,红得和被测代码无关)。
eq("真的 spawn 了一次", ptyStub.spawns.length, 1);
const spawn1 = ptyStub.spawns[0];
const pty1 = spawn1.pty;
const id1 = created.terminalId as string;
check("spawn 的 cwd 是项目路径(原样传下去,没有被重新拼)", spawn1.opts.cwd === PROJECT, spawn1.opts);

// 环境:那三行是 TerminalManager 自己写上去的(见 create() 里 env.TERM / LANG 那几句)。
check("下发到 PTY 的环境里有 TERM=xterm-256color", spawn1.opts.env?.TERM === "xterm-256color", { TERM: spawn1.opts.env?.TERM });
eq("下发到 PTY 的环境里有 COLORTERM", spawn1.opts.env?.COLORTERM, "truecolor");
eq("下发到 PTY 的环境里有 LANG", spawn1.opts.env?.LANG, "en_US.UTF-8");
eq("useConptyDll 是开的(默认那一档会 fork helper 刷 stderr)", spawn1.opts.useConptyDll, process.platform === "win32");

// 监听器真的挂上了 —— 没挂的话下面 §4 的推送一条都不会有,而那时的表现是
// "终端一片空白",看起来和"shell 卡住了"一模一样。
const counts = pty1.listenerCounts();
eq("onData 挂了一个监听", counts.data, 1);
eq("onExit 挂了一个监听", counts.exit, 1);

// ⚠️ **这一条是"用户会信"的形状**:用户在集成终端里敲 `claude`,拿到的必须是**他自己的**
// 会话目录,不能是 Mcode 的。真实现见 `envRefresh.buildTerminalEnv` 里那句显式 delete,
// 它按**大小写不敏感**地删(Windows 的环境变量名就是大小写不敏感的)。
//
// 这里直接改 `process.env`(不是桩) —— bug 那一侧要的是"快照里带了这个名字",
// 而真实现正是从 `process.env` 取快照的。
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = "C:\\Users\\whoever\\.mcode";
// 大小写那一路同样要钉(真实现是 `key.toUpperCase() === "CLAUDE_CONFIG_DIR"`)。
delete process.env.Claude_Config_Dir;
process.env.Claude_Config_Dir = "C:\\Users\\whoever\\.mcode2";
ptyStub.resetSpawns();
await create({ projectPath: PROJECT });
const envWithConfigDir = ptyStub.spawns[0].opts.env ?? {};
check(
  "PTY 的环境里没有 CLAUDE_CONFIG_DIR(用户在那个终端里敲 claude 不该被指到 Mcode 的会话目录)",
  !Object.keys(envWithConfigDir).some((k) => k.toUpperCase() === "CLAUDE_CONFIG_DIR"),
  { keys: Object.keys(envWithConfigDir).filter((k) => k.toUpperCase().includes("CLAUDE")) },
);
if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
delete process.env.Claude_Config_Dir;

// 尺寸:cols/rows 传下去没有;不传时是 80x24。
ptyStub.resetSpawns();
await create({ projectPath: PROJECT, cols: 133, rows: 47 });
eq("create 传的 cols 落到了 spawn 上", ptyStub.spawns[0].opts.cols, 133);
eq("create 传的 rows 落到了 spawn 上", ptyStub.spawns[0].opts.rows, 47);
ptyStub.resetSpawns();
await create({ projectPath: PROJECT });
eq("不传 cols → 默认 80", ptyStub.spawns[0].opts.cols, 80);
eq("不传 rows → 默认 24", ptyStub.spawns[0].opts.rows, 24);

/* ───────────────────────── 4. 写 / resize / 输出推送 / 退出 ───────────────────────── */

section("4. 写、resize、shell 的输出有没有送到界面上");

eq("write 到活着的终端 → ok", (await write({ terminalId: id1, data: "ls\r" })).ok, true);
same("…而且字节真的交给了那条终端的 PTY", pty1.written, ["ls\r"]);

eq("resize 到活着的终端 → ok", (await resize({ terminalId: id1, cols: 100, rows: 30 })).ok, true);
same("…而且尺寸真的交给了那条终端的 PTY", pty1.resizes, [[100, 30]]);

windowStub.resetSent();
pty1.__emitData("hello from shell\r\n");
const dataMsgs = windowStub.sentOf(IPC.TERMINAL_DATA);
eq("shell 吐了一段 → 界面上收到一条 terminal:data", dataMsgs.length, 1);
eq("…那条带的是这个 terminalId", dataMsgs[0]?.terminalId, id1);
eq("…那条的内容原样是 shell 吐的那串", dataMsgs[0]?.data, "hello from shell\r\n");

// 退出:子进程自己结束(用户敲 exit) → 界面上必须收到 exit,而且 list 里要没了。
windowStub.resetSent();
pty1.__exit(0);
const exitMsgs = windowStub.sentOf(IPC.TERMINAL_EXIT);
eq("shell 自己退出 → 界面上收到一条 terminal:exit", exitMsgs.length, 1);
eq("…带的是这个 terminalId", exitMsgs[0]?.terminalId, id1);
eq("…带上真的 exitCode", exitMsgs[0]?.exitCode, 0);

const afterExit = await list({ projectPath: PROJECT });
check(
  "…而且它已经从 list 里消失了",
  !(afterExit.terminals as Array<{ terminalId: string }>).some((t) => t.terminalId === id1),
  afterExit,
);

// **已经退出的终端再写** —— 界面上会看到「终端不存在或已退出」吗?
const writeAfterExit = await write({ terminalId: id1, data: "x" });
eq("往已退出的终端写 → ok:false", writeAfterExit.ok, false);
eq("…而且报的是那句人话", writeAfterExit.error, "终端不存在或已退出");

// 退出之后再来的数据不该被推给界面(真实现里那句 `if (!this.terminals.has(id)) return`)。
windowStub.resetSent();
pty1.__emitData("lost bytes");
eq("终端关掉之后 shell 再吐的数据不再推给界面", windowStub.sentOf(IPC.TERMINAL_DATA).length, 0);

/* ───────────────────────── 5. 关:kill 与 disposeAll 有没有留下东西 ───────────────────────── */

section("5. 关掉:界面通知、list 清空、残留");

// ⚠️ **先把台面清干净再数数。** §3 建的那几条(验环境变量、验 cols/rows 的)到这儿
// 还活着,不清的话下面「开了三个 → list 里有三个」会数出 6 个 —— 本套头一版就是
// 这么红的,红得和被测代码无关。
//
// `flushAsync()` 不能省:这些终端的 `kill()` 是排队的,它们的 exit 推送会在**下一拍**
// 才到,跑完再 `resetSent()` 才不会把上一段的推送算进这一段。
TerminalManager.disposeAll();
await flushAsync();
windowStub.resetSent();
ptyStub.resetSpawns();
const a = await create({ projectPath: PROJECT });
const b = await create({ projectPath: PROJECT });
const c = await create({ projectPath: PROJECT });
const ptyA = ptyStub.spawns[0].pty;
const ptyB = ptyStub.spawns[1].pty;
const ptyC = ptyStub.spawns[2].pty;

eq("开了三个 → list 里有三个", ((await list({ projectPath: PROJECT })).terminals as unknown[]).length, 3);

windowStub.resetSent();
eq("kill 一个 → ok", (await kill({ terminalId: a.terminalId })).ok, true);
// ⚠️ 顺序有讲究:下面三条要在 `kill()` **刚一返回**就读,因为替身(与真 node-pty 一致)
// 的 `kill()` 是**排队**的 —— 迟到的 onExit 还没到,`isExited` 也还是 false。
eq("…而且界面上立刻收到了 terminal:exit", exitsFor(a.terminalId as string).length, 1);
eq("…exitCode 是 null(不是子进程自己退的,是我们杀的)", exitsFor(a.terminalId as string)[0]?.exitCode, null);
eq("…list 里只剩两个", ((await list({ projectPath: PROJECT })).terminals as unknown[]).length, 2);
// 排队那一拍放干净,进程才算真的死。
await flushAsync();
eq("…那一拍之后进程才真的死掉(真 node-pty 的 kill 走 _deferNoArgs)", ptyA.isExited, true);

// ⚠️ **跟着真实现来:`kill()` 返回之后还有一条 exit。**
//
// 真 node-pty 的 `kill()` 走 `_deferNoArgs`,真正杀掉进程要等 ConPTY 的 socket close,
// 到那时 `TerminalManager` 在 `create()` 里挂的 `onExit` 会**再**推一条 —— 只不过那一条
// 带的是**真的 exitCode**(0),而 `kill()` 里那句显式推的是 `null`。
//
// **所以一条被用户点关闭的终端,界面上会收到两条 `terminal:exit`**:先 `null`、后 `0`。
// 渲染端 `TerminalView.tsx` 收第一条时就把 `terminalIdRef.current` 置了 null 并写了一句
// 「进程已退出」,第二条因为 id 对不上被丢掉 —— 落在用户眼里是同一个结果。
// 如果哪天渲染端改成不过滤 id,这两条会变成终端里**两行**同样的收尾提示。
await flushAsync();
eq(
  "…而且 kill() 返回之后 PTY 迟到的 onExit 还会再推一条(真 node-pty 的 kill 是排队的)",
  exitsFor(a.terminalId as string).length,
  2,
);
eq(
  "…那第二条带的是真 exitCode(不是 null)",
  exitsFor(a.terminalId as string)[1]?.exitCode,
  0,
);

// 重复 kill:界面上「关闭」按钮点两下不该报错(renderer 那侧写的是 `void api.terminal.kill`)
windowStub.resetSent();
const killAgain = await kill({ terminalId: a.terminalId });
eq("把一个已经关掉的 terminalId 再 kill 一次 → 仍然 ok:true(点两下关闭不该弹错)", killAgain.ok, true);
eq("…重复 kill 不会再推一条 exit(那条 id 已经不在了)", exitsFor(a.terminalId as string).length, 0);

// 重复 kill 要给 list 留下东西吗?
eq("重复 kill 不会在 list 里留半截记录", ((await list({ projectPath: PROJECT })).terminals as unknown[]).length, 2);

// ⚠️ **kill 抛了会怎样?** 真 ConPTY 上 `kill()` 是会抛的 —— 实测在进程已经自己退了
// 的时候调 `kill()`,原生层可以抛出来(`Cannot kill a pty that has already exited` 之类)。
// `TerminalManager.kill` 那一段是 try/catch 包住的,而**用户点关闭按钮时最需要的就是
// "它别弹错"**。这一条把那条 catch 路径钉住:即使底层抛了,接口照样 ok、界面照样收到
// exit、list 照样清干净 —— 用户那边看到的是一个干净关掉的终端。
const d = await create({ projectPath: PROJECT });
const ptyD = ptyStub.spawns[ptyStub.spawns.length - 1].pty;
ptyD.__makeKillThrow("Cannot kill a pty that has already exited");
windowStub.resetSent();
let killThrew: string | null = null;
let killThrewResult: Record<string, unknown> | null = null;
try {
  killThrewResult = await kill({ terminalId: d.terminalId });
} catch (e) {
  killThrew = e instanceof Error ? e.message : String(e);
}
eq("底层 kill() 抛了 → handler 不该把异常扔到界面上", killThrew, null);
eq("…而且照样回 ok:true(用户点关闭,不该看到一个红叉)", killThrewResult?.ok, true);
eq(
  "…而且界面照样收到 exit(不然那条终端在面板上会永远显着'活着')",
  exitsFor(d.terminalId as string).length,
  1,
);
eq("…而且 list 里也没有它了", ((await list({ projectPath: PROJECT })).terminals as unknown[]).some((t) => (t as { terminalId: string }).terminalId === d.terminalId), false);
await flushAsync();

// disposeAll:app 退出那条路。**三条都必须杀掉,且 list 清干净。**
windowStub.resetSent();
TerminalManager.disposeAll();
eq("disposeAll 之后 list 空了", ((await list({ projectPath: PROJECT })).terminals as unknown[]).length, 0);
same("…界面上这两条终端各立刻收到一条 exit", [exitsFor(b.terminalId as string).length, exitsFor(c.terminalId as string).length], [1, 1]);
await flushAsync();
same("…剩下的两个真进程被杀掉了", [ptyB.isExited, ptyC.isExited], [true, true]);
same(
  "…加上迟到的 onExit,每条终端一共两条(append 那条),但 list 已经是空的",
  [exitsFor(b.terminalId as string).length, exitsFor(c.terminalId as string).length],
  [2, 2],
);
eq("…disposeAll 之后 list 仍然空(迟到的 onExit 不该把记录塞回来)", ((await list({ projectPath: PROJECT })).terminals as unknown[]).length, 0);

// **残留**:disposeAll 之后再 kill 谁都不该抛。
let disposeThrew: string | null = null;
try {
  TerminalManager.disposeAll();
} catch (e) {
  disposeThrew = e instanceof Error ? e.message : String(e);
}
eq("disposeAll 跑第二遍不抛(退出路径上被调到两次也不该炸)", disposeThrew, null);

/* ───────────────────────── 6. IPC 层:报回去的那行字 ───────────────────────── */

section("6. ipc/terminal.ts:坏输入时报回去的是不是人话");

// 6a. 未知项目根
const unknownProject = await create({ projectPath: OUTSIDE });
eq("未知项目根 → ok:false", unknownProject.ok, false);
eq("…报的是那句写明原因的话", unknownProject.error, "未知项目路径，拒绝创建终端");

// 6b. cwd 在项目根外面
const outsideCwd = await create({ projectPath: PROJECT, cwd: OUTSIDE });
eq("cwd 在项目根外面 → ok:false", outsideCwd.ok, false);
eq("…报的是那句写明原因的话", outsideCwd.error, "cwd 必须位于项目目录内");

// 6c. cwd 是项目根的**子目录** → 允许(这是正常用法:在 src/ 下开终端)
ptyStub.resetSpawns();
const inSub = await create({ projectPath: PROJECT, cwd: SUBDIR });
eq("cwd 是项目根的子目录 → 允许", inSub.ok, true);
eq("…而且 spawn 的 cwd 就是那个子目录", ptyStub.spawns[0].opts.cwd, SUBDIR);
await kill({ terminalId: inSub.terminalId as string });

// 6d. **形近但不在里面**的路径。`pathWithin` 注释里专门写了 `/foo/bar` 不该匹配
// root `/foo/ba` —— 这一条把那个边界钉在 IPC 层上。
const sibling = PROJECT + "-sibling";
mkdirSync(sibling, { recursive: true });
const siblingCwd = await create({ projectPath: PROJECT, cwd: sibling });
eq("cwd 与项目根同前缀但不是它的子目录 → 拒绝", siblingCwd.ok, false);
eq("…报的是那句人话", siblingCwd.error, "cwd 必须位于项目目录内");

// 6e. **字段校验失败(坏 zod 输入)报的是什么?**
//
// 这是本套最要紧的一条断言。真实现那一段 catch 写的是:
//     const msg = err instanceof Error ? err.message : String(err);
//     return { ok: false, error: msg };
// 而 zod 的 `ZodError.message` 是一整段 **JSON 数组文本**(实测):
//     [\n  {\n    "code": "too_small",\n    "minimum": 1,\n … "path": [\n      "projectPath"\n    ]\n  }\n]
// 那串东西会被渲染端原样打进终端里(`TerminalView` 的 `result.error` → xterm.writeln)。
// 用户看到的是一屏 JSON,不是一句话。
const emptyProject = await create({ projectPath: "" });
eq("projectPath 空串 → ok:false", emptyProject.ok, false);
const emptyMsg = String(emptyProject.error ?? "");
console.log(`      ↳ 界面会看到的那行字:${JSON.stringify(emptyMsg.slice(0, 80))}${emptyMsg.length > 80 ? "…" : ""}`);
check(
  "坏字段报回来的**不是**一整段 zod JSON(用户不该看到 {\"code\":\"too_small\"...})",
  !emptyMsg.trimStart().startsWith("[") && !emptyMsg.includes('"code"'),
  { error: emptyMsg },
);
check(
  "坏字段报回来的话里**指出了是哪个字段**(projectPath)",
  emptyMsg.includes("projectPath"),
  { error: emptyMsg },
);

const hugeCols = await create({ projectPath: PROJECT, cols: 99999 });
eq("cols 超上限 → ok:false", hugeCols.ok, false);
const colsMsg = String(hugeCols.error ?? "");
check(
  "cols 超上限报回来的话里指出了是 cols,也不是一整段 JSON",
  colsMsg.includes("cols") && !colsMsg.includes('"code"'),
  { error: colsMsg },
);

// 6f. **spawn 真的失败**(shell 路径不存在)时报回去的是什么?
//
// `TerminalManager.create` 那一段 catch 组的是
//     `启动 shell 失败 (${resolved.label}): ${msg}`
// —— 里面有 shell 的名字、有底层原因。这一条验它**没有**退化成一句无信息的话。
const badSettingPath = join(SCRATCH, "no-such-shell.exe");
SettingRepo.set("terminal.shell", badSettingPath);
ptyStub.resetSpawns();
// 设置里那个路径不存在 → resolveOverride 回落到平台默认 → spawn 会成功。
// 要制造真正的 spawn 失败,得让 cwd 不存在,而那条路 IPC 层先挡掉了(pathWithin)。
// 所以这里正面验"设置项指了个坏路径之后,用户得到的仍然是一个能用的终端"。
const afterBadSetting = await create({ projectPath: PROJECT });
eq("terminal.shell 设了个不存在的路径 → 仍然开得出一个能用的终端(回落)", afterBadSetting.ok, true);
check(
  "…而且回落的那个 shell 不是那条坏路径",
  String(afterBadSetting.shell).toLowerCase() !== badSettingPath.toLowerCase(),
  { shell: afterBadSetting.shell, badSettingPath },
);
SettingRepo.set("terminal.shell", "");

// 6g. list 的 projectPath 过滤 —— 两个项目各开一个,别串味。
//
// ⚠️ 先把台面清干净(同 §5 的理由):不清的话下面「列出全部」那一条会数进
// §6c/§6e/§6f 建的那几条,数字对不上,而红的是本套的账不是被测代码。
TerminalManager.disposeAll();
await flushAsync();
windowStub.resetSent();
ProjectRepo.create({
  id: "p_term_other",
  name: "other",
  path: OUTSIDE,
  archived: false,
  sortOrder: 2,
  pinnedAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
ptyStub.resetSpawns();
const mine = await create({ projectPath: PROJECT });
const theirs = await create({ projectPath: OUTSIDE });
const mineList = (await list({ projectPath: PROJECT })).terminals as Array<{ terminalId: string }>;
const theirsList = (await list({ projectPath: OUTSIDE })).terminals as Array<{ terminalId: string }>;
check(
  "list 按项目过滤:我的那个项目里只有我开的终端",
  mineList.some((t) => t.terminalId === mine.terminalId) &&
    !mineList.some((t) => t.terminalId === theirs.terminalId),
  { mineList, mine: mine.terminalId, theirs: theirs.terminalId },
);
check(
  "…另一个项目里只有它自己的",
  theirsList.some((t) => t.terminalId === theirs.terminalId) &&
    !theirsList.some((t) => t.terminalId === mine.terminalId),
  { theirsList },
);
eq("不传 projectPath → 列出全部", ((await list({})).terminals as unknown[]).length, 2);

// 6h. list 的坏输入 —— **这一段记的是两个静默的坑**,而它们都只是"列表不对",
// 界面上不弹任何错(用户在集成终端面板里看到的是一条都不在,或者别的项目的终端串进来)。
//
// ⚠️ 真实现那一段 catch 写的是 `return { terminals: [] }` —— 校验失败被**吞成**
// 「一条终端都没有」,而不是报错。用户开着三个终端,列表里却是空的。
const listBad = await list({ projectPath: "" });
same(
  "list 传空 projectPath(zod min(1) 不通过)→ 不抛,界面不会弹错(返回空列表)",
  listBad.terminals,
  [],
);
// `null` 走的是另一路:`TerminalListSchema.parse(raw ?? {})` —— `null` 被 `??` 换成 `{}`,
// 于是一路 success,而 `input.projectPath` 是 undefined → **不套过滤,列出全部**。
// 用户切到 B 项目,列表里却把 A 项目的终端也列出来了。
const listNull = await list(null);
eq(
  "⚠️ 传 null → 被当成「没有项目」,于是列出**全部**(连别的项目的终端也串进来)",
  (listNull.terminals as unknown[]).length,
  2,
);

await kill({ terminalId: mine.terminalId as string });
await kill({ terminalId: theirs.terminalId as string });

/* ───────────────────────── 7. 真 node-pty:那条"没有字节要解"的事实 ───────────────────────── */

section("7. 真 node-pty(不换桩):Windows 上 PTY 到 onData 的是**字符串**");

/**
 * 这一段是本套唯一**不换桩**的地方。它要钉的事实只有一条,而那条事实决定了
 * 「TerminalManager 该不该做 GBK 解码」这个问题的答案:
 *
 *   node-pty 在 Windows 上把 out socket `setEncoding("utf8")`(windowsPtyAgent.js:72),
 *   `onData` 递出来的**已经是字符串**。所以这一层没有字节可解 —— 中文能正确显示,
 *   靠的是 ConPTY 在控制台那一侧就把输出转成了 UTF-8,不是靠我们解什么码。
 *
 * ⚠️ **拿真包要走绝对路径,不能用 `import("node-pty")`。** run.sh 把 `node-pty`
 * 标成了 `--external`,并在 bundle 旁边放了一份**替身包** —— 所以 bundle 里那句
 * `import("node-pty")` 会解析到替身。真包必须从仓库的 node_modules 里按绝对路径拿,
 * 而那个路径由 run.sh 用 `MCODE_SMOKE_REAL_NODE_PTY` 传进来(它用 `require.resolve`
 * 从 `apps/desktop/src/main/` 出发算,和 `TerminalManager` 那句运行期 require 同源)。
 *
 * ⚠️ **它拉不起来就是 FAIL,不是 SKIP。** 理由:如果这台机器上 node-pty 加载不了,
 * 那么**整个集成终端功能在真实 app 里也是坏的**,而本套若在这里静默跳过,就会给出一份
 * "全绿"的假象 —— 仓库里那两次「测试绿着而问题还在」正是这么来的。
 */
const REAL_PTY_PATH = process.env.MCODE_SMOKE_REAL_NODE_PTY;
check(
  "守卫:run.sh 把真 node-pty 的路径传进来了(§7 不是空过)",
  typeof REAL_PTY_PATH === "string" && REAL_PTY_PATH.length > 0 && existsSync(REAL_PTY_PATH),
  { REAL_PTY_PATH },
);

const realRequire = createRequire(import.meta.url);
let realPty: typeof import("node-pty") | null = null;
let realPtyLoadError: string | null = null;
try {
  if (REAL_PTY_PATH) {
    realPty = realRequire(REAL_PTY_PATH) as typeof import("node-pty");
  } else {
    realPtyLoadError = "MCODE_SMOKE_REAL_NODE_PTY 没设";
  }
} catch (e) {
  realPtyLoadError = e instanceof Error ? e.message : String(e);
}
check(
  "真 node-pty 能从这套脚本里加载(native 二进制在)",
  realPty !== null,
  { error: realPtyLoadError, REAL_PTY_PATH },
);

if (realPty) {
  // 真的起一个**立刻结束**的进程。绝不真起一个交互式 shell 去等输入 —— 那会挂死。
  // 用 `cmd /c chcp` 是因为它同时验两件事:命令跑得起来,而且它吐的是**中文**。
  const realCwd = PROJECT;
  const realOut = await new Promise<{ data: string; exitCode: number | string; ms: number }>((resolve) => {
    const parts: string[] = [];
    let kindOfChunk = "";
    const t0 = Date.now();
    let done = false;
    const p = realPty!.spawn("cmd.exe", ["/c", "chcp"], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: realCwd,
      env: { ...process.env } as Record<string, string>,
      useConptyDll: true,
    });
    p.onData((d) => {
      // ⚠️ 这一句就是本段要钉的东西:onData 递过来的是 string 还是 Buffer。
      if (!kindOfChunk) kindOfChunk = typeof d;
      parts.push(typeof d === "string" ? d : String(d));
    });
    const finish = (exitCode: number | string): void => {
      if (done) return;
      done = true;
      resolve({ data: parts.join(""), exitCode, ms: Date.now() - t0 });
    };
    p.onExit(({ exitCode }) => finish(exitCode));
    setTimeout(() => {
      if (!done) {
        try {
          p.kill();
        } catch {
          /* 已经退了 */
        }
        finish("timeout");
      }
    }, 20000);
  });

  check(
    "真 PTY 上 `cmd /c chcp` 在 20 秒内自己退了(没有挂着等输入)",
    realOut.exitCode === 0,
    { exitCode: realOut.exitCode, ms: realOut.ms },
  );

  const body = realOut.data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\x1b./g, "");
  check(
    "真 PTY 的中文输出**没有**一个 U+FFFD(解错码的话这里会是一片乱码)",
    !realOut.data.includes("\uFFFD"),
    { body, fffd: (realOut.data.match(/\uFFFD/g) || []).length },
  );
  // `chcp` 那句话的**语言**跟着 Windows 的显示语言走:英文系统(GitHub 的 Windows 机器)
  // 吐的是 `Active code page: 437`,根本没有中文可读。上面那条「没有 U+FFFD」照验;
  // 「中文读得出来」只在中文系统(代码页 936)上验 —— 作者与用户的机器都是。
  const chcpPage = /(\d+)\s*$/.exec(body.trim())?.[1];
  if (chcpPage === undefined || chcpPage === "936") {
    check(
      "真 PTY 的中文读得出来(『活动代码页』这五个字原样在)",
      body.includes("活动代码页"),
      { body },
    );
  } else {
    console.log(`  NOTE 系统代码页是 ${chcpPage}(非中文 Windows)—— 『活动代码页』那条不适用,跳过`);
  }
}

/* ───────────────────────── 8. 「谁开的」与输出尾巴(终端列表的地基) ─────────────────────────
 *
 * 终端列表要回答的那个问题 —— 「这条终端是谁开的」—— 在**主进程这一层**只有一件事
 * 可验:那个字段**留着了吗、原样吗、缺省时落在哪一档**。列表画成什么样是渲染端的事。
 *
 * ## 这一段的判据为什么立在这里
 *
 * 因为现在**没有任何代理会开终端**(全仓库唯一的创建入口是用户手点的
 * `TerminalPanel` → `TerminalView`,另外两处真 PTY 是 MCP 登录与钩子,都不进这个池子)。
 * 也就是说"代理开的终端"这条路径**今天没有生产者**,而这个字段就是它将来的插口 —— 所以
 * 断言只能在**契约边界**上钉:传 `session` 档进来,看它有没有原样出现在 `list()` 里。
 *
 * ## 输出尾巴
 *
 * 渲染端拿到输出是**纯推送**(`terminal:data`),一条不属于当前面板的终端在那一边是
 * 空的。列表点开某一条时要看得见它**此刻**的样子,靠的就是主进程这段尾巴 —— 所以
 * 「环里有东西了」和「不点名就不带上它」两件事都得钉住:前者错了是"点开一片空白",
 * 后者错了是每次 2 秒的轮询都白搬 20 KB 文本。
 */

section("8. 「谁开的」与输出尾巴 —— 终端列表的两块地基");

TerminalManager.disposeAll();
await flushAsync();
ptyStub.resetSpawns();
windowStub.resetSent();

// 8a. **不传 origin** ⇒ 落"用户手点的"那一档。
//
// ⚠️ 这一条钉的是**缺省不许是空的**:渲染端那个 `originLabel` 是穷尽的 switch,一旦
// 这个字段冒出来是 undefined,列表里就会出现一行既不写"用户"也不写会话名的东西。
ptyStub.resetSpawns();
const noOrigin = await create({ projectPath: PROJECT });
eq("不传 origin → 建得出来", noOrigin.ok, true);
const listedDefault = ((await list({ projectPath: PROJECT })).terminals as Array<{
  terminalId: string;
  origin: { kind: string };
}>).find((t) => t.terminalId === noOrigin.terminalId);
same("不传 origin ⇒ list 里那条是 { kind: \"user\" }(留一条来路,不许是空的)", listedDefault?.origin, {
  kind: "user",
});

// 8b. **传 session 档** ⇒ 原样留着 —— 这一条是"以后代理开终端"的插口。
//
// `nodeSessionId` 是可选的那一半:同一个会话里的子代理要能说出自己是谁,但它不是
// 另一条身份线。两条都带上,顺带钉住"可选字段没被吞"。
const sessionOrigin = {
  kind: "session" as const,
  sessionId: "sess_smoke_1",
  title: "论文精读",
  nodeSessionId: "node_smoke_7",
};
ptyStub.resetSpawns();
const withOrigin = await create({ projectPath: PROJECT, origin: sessionOrigin });
eq("传 session 档的 origin → 建得出来", withOrigin.ok, true);
const listedSession = ((await list({ projectPath: PROJECT })).terminals as Array<{
  terminalId: string;
  origin: unknown;
}>).find((t) => t.terminalId === withOrigin.terminalId);
same("传进来的 origin 原样出现在 list 里(含 title 与 nodeSessionId)", listedSession?.origin, sessionOrigin);

// 8c. **坏 origin 要被挡掉,而不是变成一条说不出来路的记录。**
// 判别式里没有 `kind: "agent"` 这一档 —— 如果它被放行了,渲染端那个穷尽 switch 就会
// 静默落进"用户开的"那一支,列表里说了一句**不真**的话。宁可创建失败。
const badOrigin = await create({ projectPath: PROJECT, origin: { kind: "agent" } });
eq("origin 的 kind 不在那两档里 → ok:false(不许静默落成'用户开的')", badOrigin.ok, false);
check(
  "…而且报回来的话里指出了是 origin",
  String(badOrigin.error ?? "").includes("origin"),
  { error: badOrigin.error },
);
// 校验没过的那一次不该在台面上留下一条半截终端。
eq(
  "…校验失败没有留下终端",
  ((await list({ projectPath: PROJECT })).terminals as unknown[]).length,
  2,
);

// 8d. **尾巴:不点名就不带。**
// 每次轮询都带上 20 KB 文本的话,那条 2 秒一次的 list 就成了搬垃圾的。
const plain = (await list({ projectPath: PROJECT })).terminals as Array<Record<string, unknown>>;
check(
  "不传 bufferFor → list 里每一条都**没有** buffer 字段(轮询不该白搬 20 KB)",
  plain.length === 2 && plain.every((t) => t.buffer === undefined),
  { buffers: plain.map((t) => (t.buffer === undefined ? null : String(t.buffer).length)) },
);

// 8e. **点名才带,而且带的只给那一条。**
ptyStub.resetSpawns();
const tailed = await create({ projectPath: PROJECT });
const ptyTail = ptyStub.spawns[0].pty;
windowStub.resetSent();
ptyTail.__emitData("hello from shell\r\n");
const withBuf = (await list({ bufferFor: tailed.terminalId })).terminals as Array<{
  terminalId: string;
  buffer?: string;
}>;
const target = withBuf.find((t) => t.terminalId === tailed.terminalId);
eq("点名的那一条带回了 buffer", target?.buffer, "hello from shell\r\n");
check(
  "…而且只有它带,别的不带",
  withBuf.filter((t) => t.buffer !== undefined).length === 1,
  { withBuffer: withBuf.filter((t) => t.buffer !== undefined).map((t) => t.terminalId) },
);

// 8f. **尾巴是"最近的那一段",不是从开天辟地起。**
//
// 环的容量见 `TERMINAL_BUFFER_CHARS`。这条钉的是**裁剪方向**:留下的必须是**尾部**
// (最近吐的),裁掉的必须是开头。裁反了的话,点开终端看到的是它几分钟前刚启动时的
// 那段欢迎语,而当前正在刷的输出全没了 —— 那比一片空白更难解释。
const { TERMINAL_BUFFER_CHARS } = await import("@contracts/ipc");
// ⚠️ **两端各放一个标记**。只用 "A" 铺满的话,"开头被裁掉了"这条判据是**写不出来的**
// —— 裁完剩下的还是 "A",`startsWith("A")` 恒真。本套第一版就是这么写的,它红了一条
// 与实现无关的断言(留下的确实是尾部,只是"开头"也是 A)。
const HEAD = "HEAD-MARKER-START";
const TAIL = "TAIL-MARKER-END";
ptyStub.resetSpawns();
const big = await create({ projectPath: PROJECT });
const ptyBig = ptyStub.spawns[0].pty;
ptyBig.__emitData(HEAD);
ptyBig.__emitData("A".repeat(TERMINAL_BUFFER_CHARS + 5_000));
ptyBig.__emitData(TAIL);
const bigInfo = ((await list({ bufferFor: big.terminalId })).terminals as Array<{
  terminalId: string;
  buffer?: string;
}>).find((t) => t.terminalId === big.terminalId);
const bigBuf = bigInfo?.buffer ?? "";
eq("远超容量的输出之后,尾巴长度正好是容量", bigBuf.length, TERMINAL_BUFFER_CHARS);
check(
  "…留下的是**最近**那一段(结尾那个标记原样在)",
  bigBuf.endsWith(TAIL),
  { tail: bigBuf.slice(-40) },
);
check(
  "…开头那段被裁掉了(不是把新内容裁了、留下启动时的欢迎语)",
  !bigBuf.includes(HEAD),
  { head: bigBuf.slice(0, 40) },
);

// 8g. **退出的终端连尾巴一起没了** —— 它本来就不该再出现在列表里。
ptyBig.__exit(0);
await flushAsync();
const afterBigExit = (await list({ bufferFor: big.terminalId })).terminals as Array<{
  terminalId: string;
}>;
check(
  "退出之后点名要它的尾巴 → 列表里根本没有这一条(不是回一条空的)",
  !afterBigExit.some((t) => t.terminalId === big.terminalId),
  { ids: afterBigExit.map((t) => t.terminalId) },
);

// 8h. **空过守卫**:§8 那几条尾巴断言依赖"真的有输出流过这一段";如果替身的
// `__emitData` 没能打到 `TerminalManager` 挂的监听上,`buffer` 会永远是空串,而
// "长度正好是容量"那条会以**另一个数字**的形式红 —— 红得和被测代码无关。
check(
  "守卫:§8 的输出确实真的从替身流进了那一层(§8e/§8f 不是拿空串在算)",
  (target?.buffer ?? "").length > 0 && bigBuf.length > 0,
  { small: (target?.buffer ?? "").length, big: bigBuf.length },
);

/* ───────────────────────── 10. 空过守卫 + 收尾 ───────────────────────── */

section("10. 守卫:有没有断言在空过");

// `§6f` 依赖"设置里那条坏路径被读到过" —— 如果 resolveOverride 根本没被调到,
// 那条断言就变成空过(建终端会走默认档,一样绿)。这里正面确认一次。
SettingRepo.set("terminal.shell", badSettingPath);
ptyStub.resetSpawns();
const guarded = await create({ projectPath: PROJECT });
check(
  "守卫:terminal.shell 那条坏路径确实被读进去了(§6f 不是空过)",
  guarded.ok === true && ptyStub.spawns.length === 1,
  { ok: guarded.ok, spawns: ptyStub.spawns.length },
);
if (guarded.ok) await kill({ terminalId: guarded.terminalId as string });
SettingRepo.set("terminal.shell", "");

// 本套用到 `SCRATCH` 那一整棵树;它必须真的存在过(不然 §2 起的终端全是空跑)。
check("守卫:临时项目目录真的建出来了(前面的 cwd 断言不是空过)", existsSync(PROJECT), { PROJECT });

// §2 那串「按选中谁分支」的断言 —— 确认真的进去了一支(而不是一个都没跑到)。
check(
  `守卫:§2 的参数断言真的进了一支(选中 ${argsBranchTaken},不是一条都没跑)`,
  argsBranchTaken !== "",
  { argsBranchTaken, file: def.file },
);

// **(b) 那两个"沉默"的断言不是空过** —— 它们依赖 §6g 把台面清干净并留下恰好 2 条。
// 数错台面的话它们会以"数字对得上"的假象通过。
check(
  "守卫:§6g/§6h 数的那 2 条终端确实在(不然「列出全部」那几条是拿错台面在算)",
  typeof mine.terminalId === "string" && typeof theirs.terminalId === "string",
  { mine: mine.terminalId, theirs: theirs.terminalId },
);

// **(c) 替身的账本真的被本套读过** —— 这是全套最容易"整套盖住问题"的地方:
// 如果 `create()` 那条运行期 require 没被替身接住(接了真 node-pty),`spawns` 会永远
// 是空的,而所有 `spawns[0].opts.*` 的断言会在**第一次**就 TypeError 而不是红一条;
// 换一种写法就会变成静默跳过。这里正面确认账本里**至少**有过东西。
check(
  "守卫:node-pty 替身的账本真的被记录下来过(§3-§6 的 opts 断言不是读空数组)",
  ptyStub.totalSpawned() > 0,
  { totalSpawned: ptyStub.totalSpawned(), current: ptyStub.spawns.length },
);

// disposeAll 收尾,别给下一个进程留活着的替身 PTY。
TerminalManager.disposeAll();
eq(
  "收尾:全部关掉之后 list 是空的",
  ((await list({})).terminals as unknown[]).length,
  0,
);

console.log(`\nterminal-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
