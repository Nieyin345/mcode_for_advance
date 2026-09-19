/**
 * Headless smoke for **`main/lsp/`** —— language server 的生命周期。
 *
 * 这两个文件零覆盖,而它们管的是主进程里**唯一会替用户起外部进程**的那条路之一。
 * 用户会信的东西全在这儿:
 *
 *  - 找不到 server 时,是**报出来**还是静默不工作?
 *  - 关掉之后,那个进程真的没了吗?(jdtls 一个实例 1GB+)
 *  - 起不来时会不会**无限重试**?报出来的次数对不对得上?
 *  - 「未启用」和「装了但没找到」,用户看到的是不是同一句话?
 *  - 工作区路径越界时拦不拦得住?
 *
 * ## 真起进程的那部分也是真的
 *
 * 不下载任何 language server(`lsp.install` 那条路整套避开 —— 那会往用户机器上
 * 装东西)。但 `ensureServer` 那条路是**真的 spawn**:本套造一个假的 server
 * (node + 一帧 Content-Length 的 JSON-RPC),用一个 `.cmd` 把它包起来 ——
 * 那正是 Windows 上 npm 全局装的 server 的形状(cmd.exe 包着 node),
 * 也正是这条路上两个真问题(重试次数翻倍、孤儿进程)的形状。
 *
 * ## 它不碰用户真正的数据根
 *
 * `lsp.servers` 配置住在 settings 表里,而 `SettingRepo.set` 内部就是 `persist()`
 * —— 一次调用就重写整个 `mcode.db`。数据根是本脚本 `mktemp -d` 出来的
 * (`stubs/dataRoot.ts` 没设环境变量就抛),Java 的安装目录也被 electron 桩引到
 * 临时目录里。
 *
 * Run: scripts/lsp-smoke/run.sh
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";
import type { Project } from "@contracts/session";
import { IPC, LSP_SERVERS_SETTING_KEY } from "@contracts/ipc";
import {
  ALL_LANGUAGE_SPECS,
  LANGUAGE_SPECS,
  currentPlatform,
} from "@main/lsp/languageSpecs.js";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SettingRepo } from "@main/store/repositories.js";
import { registerLspHandlers } from "@main/ipc/lsp.js";
import { lspManager } from "@main/lsp/LspManager.js";
import { lspEvents, otherChannels, resetSent, lastEvent, countEvents } from "./stubs/window.js";
import { registerWorkspaceRoot, setKnownRoots } from "./stubs/pathGuard.js";
import { setBinaries, clearBinaries, probed } from "./stubs/binaryResolve.js";

/* ─────────────────────────── 断言助手 ─────────────────────────── */

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

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组 / 对象比较。`Object.is` 对两个内容相同的数组是 false。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function says(name: string, text: unknown, needle: string): void {
  check(
    name,
    typeof text === "string" && text.includes(needle),
    { actual: text, expected: `包含「${needle}」` },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 调一次 `lspManager.request`,无论抛什么都折成 `{error}`。
 *
 *  ⚠️ **这个 `.catch` 非有不可,而且它遮不住被测代码的毛病。**
 *  `LspManager.request` 自己的契约是「返回 `{error}`,不抛」。但一个**一起就退出**
 *  的 server 会让它内部**别的那条链**先断:进程退出时 `removeServer` 把 pending
 *  的 `initialized` 拒了,而那一刻已经没人 await 它了。更早的一版本套里,这个
 *  拒绝把 node 直接带走(`Error: language server stopped`,整段断言连结果都打不出)。
 *  所以夹具侧必须自己兜住,失败的那次也要能看清红在哪 —— 而不是让脚本半路死掉。
 *  (这是夹具的防御,不是对被测代码的断言。) */
async function requestSafe(
  workspacePath: string,
  language: "typescript" | "python" | "go" | "java",
  method: string,
  params: unknown,
): Promise<{ error?: { code: number; message: string }; result?: unknown }> {
  try {
    return (await lspManager.request(workspacePath, language, method, params)) as {
      error?: { code: number; message: string };
    };
  } catch (err) {
    return { error: { code: -32603, message: (err as Error).message } };
  }
}

/** 这个 pid 还活着吗。
 *
 *  ⚠️ **不能用 `process.kill(pid, 0)`。** 本进程的 pid 是它所在进程组的组长,
 *  而 Node 的 `process.kill` 对**负数/组**另有语义 —— 实测在 git-bash 起的环境里
 *  信号会打到整组,连自己一起算成"活着"。改成问 `tasklist`(POSIX 上问 `ps`)。
 *
 *  pid 已经不属于任何进程时,两者都返回空 —— 那才是"死了"。 */
function alive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.includes(`"${pid}"`);
    }
    execFileSync("ps", ["-p", String(pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────────── 夹具目录 ─────────────────────────── */

const FIX = mkdtempSync(join(tmpdir(), "mcode-lsp-fixtures-"));
const BIN = join(FIX, "bin");                    // 无空格 —— shell:true 那条路能起来
const BIN_SPACED = join(FIX, "bin with space");  // 有空格 —— 用户手动指定路径时的形状
const SRV = join(FIX, "srv");
const WORKSPACES = join(FIX, "ws");
for (const d of [BIN, BIN_SPACED, SRV, WORKSPACES]) mkdirSync(d, { recursive: true });

/** 假 server 的进程记档(每一行一个 `{pid, ppid, cwd}`)。 */
const PIDS = join(FIX, "pids");
mkdirSync(PIDS, { recursive: true });
process.env.LSP_SMOKE_PID_DIR = PIDS;
const SPAWN_LOG = join(FIX, "spawns.jsonl");
process.env.LSP_SMOKE_SPAWN_LOG = SPAWN_LOG;

/** 假 language server:把「谁起的我」记档,然后完成一次 initialize 握手并常驻。
 *
 *  `process.argv[2]` 是**标签** —— 每个语言一个 shim(`good-ts.cmd` / `good-py.cmd`),
 *  于是一条 `java-1234.pid` 就能看出它属于哪个语言。没有这个标签就分不清
 *  「关掉 typescript 之后活着的那个」到底是 typescript 的漏网还是 python 的那个。
 *
 *  ⚠️ **它必须能挂住不动。** 真实 server 挂在自己的事件循环上(jdtls 是个 JVM),
 *  而这里只有一个 stdin 监听器 —— stdin 那头一断,事件循环空了,node 会**自己退出**。
 *  那样「关掉之后有没有残留进程」这条断言验的就成了假 server 的礼貌程度:
 *  包装进程被 kill 之后它也走了,于是看起来"没有孤儿"—— 而真的 server 不会走。
 *  所以这里显式挂一个定时器把自己钉住,只在收到 `exit` 通知、或被外力杀掉时才离开。 */
const FAKE_SERVER_SRC = `
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
const DIR = process.env.LSP_SMOKE_PID_DIR;
const TAG = process.argv[2] || "unknown";
const LOG = process.env.LSP_SMOKE_SPAWN_LOG;
if (DIR) writeFileSync(DIR + "/" + TAG + "-" + process.pid + ".pid", String(process.pid));
if (LOG) appendFileSync(LOG, TAG + "\\n");
setInterval(() => {}, 60000); // 钉住事件循环 —— 见文件头那段
let buf = Buffer.alloc(0);
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n");
    if (sep === -1) return;
    const head = buf.subarray(0, sep).toString();
    const m = /Content-Length:\\s*(\\d+)/i.exec(head);
    if (!m) { buf = buf.subarray(sep + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buf.length - (sep + 4) < len) return;
    const body = buf.subarray(sep + 4, sep + 4 + len).toString();
    buf = buf.subarray(sep + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === "exit") process.exit(0);
    if (msg.id === undefined) continue;
    const res = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { capabilities: {} } : null });
    process.stdout.write("Content-Length: " + Buffer.byteLength(res) + "\\r\\n\\r\\n" + res);
  }
});
`;

/** 一个"挂住不退出"的东西(§6c 的假包管理器)。真 npm 装一个包要几十秒,
 *  夹具只是要一个还在跑的目标。 */
const SLEEPER_SRC = `
import { writeFileSync } from "node:fs";
const DIR = process.env.LSP_SMOKE_PID_DIR;
const TAG = process.argv[2] || "sleeper";
if (DIR) writeFileSync(DIR + "/" + TAG + "-" + process.pid + ".pid", String(process.pid));
setInterval(() => {}, 60000);
`;
const SLEEPER_JS = join(SRV, "sleeper.mjs");
writeFileSync(SLEEPER_JS, SLEEPER_SRC);

const SERVER_JS = join(SRV, "fake-lsp.mjs");
writeFileSync(SERVER_JS, FAKE_SERVER_SRC);

/** `cmd.exe` 形状的包装 —— npm 全局装的 language server 就是这样。 */
function writeCmdShim(path: string, lines: string[]): void {
  writeFileSync(path, `@echo off\r\n${lines.join("\r\n")}\r\n`);
}

/** 能完成握手的那一个:`good-<tag>.cmd`。tag 就是被起的语言 —— 记档文件名
 *  是 `<tag>-<pid>.pid`,于是「关掉之后还剩谁」可以精确到语言。 */
function goodServerIn(dir: string, tag: string): string {
  const p = join(dir, `good-${tag}.cmd`);
  writeCmdShim(p, [`"${process.execPath}" "${SERVER_JS}" ${tag} %*`]);
  return p;
}

const GOOD_TS = goodServerIn(BIN, "ts");
const GOOD_PY = goodServerIn(BIN, "py");

/** 同一个东西,放在带空格的目录里 —— 用来说明「手动指定路径」那条路。 */
const SPACED_SERVER = goodServerIn(BIN_SPACED, "spaced");

/** 一起就退出的 server(模拟 jdtls 起不来)。每次 spawn 记一笔,好数尝试次数。 */
const DEAD_LOG = join(FIX, "dead-spawns.log");
const DEAD_SERVER = join(BIN, "dead-langserver.cmd");
writeCmdShim(DEAD_SERVER, [`echo x>>"${DEAD_LOG}"`, `exit /b 1`]);

/** Java 健康检查要的 equinox launcher jar。 */
const JAVA_PLUGINS = join(SRV, "java", "plugins");
mkdirSync(JAVA_PLUGINS, { recursive: true });
writeFileSync(join(JAVA_PLUGINS, "org.eclipse.equinox.launcher_1.0.0.jar"), "");

/* ─────────────────────────── 环境 ─────────────────────────── */

const DATA = mkdtempSync(join(tmpdir(), "mcode-lsp-data-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

await initDb();

const platform = currentPlatform();
console.log(`[lsp-smoke] platform=${platform}`);
console.log(`[lsp-smoke] 数据根 ${DATA}(用户真正的 mcode.db 没被碰)`);

/* ─────────────────────────── 收尾:清进程 ─────────────────────────── */

/** 主脚本起过的假 server —— 收尾时由它收干净。
 *  只在**收尾**调用(而不是每条断言之间),因为「关掉之后进程没了吗」那条断言
 *  需要它们中间还活着。 */
function killLeftovers(): void {
  for (const pid of spawnedPids()) {
    if (alive(pid)) killTree(pid);
  }
}

/** 带走一个假 server。win32 上它是 cmd.exe 包着 node,所以要 `/T` ——
 *  这正是本套在 §6 验的那条规则,收尾自己也照它做,不然收尾会漏。 */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* 已经死了 */
  }
}

/** 从记档文件名里取出 pid。
 *
 *  ⚠️ 不能用 `indexOf("-")`:标签自己也可能带横线(`install-npm`),
 *  那样切出来的就是 `npm-123` 而不是 `123` —— `Number()` 得到 NaN,
 *  于是"进程还在"被静默地读成"没有进程",断言假绿。
 *  标签永远是前缀、pid 永远是最后那段数字,所以按**结尾**认。 */
function pidFromName(name: string): number {
  const m = /-(\d+)\.pid$/.exec(name);
  return m ? Number(m[1]) : NaN;
}

/** 记档里的 pid 列表(文件名形如 `<tag>-<pid>.pid`)。 */
function spawnedPids(): number[] {
  if (!existsSync(PIDS)) return [];
  return readdirSync(PIDS)
    .filter((n) => n.endsWith(".pid"))
    .map(pidFromName)
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** 记档里属于某个语言的 pid(去掉标签之后剩下的那批)。 */
function pidsFor(tag: string): number[] {
  if (!existsSync(PIDS)) return [];
  return readdirSync(PIDS)
    .filter((n) => n.endsWith(".pid") && n.startsWith(`${tag}-`))
    .map(pidFromName)
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** 还在跑的那些,按语言分组 —— 一条断言就能看清「谁漏了」。 */
function runningByTag(tags: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const t of tags) out[t] = pidsFor(t).filter(alive);
  return out;
}

/** 清空记档(每一段自己数自己的)。 */
function resetPidLog(): void {
  if (!existsSync(PIDS)) return;
  for (const n of readdirSync(PIDS)) rmSync(join(PIDS, n), { force: true });
}

/* ─────────────────────────── 0. 真 handler 取出来 ─────────────────────────── */

/** `ipcMain` 的记名替身(抄 `library-trash-smoke` 的 §4)。判据住在 handler 的
 *  函数体里 —— 它是用户点按钮时真正跑的那一行,唯一拿得到的办法就是调
 *  `registerLspHandlers` 把注册进去的函数收下来。 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle: (ch: string, fn: (event: unknown, raw: unknown) => unknown) => handlers.set(ch, fn),
} as unknown as IpcMain;
registerLspHandlers(fakeIpc);
const call = (ch: string, raw?: unknown) => handlers.get(ch)!(null, raw);

check("LSP 的 IPC 面注册齐了", handlers.size === 14, { size: handlers.size, channels: [...handlers.keys()] });

/* ─────────────────────────── 1. 工作区夹具 ─────────────────────────── */

function mkWorkspace(name: string): string {
  const p = join(WORKSPACES, name);
  mkdirSync(p, { recursive: true });
  return p;
}

const WS1 = mkWorkspace("alpha");
const WS2 = mkWorkspace("beta");
const WS3 = mkWorkspace("gamma");
const WS_OUTSIDE = mkWorkspace("outside");

for (const [ws, file] of [[WS1, "a.ts"], [WS2, "b.ts"], [WS3, "c.ts"]] as const) {
  writeFileSync(join(ws, file), "const x = 1;\n");
}

function addProject(id: string, path: string): void {
  const now = Date.now();
  const p: Project = {
    id, name: id, path, archived: false, sortOrder: 0, pinnedAt: null, createdAt: now, updatedAt: now,
  };
  ProjectRepo.create(p);
}

addProject("p-alpha", WS1);
addProject("p-beta", WS2);
addProject("p-gamma", WS3);
registerWorkspaceRoot(WS1);
registerWorkspaceRoot(WS2);
registerWorkspaceRoot(WS3);
// WS_OUTSIDE 故意**不**登记 —— 它是路径越界那条断言的对手。

/** 把配置写成「只有这两种语言,且都指向给定的 server」。 */
function configure(configs: Array<Record<string, unknown>>): void {
  SettingRepo.set(LSP_SERVERS_SETTING_KEY, JSON.stringify(configs));
}

/* ─────────────────────────── 2. languageSpecs:表本身 ─────────────────────────── */

console.log("\n§2 languageSpecs —— 纯数据表(没有逻辑可测,但表里有会咬人的地方)");

{
  same(
    "四张 spec 都在,顺序固定(界面按这个顺序列)",
    ALL_LANGUAGE_SPECS.map((s) => s.language),
    ["typescript", "python", "go", "java"],
  );
  check("LANGUAGE_SPECS 的键与 ALL 是同一批对象", ALL_LANGUAGE_SPECS.every((s) => LANGUAGE_SPECS[s.language] === s));

  // 每个扩展名只能有一个主 —— 两个 spec 抢同一个扩展名时,谁赢取决于表的顺序。
  const owner = new Map<string, string[]>();
  for (const s of ALL_LANGUAGE_SPECS) {
    check(
      `${s.language}: extensions 全是小写带点`,
      s.extensions.every((e) => e === e.toLowerCase() && e.startsWith(".")),
      s.extensions,
    );
    for (const e of s.extensions) owner.set(e, [...(owner.get(e) ?? []), s.language]);
  }
  same("没有两个 spec 抢同一个扩展名", [...owner.entries()].filter(([, l]) => l.length > 1), []);

  for (const s of ALL_LANGUAGE_SPECS) {
    check(
      `${s.language}: install/uninstall 三个平台都有键`,
      (["win32", "darwin", "linux"] as const).every(
        (pf) => Array.isArray(s.install[pf]) && Array.isArray(s.uninstall[pf]),
      ),
    );
    check(`${s.language}: binaryNames 非空`, s.binaryNames.length > 0);
    check(`${s.language}: displayName 非空`, typeof s.displayName === "string" && s.displayName.length > 0);
    // downloadHint 是用户会读到的那行字 —— 一个空串会让界面出现一个没有说明的按钮。
    check(`${s.language}: downloadHint 是中文提示`, /[\u4e00-\u9fa5]/.test(s.downloadHint ?? ""), s.downloadHint);
    check(`${s.language}: downloadUrl 是 https`, /^https:\/\//.test(s.downloadUrl ?? ""), s.downloadUrl);
  }

  // startCommand 是**唯一**把「用户配置的路径」接到命令行上的地方 ——
  // 传进去什么必须原样出现在 cmd 里。
  same("startCommand 原样使用给定的路径", LANGUAGE_SPECS.typescript.startCommand("C:/bin/tsserver.cmd"), {
    cmd: "C:/bin/tsserver.cmd",
    args: ["--stdio"],
  });
  same("java 的 startCommand 不带参数(它走 buildJavaSpawnCommand)", LANGUAGE_SPECS.java.startCommand("C:/jdtls").args, []);

  // 表说 java 在 win32/linux 上没有包管理器安装入口 —— 那是 installJava 那条路的依据。
  if (platform !== "darwin") {
    eq(`java 在 ${platform} 上没有包管理器安装命令`, LANGUAGE_SPECS.java.install[platform].length, 0);
  }
  check(
    "typescript 的 install 同时装 language-server 和它的 peer dep typescript",
    LANGUAGE_SPECS.typescript.install.win32.includes("typescript-language-server") &&
      LANGUAGE_SPECS.typescript.install.win32.includes("typescript"),
    LANGUAGE_SPECS.typescript.install.win32,
  );
  // python 的 binaryNames 有优先级:basedpyright 优先,pyright 兜底。
  same("python 优先 basedpyright,pyright 兜底", LANGUAGE_SPECS.python.binaryNames, ["basedpyright-langserver", "pyright-langserver"]);
}

/** `loadConfig` 的夹具包装:它**不该抛**,所以抛了要变成一条能读的红,
 *  而不是把整个脚本带走(带走的话后面每一段都跑不到,红在哪也看不清)。
 *  返回 null 表示"抛了" —— 调用点据此判红。 */
function loadConfigSafe(): Array<{ language: string; enabled: boolean; serverPath?: string }> | null {
  try {
    return lspManager.loadConfig() as Array<{ language: string; enabled: boolean; serverPath?: string }>;
  } catch {
    return null;
  }
}

/* ─────────────────────────── 3. 配置持久化 ─────────────────────────── */

console.log("\n§3 配置(settings 表里的 JSON 数组)");

{
  SettingRepo.set(LSP_SERVERS_SETTING_KEY, "");
  const fresh = loadConfigSafe();
  check("空配置时 loadConfig 不抛(配置读挂了会让整个面板空白,什么都点不了)", fresh !== null, fresh);
  same("没有任何配置时也给出全部四种语言(界面上不会缺行)", (fresh ?? []).map((c) => c.language), ["typescript", "python", "go", "java"]);
  check("默认全关(不会偷偷替用户起进程)", (fresh ?? []).every((c) => c.enabled === false), fresh);
  check("默认没有 serverPath", (fresh ?? []).every((c) => c.serverPath === undefined), fresh);
}

{
  // 坏 JSON:不能把整个 list 读崩,也不能把用户看到的行数变少 —— 只能退回默认。
  SettingRepo.set(LSP_SERVERS_SETTING_KEY, "{这不是 JSON");
  const bad = loadConfigSafe();
  check("坏 JSON 时 loadConfig 也不抛(只退回默认)", bad !== null, bad);
  same("坏 JSON 退回默认,四种语言仍在", (bad ?? []).map((c) => c.language), ["typescript", "python", "go", "java"]);
}

{
  // 不认识的语言条目(旧版本留下的 / 手改坏的)必须被丢掉,而且不能顶掉别的语言。
  SettingRepo.set(
    LSP_SERVERS_SETTING_KEY,
    JSON.stringify([
      { language: "ruby", enabled: true, serverPath: "C:/ruby-lsp" }, // 不认识
      { language: "go", enabled: true, serverPath: "C:/gopls" },
      "not-an-object",
      null,
    ]),
  );
  const merged = loadConfigSafe();
  check("库里混着畸形条目时 loadConfig 也不抛(它就是最容易被写坏的那个输入)", merged !== null, merged);
  same("条目以代码里的表为准(顺序 + 数量)", (merged ?? []).map((c) => c.language), ["typescript", "python", "go", "java"]);
  eq("认识的条目保留了", merged?.find((c) => c.language === "go")?.serverPath, "C:/gopls");
  eq("不认识的条目被丢掉(没有第五行)", (merged ?? []).length, 4);
}

{
  // ⚠️ 用户点「启用」写进库之后,list 必须立刻读到 —— 不是启动时缓存的副本。
  // (这条钉的是「配置只在启动时读一次」那种写法;那会让用户点完开关没反应。)
  SettingRepo.set(LSP_SERVERS_SETTING_KEY, JSON.stringify([{ language: "go", enabled: true }]));
  eq(
    "开关状态是每次现读的(不是启动时缓存的)",
    loadConfigSafe()?.find((c) => c.language === "go")?.enabled,
    true,
  );
}

/* ─────────────────────────── 4. 找不到 server:显式报错 ─────────────────────────── */

console.log("\n§4 找不到 server —— 必须报出来,不能静默");

{
  clearBinaries(); // 什么可执行文件都找不到 = 一台干净机器
  configure([{ language: "typescript", enabled: true }]);

  const absent = (await lspManager.list()).languages.find((c) => c.language === "typescript")!;
  eq("找不到时 installed=false", absent.installed, false);
  eq("找不到时 serverPath=null", absent.serverPath, null);

  resetSent();
  const r = (await call(IPC.LSP_REQUEST, {
    workspacePath: WS1,
    language: "typescript",
    method: "textDocument/hover",
    params: {},
  })) as { error?: { code: number; message: string } };
  check("request 返回的是 error,不是静默的空 result", !!r.error, r);
  says("错误里点名了缺哪个可执行文件", r.error?.message, "typescript-language-server");
  says("错误里给了下一步", r.error?.message, "请先安装或指定路径");

  const stopped = lastEvent("stateChanged", { language: "typescript", workspacePath: WS1 });
  eq("同一条拒绝也推到了界面工具栏(用户看得见)", (stopped?.payload as { phase?: string })?.phase, "stopped");
  says("推到界面的原因就是拿到的那一句(两处只有一份文案)", (stopped?.payload as { error?: string })?.error, "typescript-language-server");
  same(
    "推到界面的那句与返回给调用方的完全一致",
    (stopped?.payload as { error?: string })?.error,
    r.error?.message,
  );

  const hc = (await call(IPC.LSP_HEALTH_CHECK, { language: "typescript" })) as { ok: boolean; error?: string };
  eq("healthCheck 报失败", hc.ok, false);
  says("healthCheck 的错误也点名了可执行文件", hc.error, "typescript-language-server");
}

/* ─────────────────────────── 5. 未启用:报错 + 不推事件 ─────────────────────────── */

console.log("\n§5 语言未启用");

{
  clearBinaries();
  configure([]);
  resetSent();
  const r = (await call(IPC.LSP_REQUEST, {
    workspacePath: WS2,
    language: "python",
    method: "textDocument/hover",
    params: {},
  })) as { error?: { message: string } };

  // ⚠️「未启用」与「装了但没找到」是两回事,用户看到的话必须不同 ——
  // 否则他会照着「请先安装」去装一个已经装好的东西。
  says("未启用时报的是「未启用」", r.error?.message, "未启用");
  check("未启用的话里不出现「未找到」", !(r.error?.message ?? "").includes("未找到"), r.error?.message);
  check("未启用时**不**推事件(用户主动关的,不该弹提示)", countEvents("stateChanged", { language: "python" }) === 0, lspEvents);

  const pre = await lspManager.prewarm(WS2);
  eq("prewarm 未启用时 ok=false", pre.ok, false);
  says("prewarm 说明是未启用", pre.error, "未启用");

  // healthCheck 在未启用 + 找不到时,报的是「找不到」那条 —— 它也说得通,
  // 但记住这个差异:检查按钮与真的去用,话术不一样。
  const hc = (await call(IPC.LSP_HEALTH_CHECK, { language: "python" })) as { ok: boolean; error?: string };
  eq("healthCheck 对未启用的语言也报失败", hc.ok, false);
}

/* ─────────────────────────── 6. 真起进程 ─────────────────────────── */

console.log("\n§6 真起一个 server(假 server 走完整 initialize 握手)");

{
  clearBinaries();
  configure([
    { language: "typescript", enabled: true, serverPath: GOOD_TS },
    { language: "python", enabled: true, serverPath: GOOD_PY },
  ]);
  // 这一段自己数自己的 —— 记档从零开始,后面「起了几个 / 还剩谁」才有意义。
  resetPidLog();

  resetSent();
  await lspManager.openDocument(WS1, join(WS1, "a.ts"), "typescript");

  const phases = lspEvents
    .filter((e) => e.type === "stateChanged" && e.language === "typescript")
    .map((e) => (e.payload as { phase: string }).phase);
  same("界面看到的相位顺序是 starting → running", phases, ["starting", "running"]);
  eq(
    "running 那条带 running=true",
    (lastEvent("stateChanged", { language: "typescript" })?.payload as { running: boolean })?.running,
    true,
  );
  eq("list 说它正在跑", (await lspManager.list()).languages.find((c) => c.language === "typescript")?.running, true);

  eq("真的起来了(假 server 记到一笔)", spawnedPids().length, 1);

  // 幂等:同一个工作区反复打开/编辑不能再起第二个进程。
  await lspManager.openDocument(WS1, join(WS1, "a.ts"), "typescript");
  await lspManager.didChange(WS1, join(WS1, "a.ts"), "const x = 2;\n", 2);
  await lspManager.didSave(WS1, join(WS1, "a.ts"), "const x = 2;\n");
  await lspManager.openDocument(WS1, join(WS1, "other.ts"), "typescript");
  await sleep(300);
  eq("同一工作区重复用不会起第二个进程", spawnedPids().length, 1);

  // 多工作区:各起一个(键是 workspace::language)。
  await lspManager.openDocument(WS2, join(WS2, "b.ts"), "typescript");
  await sleep(500);
  eq("第二个工作区另起一个进程", pidsFor("ts").length, 2);
  eq("两个都活着", pidsFor("ts").filter(alive).length, 2);

  // 另一个语言 —— 同一个工作区也要各起一个,但就到此为止。
  await lspManager.openDocument(WS1, join(WS1, "x.py"), "python");
  await sleep(500);
  same(
    "三个进程:typescript ×2 + python ×1(按语言分组)",
    runningByTag(["ts", "py"]),
    { ts: pidsFor("ts"), py: pidsFor("py") },
  );
  eq("typescript 起了 2 个", pidsFor("ts").length, 2);
  eq("python 起了 1 个", pidsFor("py").length, 1);
  eq(
    "list 说 typescript 与 python 都在跑",
    (await lspManager.list())
      .languages.filter((c) => c.running)
      .map((c) => c.language)
      .sort()
      .join(","),
    "python,typescript",
  );

  /* ── 关掉之后,进程真的没了吗 ──
   * 本套最要紧的一条:win32 上 server 是 shell:true 起的,proc 是 cmd.exe,
   * 真正干活的是**孙进程**。`handle.proc.kill()` 只带走 cmd.exe —— 而 LspManager
   * 自己在 killProbeTree 的注释里就写着这条规则。 */
  const tsBefore = pidsFor("ts");
  eq("关之前 typescript 那两个都活着", tsBefore.filter(alive).length, 2);

  await lspManager.toggle("typescript", false);
  await sleep(2000);
  eq(
    "关掉之后 list 说没在跑",
    (await lspManager.list()).languages.find((c) => c.language === "typescript")?.running,
    false,
  );
  same("typescript 的两个进程真的没了(没有孤儿等在那儿占内存)", tsBefore.filter(alive), []);
  eq("关掉 typescript 不影响 python(另一个语言那个还在跑)", pidsFor("py").filter(alive).length, 1);

  lspManager.disposeAll();
  await sleep(2000);
  same("disposeAll 之后一个都不剩", spawnedPids().filter(alive), []);
}

/* ─────────────────── 6b. 手动指定的路径里有空格 ─────────────────── */

console.log("\n§6b 手动指定一个路径里带空格的 server");

{
  // 「高级设置里自己填路径」是这套设置面板明说的用法,而**用户目录常带空格**
  // (`C:\Program Files\...` / `C:\Users\张三\...`)。win32 上 spawn 走了
  // `shell: true`,Node 把 `file` 与 `args` 直接拼成命令行交给 cmd.exe —— **不给
  // `file` 加引号**。于是带空格的路径在那里被切成两半,cmd 报「不是内部或外部命令」。
  //
  // 这一条**不**断言「能起来」(那取决于平台上怎么修),只断言用户会看到什么:
  // 必须**显式报错**,不允许静默地卡在「启动中」。这条断言钉的是那半边——
  // 哪怕这条路修不好,也不能变成一块哑掉的界面。
  clearBinaries();
  resetPidLog();
  resetSent();
  configure([{ language: "typescript", enabled: true, serverPath: SPACED_SERVER }]);

  const st = (await lspManager.list()).languages.find((c) => c.language === "typescript")!;
  eq("带空格的路径本身是存在的,所以算「找得到」", st.installed, true);
  eq("并且原样回显给界面(不偷偷改写用户填的路径)", st.serverPath, SPACED_SERVER);

  const r = (await call(IPC.LSP_REQUEST, {
    workspacePath: WS1,
    language: "typescript",
    method: "textDocument/hover",
    params: {},
  })) as { error?: { message: string } };

  if (r.error) {
    // 现在这条路上就是这个结果。
    check("起不来时给的是 error,而不是空的 result", true);
    check("错误里带着可读的原因", (r.error.message ?? "").length > 0, r.error);
    const stopped = lastEvent("stateChanged", { language: "typescript", workspacePath: WS1 });
    eq("工具栏不会停在「启动中」", (stopped?.payload as { phase?: string })?.phase, "stopped");
    // 这里两条**本来就不一样**,而且原因值得记下来:返回给调用方的是内部
    // 那句 `language server stopped`,推给界面的是 cmd.exe 的原始 stderr。
    // 所以只钉「界面不是空白的」—— 用户至少能看到发生了坏事。
    check(
      "推送里带着一条非空的失败原因(工具栏不会只剩一个「启动中」)",
      typeof (stopped?.payload as { error?: string })?.error === "string" &&
        ((stopped?.payload as { error?: string })?.error ?? "").length > 0,
      stopped?.payload,
    );
  } else {
    // 哪天这条路被修好了(比如改用 shell:false + .cmd),这条会亮 —— 那时
    // 把上面的分支删掉、改成断言「真的起来了」即可。现在它只是把「静默成功、
    // 实际没进程」这种最糟的情形挡在外面。
    check("路径带空格时**必须**要么真起来、要么显式报错(不能悄悄没反应)", false, {
      hint: "request 既没报错也没真的起进程?检查 spawnedPids()",
      pids: spawnedPids(),
    });
  }

  lspManager.disposeAll();
  await sleep(1500);
  const leftover = spawnedPids().filter(alive);
  same("这一段没留下进程(报错也没把半截进程丢下)", leftover, []);
}

/* ─────────────── 6d. 「重启」按钮:换一个、不留旧的 ─────────────── */

console.log("\n§6d 重启按钮:旧的收走、新的起来,不是一个变两个");

{
  // restart 是用户点「启动失败」通知之后按的那个按钮。它会先 removeServer
  // 再 ensureServer —— 如果 removeServer 收不掉旧进程,每点一次就多一个
  // server 常驻(用户会点几次,因为他正看着它失败)。
  clearBinaries();
  resetPidLog();
  resetSent();
  configure([{ language: "typescript", enabled: true, serverPath: GOOD_TS }]);

  await lspManager.openDocument(WS1, join(WS1, "a.ts"), "typescript");
  await sleep(400);
  const before = pidsFor("ts");
  eq("先起了一个", before.length, 1);

  // 走真 handler(不是直接调方法)—— 判据要住在用户点按钮时跑的那一行里。
  const r = (await call(IPC.LSP_RESTART, { workspacePath: WS1, language: "typescript" })) as {
    ok: boolean;
    error?: string;
  };
  eq("restart 报成功", r.ok, true);
  // ⚠️ taskkill 是**异步**的(它是另一个进程),所以「旧的死没死」要等一小会儿。
  // 等下这一秒不是给被测代码留余地 —— 是给 Windows 收尸留时间;真漏了的话
  // 一秒之后它还在,断言照样红。
  await sleep(1200);
  same("restart 之后旧的已经死了(不是新旧并排跑)", before.filter(alive), []);

  const after = pidsFor("ts");
  eq("而且只补了一个新的(不是一变二)", after.length, 2);
  eq("新的那个活着", after.filter(alive).length, 1);

  // 再按一次:仍然是「一个旧的走、一个新的来」,进程总数不再涨。
  const r2 = (await call(IPC.LSP_RESTART, { workspacePath: WS1, language: "typescript" })) as { ok: boolean };
  eq("再按一次也成功", r2.ok, true);
  await sleep(1200); // 同上:taskkill 是另一个进程,要等它落地
  eq("按两次重启也只有一个在跑(没有越点越多)", pidsFor("ts").filter(alive).length, 1);

  // 越界工作区:restart 不抛,而是折成 ok=false。
  const bad = (await call(IPC.LSP_RESTART, { workspacePath: WS_OUTSIDE, language: "typescript" })) as {
    ok: boolean;
    error?: string;
  };
  eq("越界的 restart 返回 ok=false 而不是抛", bad.ok, false);
  says("并说清原因", bad.error, "不是已知项目");

  lspManager.disposeAll();
  await sleep(1500);
  same("这一段收干净了", pidsFor("ts").filter(alive), []);
}

/* ─────────────── 6c. 退出时安装进程也要收走 ─────────────── */

console.log("\n§6c 退出时安装进程要一起收走");

{
  // `install` / `uninstall` 起的那个进程走的是**同一条** `shell: true` 的路,所以
  // 同样的规矩:`kill()` 只带走 cmd.exe 包装,真正的包管理器还在跑 —— 而它握着
  // 锁,下一次安装会撞上一个莫名其妙的 lock/EBUSY 错误。
  //
  // ⚠️ **这里不真装东西。** 规则明令不许往用户机器上装东西,而且 `npm i -g` 又慢
  // 又联网。做法和 §6 一样:在 PATH 最前面放一个假的 `npm` / `pip`(外壳是 `.cmd`
  // —— 和真的 npm 一样),它只记档、然后**挂住不退出**。真包管理器也是长跑的。
  const FAKE_BIN = join(FIX, "fakebin");
  mkdirSync(FAKE_BIN, { recursive: true });
  for (const name of ["npm", "pip", "go", "brew"]) {
    const stub = join(FAKE_BIN, `${name}.cmd`);
    // 标签故意带横线 —— 记档文件名的解析必须扛得住这一点。
    writeCmdShim(stub, [`"${process.execPath}" "${SLEEPER_JS}" install-${name} %*`]);
  }
  process.env.PATH = `${FAKE_BIN};${process.env.PATH}`;

  const installPids = () => pidsFor("install-npm");
  resetPidLog();

  const installing = lspManager.install("typescript"); // 不 await:它要跑很久
  await sleep(1200);
  const inst = installPids();
  eq("假包管理器真的被起过(这一节不是空跑)", inst.length, 1);
  eq("并且还活着", inst.filter(alive).length, 1);
  eq(
    "list 里 installing=true(界面会转圈)",
    (await lspManager.list()).languages.find((c) => c.language === "typescript")?.installing,
    true,
  );

  // 模拟退出 / 关掉应用。
  lspManager.disposeAll();
  await sleep(2000);
  same(
    "退出时安装进程被收走了 —— 不会留在那儿占着包管理器的锁",
    installPids().filter(alive),
    [],
  );

  void installing;
}

/* ─────────────────────────── 7. 起不来的时候 ─────────────────────────── *//* ─────────────────────────── 7. 起不来的时候 ─────────────────────────── */

console.log("\n§7 起不来:有限次重试 + 冷却,报出的次数要对得上");

{
  clearBinaries();
  rmSync(DEAD_LOG, { force: true });
  configure([{ language: "typescript", enabled: true, serverPath: DEAD_SERVER }]);

  const attempts = () =>
    existsSync(DEAD_LOG) ? readFileSync(DEAD_LOG, "utf8").trim().split("\n").filter(Boolean).length : 0;

  const messages: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await requestSafe(WS3, "typescript", "textDocument/hover", {});
    messages.push(r.error?.message ?? "");
    await sleep(500);
  }

  const tries = attempts();
  check(`起不来时尝试次数有限(实际 ${tries} 次,不是无限)`, tries > 0 && tries <= 4, { tries });
  const refused = messages.find((m) => m.includes("已暂停重试"));
  check("超过上限后明确说「已暂停重试」,不是继续闷头重试", !!refused, messages);
  says("拒绝里给了下一步", refused, "请修复环境后在设置中关闭再重新启用");

  // 用户会读到的那个数字必须和真实尝试次数对得上 —— 报 6 次而其实试了 3 次,
  // 用户会去查一个不存在的问题。
  const claimed = /连续启动失败 (\d+) 次/.exec(refused ?? "")?.[1];
  eq("报出的失败次数与真实 spawn 次数一致", claimed, String(tries));

  const stopped = lastEvent("stateChanged", { language: "typescript", workspacePath: WS3 });
  eq("拒绝也推到了界面(工具栏不会停在「启动中」)", (stopped?.payload as { phase?: string })?.phase, "stopped");
  says("界面看到的也是同一句", (stopped?.payload as { error?: string })?.error, "已暂停重试");

  // 用户按「重新启用」= 给他一次干净的机会(清掉冷却)。
  await lspManager.toggle("typescript", false);
  await lspManager.toggle("typescript", true);
  const afterRetry = await requestSafe(WS3, "typescript", "textDocument/hover", {});
  check("重新启用之后会真的再试一次(不再被冷却挡着)", !(afterRetry.error?.message ?? "").includes("已暂停重试"), afterRetry);
  await sleep(500);
}

/* ─────────────────────────── 8. 工作区边界 ─────────────────────────── */

console.log("\n§8 渲染端给的工作区路径必须落在已知项目里");

{
  clearBinaries();
  configure([{ language: "typescript", enabled: true, serverPath: GOOD_TS }]);
  const r = (await call(IPC.LSP_REQUEST, {
    workspacePath: WS_OUTSIDE,
    language: "typescript",
    method: "textDocument/hover",
    params: {},
  })) as { error?: { message: string } };
  says("不认识的工作区被拒", r.error?.message, "不是已知项目");
  check("拒绝带着可读的原因(不是被折成一个空对象)", (r.error?.message ?? "").length > 0, r);

  // didChange / didSave / closeDocument 走的是另一条守卫(文件也得在已知项目里)。
  const dc = await call(IPC.LSP_DID_CHANGE, {
    workspacePath: WS1,
    filePath: join(WS_OUTSIDE, "stray.ts"),
    text: "x",
    version: 1,
  });
  eq("文件在项目之外时 didChange 不抛到调用方(handler 吞掉)", dc, undefined);
}

/* ─────────────────────────── 9. 半截状态 / 错误路径 ─────────────────────────── */

console.log("\n§9 安装与路径那条路上的错误");

{
  clearBinaries();
  // 选了个压缩包 —— 非 Java 语言要的是可执行文件本身。
  const zip = join(FIX, "server.tar.gz");
  writeFileSync(zip, "");
  const r = (await call(IPC.LSP_INSTALL_FROM_FILE, { language: "typescript", archivePath: zip })) as {
    ok: boolean;
    error?: string;
  };
  eq("压缩包被拒", r.ok, false);
  says("说明要先解压再选可执行文件", r.error, "不支持压缩包");

  const missing = (await call(IPC.LSP_INSTALL_FROM_FILE, {
    language: "typescript",
    archivePath: join(FIX, "nope.exe"),
  })) as { ok: boolean; error?: string };
  eq("文件不存在时失败", missing.ok, false);
  says("报出的是哪个路径不存在", missing.error, "nope.exe");

  // 选对了可执行文件 —— 记成自定义路径并启用。
  const ok = (await call(IPC.LSP_INSTALL_FROM_FILE, { language: "typescript", archivePath: GOOD_TS })) as { ok: boolean };
  eq("选了可执行文件就成功", ok.ok, true);
  const st = (await lspManager.list()).languages.find((c) => c.language === "typescript")!;
  eq("并把路径记下来了", st.serverPath, GOOD_TS);
  eq("顺带启用了", st.enabled, true);

  // Java:这台机器上没有 `<userData>/lsp/java`,卸载是幂等的空操作而不是报错。
  const un = (await call(IPC.LSP_UNINSTALL, { language: "java" })) as { ok: boolean; error?: string };
  eq("Java 没装过时卸载是成功的空操作(幂等)", un.ok, true);

  // 再卸一次 —— 幂等就是做两遍也不会坏。
  const un2 = (await call(IPC.LSP_UNINSTALL, { language: "java" })) as { ok: boolean };
  eq("再卸一次仍然成功", un2.ok, true);
}

{
  // Java 的健康检查:先看 JDK,再看 equinox launcher jar。这台机器上是 Java 8,
  // 所以报的是 JDK 那条 —— 而那句话必须告诉用户「去哪儿指定」。
  const hc = (await call(IPC.LSP_HEALTH_CHECK, { language: "java" })) as { ok: boolean; error?: string };
  eq("Java 健康检查要求 JDK 17+", hc.ok, false);
  check(
    "错误里说清了要求(Java 17+)与去处(高级设置)",
    /Java\s*17\+|JDK\s*17\+/.test(hc.error ?? "") && (hc.error ?? "").includes("高级设置"),
    hc.error,
  );
}

/* ─────────────────────────── 10. 别的路径 ─────────────────────────── */

console.log("\n§10 别的路径");

{
  // prewarm:没有构建文件的非 Java 工作区不该烧掉一个 1GB 的 JVM。
  // 记档清零 —— 这一节数的是「**它自己**有没有乱起进程」,别把前面几段的
  // 残留算进来(那会让断言随段落顺序时绿时红)。
  resetPidLog();
  clearBinaries();
  configure([{ language: "java", enabled: true, serverPath: GOOD_TS }]);
  const notJava = await lspManager.prewarm(WS1); // WS1 里没有 pom.xml / build.gradle
  eq("纯文本工作区不预启动 Java", notJava.ok, true);
  eq("也**没有**真的起进程", spawnedPids().filter(alive).length, 0);

  // 越界工作区:prewarm 不抛,而是折成 ok=false。
  const bad = await lspManager.prewarm(WS_OUTSIDE);
  eq("越界工作区的 prewarm 返回 ok=false 而不是抛", bad.ok, false);
  says("并说清原因", bad.error, "不是已知项目");

  // 未启用的话,prewarm 也不该拿去当错误喊。
  configure([]);
  const dis = await lspManager.prewarm(WS1);
  eq("未启用时 prewarm 也是 ok=false", dis.ok, false);
}

{
  // toggle 的返回值就是 list 的内容 —— 界面点一次开关只走一个来回。
  clearBinaries();
  configure([]);
  const t = await lspManager.toggle("python", true);
  same("toggle 返回的四种语言齐了", t.languages.map((l) => l.language), ["typescript", "python", "go", "java"]);
  eq("开启状态写下去了", t.languages.find((l) => l.language === "python")?.enabled, true);
  const back = await lspManager.toggle("python", false);
  eq("关掉也写下去了", back.languages.find((l) => l.language === "python")?.enabled, false);
}

{
  // 用户手动指定一个**不存在**的路径 -> 不能当成找到了。
  clearBinaries();
  configure([{ language: "go", enabled: true, serverPath: join(FIX, "no-such-gopls.exe") }]);
  const st = (await lspManager.list()).languages.find((c) => c.language === "go")!;
  eq("指定了不存在的路径时,installed 仍然是 false(不会假装找到了)", st.installed, false);
  eq("serverPath 报 null,不把坏路径回显成可用的", st.serverPath, null);

  // 反过来:指定一个存在的路径就认。
  await lspManager.setPath("go", GOOD_TS);
  const st2 = (await lspManager.list()).languages.find((c) => c.language === "go")!;
  eq("指定了存在的路径就认", st2.serverPath, GOOD_TS);
  eq("仍然按 binaryNames 探过一遍(用户路径优先,但不跳过检测)", probed.length > 0, true);
}

/* ─────────────────────────── 11. 收尾守卫 ─────────────────────────── */

console.log("\n§11 守卫:断言没有空过");

{
  same("没有用到 lsp:event 以外的推送通道", otherChannels, []);

  // 假 server 必须真的被起过 —— 否则 §6 那些「真的起来了」全是空跑。
  // ⚠️ 查的是**只增不改**的账本(`LSP_SMOKE_SPAWN_LOG`),不是 pid 记档目录:
  // 后者每一段自己 reset 一次(§6b 起完就清),拿它当守卫会随着段落顺序
  // 时绿时红 —— 那就成了一个会撒谎的守卫。
  const spawnLog = existsSync(SPAWN_LOG) ? readFileSync(SPAWN_LOG, "utf8").trim() : "";
  check("假 server 真的被起过(§6 不是空跑)", spawnLog.length > 0, { tags: spawnLog.split("\n") });
  check(
    "「起不来」那条夹具真的被 spawn 过(§7 不是空跑)",
    existsSync(DEAD_LOG) && readFileSync(DEAD_LOG, "utf8").trim().length > 0,
  );

  // binaryResolve 桩必须真的被问过 —— 否则「找不到 server」那段可能是
  // 因为别的原因失败,而不是因为探测返回了 null。
  check("binaryResolve 桩真的被问过", probed.length > 0, { probed: probed.length });

  check("数据根指向临时目录(没碰用户的 mcode.db)", DATA.includes("mcode-lsp-data-"), DATA);
}

/* ─────────────────────────── 收尾 ─────────────────────────── */

lspManager.disposeAll();
await sleep(500);
killLeftovers();
await sleep(300);

rmSync(FIX, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
void setKnownRoots;

console.log(`\nlsp-smoke: ${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
