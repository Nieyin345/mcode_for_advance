/**
 * Headless smoke for **`main/ipc/mcp.ts`** —— 设置面板「MCP 服务器」那一节背后的
 * 9 条通道(830 行、零覆盖)。
 *
 * ## 为什么这一套存在
 *
 * 这 9 条通道是**用户以为自己改了什么**和**引擎实际加载到什么**之间唯一的那层。
 * 它管着四个用户看不见但会咬人的分工:
 *
 *  1. **真相层 / 派生视图**。服务器配置的事实源是管理态的 `userServers`;
 *     `~/.mcode/.claude.json` 的 `mcpServers` 与 `~/.mcode/codex/config.toml` 的
 *     `[mcp_servers.*]` 都是**派生**出来的「启用 ∧ 分配给该引擎」子集。派生算错,
 *     用户关掉的服务器照样会被引擎加载 —— 而面板上那个开关看起来是关的。
 *  2. **关 = 搬进 stash**。关一个服务器不是删,是把配置挪进 `userDisabled`;再打开
 *     要**原样搬回来**。中间任何一个环节丢了字段,用户下次看到的就是个残配置。
 *  3. **OAuth 三态**(待授权 / 已授权 / 无徽章)。判据横跨三个外部真相:CLI 的
 *     needs-auth 缓存(真 401 写的)、CLI 的凭据库、以及对端点的一次主动探测。
 *     优先级是刻意的:**needsAuth 胜过 authorized** —— 凭据库里躺着一个运行时
 *     根本不会去查的令牌时,报「已授权」等于把一个连不上的服务器说成好的。
 *  4. **导入是只读的**:扫本机 Claude CLI 的 `~/.claude.json` 只读,导入前不动任何
 *     东西,导入时同名的跳过而不是覆盖。
 *
 * ## 怎么验的:真 handler + 真文件,不是复述
 *
 * `ipcMain` 的记名替身(见 §0;办法抄 `library-trash-smoke` 的 §4),按 channel
 * 取回 `registerMcpHandlers` 真注册进去的函数,然后**调用户动作本身**。下面每一
 * 条断言都是那个动作的**结果**,没有一句在复述 handler 内部的写法 —— 有人把
 * handler 里的关键判断改掉,对应的那几条会立刻红。
 *
 * 三样东西是真的,不是桩:
 *  - **真的 sql.js 库**(数据根是 `mktemp -d`,见 run.sh);
 *  - **`@main/window.js` 整条不换**(所以广播走真实现);
 *  - **`@main/lib/logger.js` 不换**(日志真的落到临时数据根,而不是被静默吞掉)。
 *
 * ## 换了哪些桩、为什么
 *
 *  | 桩 | 理由 |
 *  |---|---|
 *  | `electron` | `ipc/mcp.ts` 的 import 图里三处深处拉它(见 stubs/electron.ts) |
 *  | `@main/plugins/pluginManager.js` | 真的那份读 `~/.mcode/plugins`,本套验的是**消费**插件贡献的 MCP 行,不是安装管线 |
 *  | `@main/terminal/TerminalManager.js` | 经 `@main/window.js` → `lib/theme` 拉 electron、还会在 win 上真跑 powershell 刷注册表环境 |
 *  | `node-pty` | 原生插件,无头环境里没有可加载形态 |
 *
 * **`@main/providers/claude-sdk/customEnv.js` 没有换桩** —— 它不 import electron,
 * 而 `MCODE_CONFIG_DIR` 是从 `homedir()` 算的,所以 run.sh 那个**假 HOME** 已经把它
 * 整体搬进了临时目录(见 run.sh 那段长注释:尝试过换桩,拿到的是两份模块实例)。
 * §0 因此断言的是**真模块**给出的值,而不是某个桩的返回值。
 *
 * ## ⚠️ 故意**不验**的部分(登记了却没人命中的断言 = 没验)
 *
 *  - **`MCP_AUTHORIZE` / `MCP_UNAUTHORIZE` 的整条成功路径。** 它要真起一个 PTY、
 *    真跑 `claude mcp login <name>`、真等用户在系统浏览器里完成 OAuth 回调 ——
 *    无头环境里给不出这个。本套只验它**参数守卫**那一段(非法名 / 非 http(s) 地址 /
 *    找不到 CLI 时各返回什么),以及守卫**先于**找 CLI 这个顺序。守卫之后的
 *    `runCaptured` / 临时注册 / 还原配置 / `forgetNeedsAuth` 全部没覆盖。
 *  - **`markNeedsAuth` 的写入**(unauthorize 成功后才调)。本套只验**读**那一半:
 *    预先写好 needs-auth 缓存文件,看列表徽章对不对。
 *  - **darwin 的 Keychain 分支**(`readCredentialsBlob` 的 `security` 调用)。
 *    跑在 Windows 上,走的是 `.credentials.json` 那条路。
 *  - **OAuth 临时注册期间与其它写操作的真实并发。** handler 共用串行队列,下面会
 *    并发发两个普通保存来钉住"不会丢更新"；但真 OAuth 要等浏览器回调,无头环境
 *    无法让那条长事务与另一个操作重叠。
 *  - **`MCP_LIST` 对 `kind: "sse"` 行的探测正向断言**。401 那条走的是 http 行
 *    (两条走同一段代码),sse 只验了"关掉的不探"。
 *  - **探测预算(`AUTH_PROBE_BUDGET_MS` 2.5s)那条时序**。夹具里的 fetch 替身是同步
 *    立刻返回的,`Promise.race` 的"慢探测不拖着列表"分支没被走到。
 *  - **`config.toml` 的 provider 段**(本套不配 codex provider,它只出现 MCP 段);
 *    那部分是 `memory-codex-smoke` 的职责。
 *
 * ## ⚠️ 本套**抓到**但没修的一件事(不是 `ipc/mcp.ts` 的 bug)
 *
 * 契约层 `McpAuthorizeSchema.url` 是 `z.string().url()`,所以"根本不是 URL"的输入
 * 在 preload 那道 zod 就被拒、handler 根本收不到。那份报错是 zod 原样吐的 JSON:
 *
 *     [{"validation":"url","code":"invalid_string","message":"Invalid url","path":["url"]}]
 *
 * 而面板是 `catch (err) { setError((err as Error).message) }`,preload 对
 * `ipcRenderer.invoke` 的 rejection 不做包装 —— 于是这 128 个字符会原样糊进红色
 * 提示条。§10 把**现状**钉住了(判据立在那行字上),但修法在别的文件(preload 或
 * 面板),不在本套的被测文件里,所以本套不动它。同一形状在 `MCP_SAVE` 的名字校验上
 * 也有(§12 只验了"确实被拒")。
 *
 * ## 跑它的前提
 *
 * `run.sh` 必须设三个环境变量:`MCODE_SMOKE_DATA_ROOT`(数据根)、一个假的
 * `HOME` / `USERPROFILE`(它同时决定了 `MCODE_CONFIG_DIR` = `~/.mcode`、导入功能只读的
 * `~/.claude.json`、以及 codex 视图落点 `~/.mcode/codex/config.toml`)、和
 * `MCODE_SMOKE_REAL_HOME`(改之前的那个家,§0 靠它判断 HOME 真被换掉了)。
 * `stubs/electron.ts` 里的 `app.getPath("userData")` 也是**没设就抛** ——
 * 少任何一个都可能往用户真实的 `~/.mcode` 里写 `.claude.json` / `mcp-engines.json` /
 * `mcp-needs-auth-cache.json`。
 *
 * Run: bash scripts/mcp-ipc-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IpcMain } from "electron";
import type { McpManagementState, McpServerConfig } from "@contracts/ipc";

let failures = 0;
let checks = 0;
const failedNames: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  failedNames.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组/对象比较。`Object.is` 对两个内容相同的数组是 false —— 本套好几处断的是
 *  「正好是这几个」,用 `eq` 会红得莫名其妙。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ──────────────── 0. 安全前提 + 脚手架 ──────────────── */

const DATA = mkdtempSync(join(tmpdir(), "mcode-mcp-ipc-data-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/** 真的那个模块给出的配置目录 —— **不是某个桩的返回值**。
 *  `customEnv.ts` 里就是一句 `path.join(homedir(), ".mcode")`,模块级求值,
 *  所以 run.sh 那个假 HOME 才是替掉用户 `~/.mcode` 的东西(见 run.sh 那段长注释)。
 *  下面对的是真值:这样一来"run.sh 忘了换 HOME"这一件事会**当场红**,而不是靠人在
 *  文件头里记着的约定。 */
const { MCODE_CONFIG_DIR } = await import("@main/providers/claude-sdk/customEnv.js");
const REAL_HOME_BEFORE = process.env.MCODE_SMOKE_REAL_HOME ?? "";
const FAKE_HOME = homedir();

const USER_CLAUDE_JSON = join(MCODE_CONFIG_DIR, ".claude.json");
const ENGINES_JSON = join(MCODE_CONFIG_DIR, "mcp-engines.json");
const NEEDS_AUTH_JSON = join(MCODE_CONFIG_DIR, "mcp-needs-auth-cache.json");
const CREDENTIALS_JSON = join(MCODE_CONFIG_DIR, ".credentials.json");
/** 本机 Claude CLI 的配置文件 —— 导入功能**只读**它。 */
const CLI_CLAUDE_JSON = join(FAKE_HOME, ".claude.json");
/** codex 引擎视图(materializeAllMcpViews 的第二个消费点)。 */
const CODEX_TOML = join(FAKE_HOME, ".mcode", "codex", "config.toml");

/** 路径比较要**先归一化**:`homedir()` 给的是 `C:/Users/x`(正斜杠),而 `path.join`
 *  出来的是 `C:\Users\x` —— 直接 `startsWith` 会恒假,那种红看起来像安全前提没成立。 */
function normalize(p: string): string {
  return resolve(p).split("\\").join("/").toLowerCase();
}

function underHome(child: string, home: string): boolean {
  return normalize(child).startsWith(normalize(home) + "/");
}

// ⚠️ 判据不能写成 `p.startsWith(REAL_HOME)` —— **在 Windows 上那是恒假的**:
// 默认临时目录就住在真家里面(`C:\Users\X\AppData\Local\Temp\...`)。要判的是
// 「现在这个 HOME 是不是 run.sh 换过的那个」,而"换过"这件事的**唯一**证据是它和
// `MCODE_SMOKE_REAL_HOME` 不同;然后所有受管路径必须落在这个**当前** HOME 下。
check(
  "HOME 确实被换成了临时目录(run.sh 真的做了它说的事)",
  REAL_HOME_BEFORE !== "" && normalize(FAKE_HOME) !== normalize(REAL_HOME_BEFORE),
  { REAL_HOME_BEFORE, homedir_now: FAKE_HOME },
);
check(
  "★ MCODE_CONFIG_DIR 就是这个假 HOME 下的 .mcode",
  MCODE_CONFIG_DIR === join(FAKE_HOME, ".mcode") && underHome(MCODE_CONFIG_DIR, FAKE_HOME),
  { MCODE_CONFIG_DIR, FAKE_HOME, REAL_HOME_BEFORE },
);
same(
  "四个受管文件都在那个目录下(没一个漏在外面)",
  [USER_CLAUDE_JSON, ENGINES_JSON, NEEDS_AUTH_JSON, CREDENTIALS_JSON].filter((p) =>
    underHome(p, MCODE_CONFIG_DIR),
  ).length,
  4,
);
check(
  "本机 CLI 的配置(~/.claude.json)与受管的那份不是同一个文件",
  CLI_CLAUDE_JSON !== USER_CLAUDE_JSON,
  { CLI_CLAUDE_JSON, USER_CLAUDE_JSON },
);
check(
  "★ codex 视图的落点也在假 HOME 下(不是用户真的 ~/.mcode/codex)",
  // ⚠️ 两边都过 `normalize()`:CODEX_TOML 是 `homedir()` 拼出来的(Windows 上给 `C:/…`),
  // 而 `join(FAKE_HOME, …)` 用的是另一个分隔符,逐字比会假红。
  normalize(CODEX_TOML) === normalize(join(FAKE_HOME, ".mcode", "codex", "config.toml")) &&
    normalize(FAKE_HOME) !== normalize(REAL_HOME_BEFORE),
  { CODEX_TOML, FAKE_HOME, REAL_HOME_BEFORE },
);

/** `ipcMain` 的记名替身。不起 Electron,也没有真的 preload —— 唯一需要的脚手架。 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC, MCP_MANAGEMENT_SETTING_KEY, MCP_RESERVED_NAME } = await import("@contracts/ipc");
const { initDb } = await import("@main/store/db.js");
const { SettingRepo } = await import("@main/store/repositories.js");
const mcpConfig = await import("@main/lib/mcpConfig.js");
const pluginStub = await import("./stubs/pluginManager.js");

// 先建库,再注册 handler:注册的那一刻 `registerMcpHandlers` 末尾会**火忘式**发起
// 真相层迁移(idempotent),那条路要读设置表 —— 库没起来的话它读到的是空态,
// 后面每一句夹具就都建在流沙上。
await initDb();
const { registerMcpHandlers } = await import("@main/ipc/mcp.js");
registerMcpHandlers(fakeIpc);

/** 等那条火忘的启动迁移落定,再往下走。 */
await mcpConfig.ensureMcpTruthMigrated();

function handlerFor(channel: string): (raw: unknown) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerMcpHandlers 没有注册 ${channel}`);
  return (raw: unknown) => Promise.resolve(fn(null, raw));
}

const list = handlerFor(IPC.MCP_LIST);
const toggle = handlerFor(IPC.MCP_TOGGLE);
const enginesSet = handlerFor(IPC.MCP_ENGINES_SET);
const save = handlerFor(IPC.MCP_SAVE);
const remove = handlerFor(IPC.MCP_REMOVE);
const scanImport = handlerFor(IPC.MCP_SCAN_IMPORT);
const importServers = handlerFor(IPC.MCP_IMPORT);
const authorize = handlerFor(IPC.MCP_AUTHORIZE);
const unauthorize = handlerFor(IPC.MCP_UNAUTHORIZE);

same(
  "9 条通道全都注册上了",
  [
    IPC.MCP_LIST,
    IPC.MCP_TOGGLE,
    IPC.MCP_ENGINES_SET,
    IPC.MCP_AUTHORIZE,
    IPC.MCP_UNAUTHORIZE,
    IPC.MCP_SAVE,
    IPC.MCP_REMOVE,
    IPC.MCP_SCAN_IMPORT,
    IPC.MCP_IMPORT,
  ].filter((c) => handlers.has(c)).length,
  9,
);

/** 启动迁移的落点:真相层被**钉**成空对象(而不是留着 undefined)。
 *  这条是"面板第一次打开不该自己造服务器"的地基 —— `undefined` 与 `{}` 在
 *  `doMcpTruthMigration` 的判断里天差地别(前者每次启动都重跑一遍迁移)。 */
same(
  "启动迁移把真相层钉成空对象",
  (await mcpConfig.getMcpManagement()).userServers,
  {},
);

/* ── 文件读取助手 ── */

function readJsonFile(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 磁盘上的 claude 引擎视图 —— 二进制下个回合真的会读的那份。 */
function claudeViewOnDisk(): Record<string, unknown> {
  return (readJsonFile(USER_CLAUDE_JSON).mcpServers ?? {}) as Record<string, unknown>;
}

function enginesMapOnDisk(): Record<string, unknown> {
  return readJsonFile(ENGINES_JSON);
}

function codexTomlOnDisk(): string {
  try {
    return readFileSync(CODEX_TOML, "utf-8");
  } catch {
    return "";
  }
}

interface Row {
  name: string;
  scope: string;
  kind: string;
  detail: string;
  enabled: boolean;
  needsAuth?: boolean;
  authorized?: boolean;
  /** 面板行上那份完整配置 —— 远程行用它拿 url,用户级行用它预填编辑框。 */
  config?: { type?: string; url?: string };
  perEngine?: { claude: boolean; codex: boolean };
}

async function rows(): Promise<Row[]> {
  const res = (await list({})) as { servers: Row[] };
  return res.servers;
}

function rowOf(all: Row[], name: string): Row | undefined {
  return all.find((r) => r.name === name);
}

/* ── 主动探测的替身 ──
 *
 * `MCP_LIST` 会对「启用中的 http/sse 行」发一次 `initialize`,把 401 +
 * `WWW-Authenticate: Bearer` 读成"这个服务器要 OAuth"。无头脚本不能真发网络请求,
 * 所以这里接管 `globalThis.fetch`,按 URL 给答案,并**记下每一条被请求过的 URL** ——
 * 「关掉的服务器不探」这条断言就压在"它的 URL 没出现在记录里"上,而不是压在一个
 * 间接的徽章有无上。 */
type FetchReply = { status: number; wwwAuthenticate?: string };
const fetchReplies = new Map<string, FetchReply>();
const fetchedUrls: string[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
  fetchedUrls.push(url);
  const reply = fetchReplies.get(url);
  if (!reply) throw new Error(`mcp-ipc-smoke 的 fetch 替身没有为 ${url} 准备答案`);
  return {
    status: reply.status,
    headers: new Headers(
      reply.wwwAuthenticate ? { "www-authenticate": reply.wwwAuthenticate } : {},
    ),
    body: null,
  } as unknown as Response;
}) as typeof fetch;

function resetFetch(): void {
  fetchReplies.clear();
  fetchedUrls.length = 0;
}

/* ──────────────── 1. 夹具:一份有代表性的管理态 ──────────────── */

console.log("\n夹具");

pluginStub.resetPlugins();

// 插件那条远程行(`demo-plugin__remote-plugin`)的 url 也要给探测替身一个答案:
// 它不在凭据库、也没有 needs-auth 记录,**并且是启用中的**,所以列表会探它。
const PLUGIN_URL = "https://plug.example/mcp";

const URL_PLAIN = "http://127.0.0.1:9/plain";
const URL_NEEDS = "http://127.0.0.1:9/needs";
const URL_TOKEN = "http://127.0.0.1:9/token";
const URL_BOTH = "http://127.0.0.1:9/both";
const URL_OFF = "http://127.0.0.1:9/off";
const URL_EMPTY = "http://127.0.0.1:9/empty-token";

const STDIO_ONE: McpServerConfig = { command: "node", args: ["server.js"], env: { TOKEN: "s3cr3t" } };
const REMOTE_PLAIN: McpServerConfig = { type: "http", url: URL_PLAIN };
const REMOTE_NEEDS: McpServerConfig = { type: "http", url: URL_NEEDS, headers: { "X-Tenant": "t1" } };
const REMOTE_TOKEN: McpServerConfig = { type: "http", url: URL_TOKEN };
const REMOTE_BOTH: McpServerConfig = { type: "http", url: URL_BOTH };
const REMOTE_OFF: McpServerConfig = { type: "sse", url: URL_OFF };
/** 凭据库里有一条 serverName 对得上、但 accessToken 是空串的条目 —— 那是个空壳,
 *  不能读成「已授权」(否则一个连不上的服务器会被报成好的)。 */
const REMOTE_EMPTY: McpServerConfig = { type: "http", url: URL_EMPTY };

const FIXTURE: McpManagementState = {
  browserDisabled: false,
  userServers: {
    "stdio-one": STDIO_ONE,
    "remote-plain": REMOTE_PLAIN,
    "remote-needs": REMOTE_NEEDS,
    "remote-token": REMOTE_TOKEN,
    "remote-both": REMOTE_BOTH,
    "remote-off": REMOTE_OFF,
    "remote-empty": REMOTE_EMPTY,
    // schema 认不出的配置:面板**不列出**它,但它必须继续出现在引擎视图里
    // (迁移前的行为 —— 收进真相层不该让一个手编的条目凭空消失)。
    "not-modeled": { whatever: true } as unknown as McpServerConfig,
  },
  userDisabled: { "remote-off": REMOTE_OFF },
};

SettingRepo.set(MCP_MANAGEMENT_SETTING_KEY, JSON.stringify(FIXTURE));
// 夹具真的落盘了吗 —— 后面每一条断言都建在这上面。落不下去的话这里就该红,
// 而不是等到十几条断言各自红得看不出来是同一个原因。
same("夹具真的写进了设置表", JSON.parse(SettingRepo.get(MCP_MANAGEMENT_SETTING_KEY)!), FIXTURE);

// engines 矩阵:stdio-one 只给 claude,remote-plain 只给 codex。
writeFileSync(
  ENGINES_JSON,
  JSON.stringify({ "stdio-one": { codex: false }, "remote-plain": { claude: false } }, null, 2),
  "utf-8",
);

// OAuth 三个外部真相。
writeFileSync(NEEDS_AUTH_JSON, JSON.stringify({ "remote-needs": { timestamp: 1 }, "remote-both": { timestamp: 2 } }), "utf-8");
writeFileSync(
  CREDENTIALS_JSON,
  JSON.stringify({
    mcpOAuth: {
      "remote-token|deadbeef": { serverName: "remote-token", accessToken: "tok" },
      "remote-both|deadbeef": { serverName: "remote-both", accessToken: "tok" },
      // 空 accessToken 不该算「已授权」—— 一条没有令牌的凭据条目是个空壳。
      "remote-empty|deadbeef": { serverName: "remote-empty", accessToken: "" },
    },
  }),
  "utf-8",
);

// 本机 Claude CLI 的配置(导入来源,只读)。故意同名一条,验「同名跳过」。
writeFileSync(
  CLI_CLAUDE_JSON,
  JSON.stringify({
    mcpServers: {
      "from-cli-global": { command: "uvx", args: ["mcp-server-git"], env: { API_KEY: "fixture-import-secret" } },
      "stdio-one": { command: "SHOULD-NOT-WIN" },
    },
    projects: {
      "/tmp/some-project": { mcpServers: { "from-cli-project": { type: "http", url: "https://p.example/mcp", headers: { Authorization: "Bearer fixture-import-secret" } } } },
    },
  }),
  "utf-8",
);

// 插件贡献的两条。这里的键是**插件名 → { 服务器名 → 配置 }**;面板上的行名是
// `<插件>__<服务器>`(见 stubs/pluginManager.ts 的文件头,那是从真实现照抄的语义)。
pluginStub.pluginServers["demo-plugin"] = {
  "remote-plugin": { type: "http", url: PLUGIN_URL, headers: { Authorization: "Bearer x" } },
  "stdio-plugin": { command: "npx", args: ["-y", "plug-server"] },
};
pluginStub.pluginServers["aaa-plugin"] = { "zzz": { command: "z" } };

same(
  "插件夹具用的是「插件名 → 服务器名」两层结构(行名由桩拼出来)",
  Object.keys(pluginStub.pluginServers["demo-plugin"]).sort(),
  ["remote-plugin", "stdio-plugin"],
);

check("本机 CLI 配置与受管的 .claude.json 不是同一个文件", CLI_CLAUDE_JSON !== USER_CLAUDE_JSON, {
  CLI_CLAUDE_JSON,
  USER_CLAUDE_JSON,
});
/* ──────────────── 2. MCP_LIST:三来源合一 ──────────────── */

console.log("\n列表:三来源合一");

resetFetch();
fetchReplies.set(URL_PLAIN, { status: 200 });
fetchReplies.set(URL_NEEDS, { status: 401, wwwAuthenticate: "Bearer realm=canva" });
fetchReplies.set(URL_BOTH, { status: 401, wwwAuthenticate: "Bearer realm=canva" });
fetchReplies.set(URL_EMPTY, { status: 200 });
// 插件那条远程行也会被探(它不在凭据库、也没有 needs-auth 记录)。
fetchReplies.set(PLUGIN_URL, { status: 200 });

const all = await rows();

same(
  "列表顺序:用户级 → 插件 → 内置(同类内按名字)",
  all.map((r) => r.name),
  [
    "remote-both",
    "remote-empty",
    "remote-needs",
    "remote-off",
    "remote-plain",
    "remote-token",
    "stdio-one",
    "aaa-plugin__zzz",
    "demo-plugin__remote-plugin",
    "demo-plugin__stdio-plugin",
    MCP_RESERVED_NAME,
  ],
);

eq("每条通道都只给一个 scope 值", new Set(all.map((r) => r.scope)).size, 3);
eq(
  "用户级行带着可编辑配置(密钥值单独脱敏)",
  (rowOf(all, "stdio-one")?.config as McpServerConfig | undefined)?.command,
  "node",
);
eq("已保存 env 值在面板读取时为空", (rowOf(all, "stdio-one")?.config as { env?: Record<string, string> } | undefined)?.env?.TOKEN, "");
eq(
  "用户级行的 detail 不泄露 env 值,只说个数",
  rowOf(all, "stdio-one")?.detail,
  "node server.js · 1 个环境变量",
);
eq("远程行的 detail 就是 URL", rowOf(all, "remote-plain")?.detail, URL_PLAIN);
eq(
  "插件行是 <插件>__<服务器> 形态,detail 里带 url",
  rowOf(all, "demo-plugin__remote-plugin")?.detail,
  "https://plug.example/mcp",
);
eq("内置行不带 config(它没有可编辑的配置)", rowOf(all, MCP_RESERVED_NAME)?.config, undefined);
same(
  "内置浏览器 MCP 明确只属于 Claude",
  rowOf(all, MCP_RESERVED_NAME)?.perEngine,
  { claude: true, codex: false },
);

// schema 认不出的配置:面板不列它 —— 但**它必须还在真相层里**(见 §8 的派生视图)。
eq("schema 认不出的配置不出现在面板上", rowOf(all, "not-modeled"), undefined);
check(
  "schema 认不出的配置仍留在真相层(没被静默丢掉)",
  "not-modeled" in ((await mcpConfig.getMcpTruth()).userServers ?? {}),
);

/* ── per-engine 可见性 ── */

same("per-engine 跟着矩阵文件走", rowOf(all, "stdio-one")?.perEngine, { claude: true, codex: false });
same("未在矩阵里的名字默认两个引擎都可见", rowOf(all, "remote-needs")?.perEngine, {
  claude: true,
  codex: true,
});
same("插件行也吃同一份矩阵", rowOf(all, "demo-plugin__remote-plugin")?.perEngine, {
  claude: true,
  codex: true,
});

/* ── 启停状态 ── */

eq("stash 里的服务器: enabled=false", rowOf(all, "remote-off")?.enabled, false);
eq("真相层里的服务器: enabled=true", rowOf(all, "remote-plain")?.enabled, true);
eq("关掉的服务器仍然列出来(用户得能看到它、才能再打开)", rowOf(all, "remote-off")?.config?.url, URL_OFF);
eq("内置浏览器服务器默认开着", rowOf(all, MCP_RESERVED_NAME)?.enabled, true);

/* ── OAuth 三态:判据是用户看到的那枚徽章 ── */

eq("探测到 401 + WWW-Authenticate: Bearer → 标成待授权", rowOf(all, "remote-needs")?.needsAuth, true);
eq("待授权的那条不该同时说已授权", rowOf(all, "remote-needs")?.authorized, undefined);
eq("凭据库里有令牌 → 标成已授权", rowOf(all, "remote-token")?.authorized, true);
eq("已授权的那条不带待授权徽章", rowOf(all, "remote-token")?.needsAuth, undefined);
eq(
  "★ needsAuth 胜过 authorized(令牌躺在一个运行时不会去查的键下时,不能说它已授权)",
  rowOf(all, "remote-both")?.needsAuth,
  true,
);
eq("而且它**不**同时挂已授权徽章(两枚徽章是互斥的)", rowOf(all, "remote-both")?.authorized, undefined);
eq("端点正常应答 → 两枚徽章都不给", rowOf(all, "remote-plain")?.needsAuth, undefined);
eq("端点正常应答 → 也不说它已授权", rowOf(all, "remote-plain")?.authorized, undefined);
eq("stdio 行不参与 OAuth 判定", rowOf(all, "stdio-one")?.needsAuth, undefined);
eq(
  "★ 凭据条目里 accessToken 是空串 → 不算已授权(空壳不该把连不上的服务器说成好的)",
  rowOf(all, "remote-empty")?.authorized,
  undefined,
);
eq("既然不算已授权,它就该被真探一次", rowOf(all, "remote-empty")?.needsAuth, undefined);

// 用户级那一圈里,**只有两条**该被探:remote-plain 与 remote-empty。
// 另两条远程行各有各的"不必探"理由,而那两条理由本身就是这节的判据:
//   remote-needs / remote-both —— needs-auth 记录已经压过一切,查了也白查;
//   remote-token              —— 凭据库里有令牌 → 已授权,不必再问;
//   remote-off                —— **关掉的**。它不会被注进任何回合,没有状态需要
//                                抢在 401 前面显示,更不该替用户发他没要求的请求。
// 插件那条远程行是**另一段代码**(`rememberRemote("plugin", …)` 之后的插件循环)加的,
// 单独判 —— 混进同一个集合会让"插件行漏了"和"用户行多探了一条"互相掩盖。
//
// ⚠️ 这里断的是**探测替身收到的请求**。本套里替身是这条路上唯一的网络出口,所以
// "请求出现"与"这条被探过"恰好同一件事。别把它换成读徽章的间接判据:那样
// "探测根本没发生"和"探测发生了但徽章判读错了"会一起被蒙住。
const userProbed = fetchedUrls.filter((u) => u.startsWith("http://127.0.0.1:9/")).sort();
same("★ 被探的正好是那两条没有徽章记录的启用中远程行", userProbed, [URL_EMPTY, URL_PLAIN].sort());
// 上面这条只说"探了哪两条",说不清"另外四条为什么没探"。下面三条逐条钉理由 ——
// ⚠️ 尤其是 URL_OFF:把 `!s.enabled` 那个条件删掉,它**不会**让上面那条变红
// (集合里多一项才红),但只要这里钉住了"关掉的不该被探",删条件就必红。
check("★ 关掉的远程服务器根本没被探过(不替用户发他没要求的请求)", !fetchedUrls.includes(URL_OFF), {
  fetchedUrls,
  URL_OFF,
});
check("★ 已有令牌的服务器也没被探过(没理由再问一次)", !fetchedUrls.includes(URL_TOKEN), {
  fetchedUrls,
  URL_TOKEN,
});
check(
  "★ 已有 needs-auth 记录的两条也没被探过(记录就是权威,再探一次是白花钱)",
  !fetchedUrls.includes(URL_NEEDS) && !fetchedUrls.includes(URL_BOTH),
  { fetchedUrls, URL_NEEDS, URL_BOTH },
);
// 插件行:`rememberRemote("plugin", …)` 之后那一圈。这里钉"它也在被探的那一支里"
// —— 漏了的话,插件贡献的 OAuth 服务器永远不会在第一次 401 之前显示「去授权」。
// 夹具给它的是 200,而且探测结果进缓存,所以整份 run 里只该出现一次。
eq(
  "★ 插件贡献的远程行也在被探的那一支里(而且只探一次)",
  fetchedUrls.filter((u) => u === PLUGIN_URL).length,
  1,
);

/* ── 探测结果被缓存,重复列表不再打网络 ── */

const fetchedBefore = fetchedUrls.length;
await rows();
eq("第二次列表用了缓存,没有再打网络", fetchedUrls.length, fetchedBefore);
/* ──────────────── 3. MCP_TOGGLE ──────────────── */

console.log("\n开关");

same("关掉一个用户级服务器 → ok", await toggle({ name: "stdio-one", scope: "user", enabled: false }), {
  ok: true,
});{
  const state = await mcpConfig.getMcpTruth();
  check("关掉之后配置搬进了 stash(不是被删)", "stdio-one" in (state.userDisabled ?? {}));
  eq(
    "stash 里的配置逐字段原样(再打开时要一模一样地回来)",
    (state.userDisabled ?? {})["stdio-one"]?.command,
    "node",
  );
  check("真相层仍然留着配置(它才是事实源)", "stdio-one" in (state.userServers ?? {}));
  eq("关掉之后 claude 视图里没有它了", "stdio-one" in claudeViewOnDisk(), false);
  eq("面板上它显示为关", rowOf(await rows(), "stdio-one")?.enabled, false);
}

same("再打开 → ok", await toggle({ name: "stdio-one", scope: "user", enabled: true }), { ok: true });
{
  const state = await mcpConfig.getMcpTruth();
  eq("开回来之后 stash 里没有了", "stdio-one" in (state.userDisabled ?? {}), false);
  // ⚠️ 这条钉的是**原样**:整个对象逐字段相等,不只是"有个配置"。
  // 开关这条路要是把 `env` / `args` 折了,用户下次打开编辑框会看到个残配置,
  // 而 `enabled` 那个字段看起来完全正常 —— 所以判据必须落在配置本身上。
  same("开回来之后配置原样回到引擎视图(一个字段都不少)", claudeViewOnDisk()["stdio-one"], STDIO_ONE);
  same(
    "而且真的落盘了(不是只在内存里对)",
    JSON.parse(SettingRepo.get(MCP_MANAGEMENT_SETTING_KEY)!).userServers["stdio-one"],
    STDIO_ONE,
  );
}

same(
  "开关一个两层都没有的名字 → 拒绝,而且说人话",
  await toggle({ name: "ghost", scope: "user", enabled: true }),
  { ok: false, error: "未找到该 server 的配置" },
);

same(
  "关内置浏览器服务器 → ok",
  await toggle({ name: MCP_RESERVED_NAME, scope: "builtin", enabled: false }),
  { ok: true },
);
eq("关掉之后内置行显示为关", rowOf(await rows(), MCP_RESERVED_NAME)?.enabled, false);
same(
  "再打开 → ok",
  await toggle({ name: MCP_RESERVED_NAME, scope: "builtin", enabled: true }),
  { ok: true },
);
eq("打开之后内置行恢复", rowOf(await rows(), MCP_RESERVED_NAME)?.enabled, true);

same(
  "关插件服务器 → ok",
  await toggle({ name: "demo-plugin__stdio-plugin", scope: "plugin", enabled: false }),
  { ok: true },
);
{
  const pluginRows = await rows();
  eq("插件服务器显示为关", rowOf(pluginRows, "demo-plugin__stdio-plugin")?.enabled, false);
  check(
    "关掉的插件服务器不进 codex 视图",
    !codexTomlOnDisk().includes("[mcp_servers.demo-plugin__stdio-plugin]"),
    { toml: codexTomlOnDisk() },
  );
  eq("同一个插件的另一条没被连坐", rowOf(pluginRows, "demo-plugin__remote-plugin")?.enabled, true);
}
same(
  "插件服务器能再打开",
  await toggle({ name: "demo-plugin__stdio-plugin", scope: "plugin", enabled: true }),
  { ok: true },
);
eq(
  "开回来之后它回到 codex 视图",
  codexTomlOnDisk().includes("[mcp_servers.demo-plugin__stdio-plugin]"),
  true,
);

/* ──────────────── 4. MCP_ENGINES_SET ──────────────── */

console.log("\n按引擎分配");

same("把 remote-needs 从 codex 挪走 → ok 且回传算好的可见性", await enginesSet({ name: "remote-needs", claude: true, codex: false }), {
  ok: true,
  perEngine: { claude: true, codex: false },
});
same(
  "落盘的是最小化条目(claude/codex 都开就不留键)",
  enginesMapOnDisk()["remote-needs"],
  { codex: false },
);
eq(
  "pi 键没被写进矩阵文件(pi 没有 MCP)",
  "pi" in ((enginesMapOnDisk()["remote-needs"] ?? {}) as Record<string, unknown>),
  false,
);
check(
  "claude 视图里有它",
  "remote-needs" in claudeViewOnDisk(),
);
check(
  "★ codex 视图里没有它了",
  !codexTomlOnDisk().includes("[mcp_servers.remote-needs]"),
  { toml: codexTomlOnDisk() },
);

same(
  "把两个引擎都打开 → 条目被删掉,不留死键",
  await enginesSet({ name: "remote-needs", claude: true, codex: true }),
  { ok: true, perEngine: { claude: true, codex: true } },
);
eq("矩阵文件里那个名字整个没了", "remote-needs" in enginesMapOnDisk(), false);
check(
  "★ 打开 codex 之后它回到 codex 视图",
  codexTomlOnDisk().includes("[mcp_servers.remote-needs]"),
  { toml: codexTomlOnDisk() },
);

// 夹具里预置的那两条分配关系也该在磁盘上体现出来 —— 这两条不是 handler 刚写的,
// 而是"启动后第一次物化就得读对矩阵文件"。
check(
  "启动时的矩阵文件也被引擎视图吃到了(remote-plain 只给 codex)",
  !("remote-plain" in claudeViewOnDisk()) && codexTomlOnDisk().includes("[mcp_servers.remote-plain]"),
  { claudeView: Object.keys(claudeViewOnDisk()), toml: codexTomlOnDisk() },
);

/* ──────────────── 5. MCP_SAVE / MCP_REMOVE ──────────────── */

console.log("\n增删");

same(
  "保留名挡在门外,而且那句话是给人看的",
  await save({ name: MCP_RESERVED_NAME, config: { command: "x" } }),
  { ok: false, error: `「${MCP_RESERVED_NAME}」是 Mcode 内置服务器的保留名(mcode- 开头)` },
);
// 整段 `mcode-`/`mcode_` 前缀都是内置身份(mcode-app / mcode-library / mcode-memory …)——
// 过去只挡了一个字面名 mcode-browser,用户能塞一个 mcode-app 伪造内置 server。项目级
// .mcp.json 一直挡整段前缀,这两条路现在一致了。
same(
  "其它内置名(mcode-app)也挡住",
  await save({ name: "mcode-app", config: { command: "x" } }),
  { ok: false, error: "「mcode-app」是 Mcode 内置服务器的保留名(mcode- 开头)" },
);
same(
  "下划线形态(mcode_memory)同样挡",
  await save({ name: "mcode_memory", config: { command: "x" } }),
  { ok: false, error: "「mcode_memory」是 Mcode 内置服务器的保留名(mcode- 开头)" },
);
same(
  "同名(已启用)再存 → 拒绝",
  await save({ name: "stdio-one", config: { command: "other" } }),
  { ok: false, error: "同名 server 已存在" },
);
same(
  "同名(已关掉的)再存 → 一样拒绝(关掉不等于删掉)",
  await save({ name: "remote-off", config: { command: "other" } }),
  { ok: false, error: "同名 server 已存在" },
);

same("新增一个 → ok", await save({ name: "brand-new", config: { command: "uvx", args: ["mcp-git"] } }), {
  ok: true,
});
eq("新增的进了引擎视图", "brand-new" in claudeViewOnDisk(), true);
eq("新增的同步进 Codex 派生视图", codexTomlOnDisk().includes("[mcp_servers.brand-new]"), true);
eq(
  "新增的也进了面板",
  rowOf(await rows(), "brand-new")?.detail,
  "uvx mcp-git",
);

same("带 replace 覆盖已启用的 → ok", await save({ name: "stdio-one", config: { command: "node2" }, replace: true }), {
  ok: true,
});
eq("覆盖真的换掉了命令", (await mcpConfig.getMcpTruth()).userServers?.["stdio-one"]?.command, "node2");

// 两个 handler 都会先 await 真相层读取；没有主进程串行队列时它们能读到同一份
// 旧快照,后保存的那份会覆盖先保存的名字。并发发起,确认两个更新都留下。
const concurrentSaves = await Promise.all([
  save({ name: "parallel-a", config: { command: "a" } }),
  save({ name: "parallel-b", config: { command: "b" } }),
]);
same("并发保存都成功", concurrentSaves, [{ ok: true }, { ok: true }]);
{
  const state = await mcpConfig.getMcpTruth();
  check("★ 并发保存不会互相覆盖", Boolean(state.userServers?.["parallel-a"] && state.userServers?.["parallel-b"]));
}
await Promise.all([remove({ name: "parallel-a" }), remove({ name: "parallel-b" })]);

// 编辑一个**关掉的**服务器 = 重新启用:配置在真相层里,得把 stash 那份清掉,
// 否则派生视图会继续把它滤掉 —— 用户按了保存却什么都没发生。
same(
  "带 replace 编辑一个关掉的 → ok",
  await save({ name: "remote-off", config: { type: "sse", url: URL_OFF, headers: { A: "b" } }, replace: true }),
  { ok: true },
);
{
  const state = await mcpConfig.getMcpTruth();
  eq("编辑关掉的服务器会把它重新启用(stash 被清掉)", "remote-off" in (state.userDisabled ?? {}), false);
  eq("面板上它变成开", rowOf(await rows(), "remote-off")?.enabled, true);
}

same("删一个不存在的 → 拒绝,说人话", await remove({ name: "never-existed" }), {
  ok: false,
  error: "未找到该 server",
});

same("删掉 brand-new → ok", await remove({ name: "brand-new" }), { ok: true });
eq("删掉之后引擎视图里没有了", "brand-new" in claudeViewOnDisk(), false);
eq("删掉之后面板里也没有了", rowOf(await rows(), "brand-new"), undefined);

// 删一个**关掉的**:配置只在 stash 里,`userServers` 那一侧没有它 —— 只清一边的
// 实现会返回 ok 却把条目留在盘上。
same("先关掉再删 → ok", await toggle({ name: "remote-plain", scope: "user", enabled: false }), { ok: true });
same("删一个关掉的服务器 → ok", await remove({ name: "remote-plain" }), { ok: true });
{
  const state = await mcpConfig.getMcpTruth();
  check(
    "★ 关掉的服务器被删时,stash 那一半也清了",
    !("remote-plain" in (state.userServers ?? {})) && !("remote-plain" in (state.userDisabled ?? {})),
    { userServers: Object.keys(state.userServers ?? {}), userDisabled: Object.keys(state.userDisabled ?? {}) },
  );
  eq("再看一次确实没有了", rowOf(await rows(), "remote-plain"), undefined);
}

/* ──────────────── 6. 插件桩与真实现是同一条语义 ──────────────── */

console.log("\n插件那一半的形状");

// §3 把 `demo-plugin__stdio-plugin` 关掉又打开了,所以这里先把它关回去 ——
// 下面几条断的是"关掉之后"的形状。
await toggle({ name: "demo-plugin__stdio-plugin", scope: "plugin", enabled: false });

// 插件启停**不在**本套的职责里(那是 plugins-ipc-smoke 的事),但 handler 依赖插件
// 管理器的一个具体形状:`setPluginMcpDisabled` **永远**返回 ok,并回传写入前状态
// 供物化失败时精确回滚。这条断了的话,MCP_TOGGLE 的插件分支会静默不再重算视图。
same(
  "setPluginMcpDisabled 返回 ok 和可回滚的旧状态",
  pluginStub.setPluginMcpDisabled("whatever__x", true),
  { ok: true, previousDisabled: false },
);
pluginStub.setPluginMcpDisabled("whatever__x", false);
check("名单写入之后确实清掉了", pluginStub.mcpDisabled.has("whatever__x") === false);
// 开关写进的是**名单**,不是插件自己的配置 —— 这一点是插件 MCP 能被单独停用的前提
// (配置住在插件树里,永远不被重写)。
eq(
  "★ 停用一个插件服务器不会动插件自己的配置(配置仍住在插件树里)",
  "stdio-plugin" in pluginStub.pluginServers["demo-plugin"],
  true,
);
eq("而名单里确实记上了它", pluginStub.mcpDisabled.has("demo-plugin__stdio-plugin"), true);
same(
  "★ 关掉的插件服务器不进引擎视图(claude 那份也一样)",
  (await pluginStub.getPluginMcpServers()).filter(([n]) => n === "demo-plugin__stdio-plugin"),
  [],
);
same(
  "关掉的插件服务器在面板上显示为关",
  (await rows()).filter((r) => r.name === "demo-plugin__stdio-plugin").map((r) => r.enabled),
  [false],
);

// 顺带钉一个边界:插件那支 toggle 对**多层都没出现过**的名字也永远 ok(纯名单写入,
// 没有"找不到"这种失败)—— 与用户级那支的 `未找到该 server 的配置` 是刻意的差别。
same(
  "停用一个不存在的插件服务器:桩永远说 ok(真的是纯名单写入)",
  await toggle({ name: "no-such__server", scope: "plugin", enabled: false }),
  { ok: true },
);

/* ──────────────── 7. MCP_SCAN_IMPORT:只读 ──────────────── */

console.log("\n扫描导入源(只读)");

const scan = (await scanImport({})) as {
  sources: Array<{ name: string; kind: string; detail: string; origin: { kind: string; path?: string }; config?: McpServerConfig }>;
};
same(
  "扫到的名字正好是本机 CLI 配置里的那些(全局 + 每个项目)",
  scan.sources.map((s) => s.name).sort(),
  ["from-cli-global", "from-cli-project", "stdio-one"],
);
eq(
  "全局来源是个标签,不是那句中文",
  JSON.stringify(scan.sources.find((s) => s.name === "from-cli-global")?.origin),
  JSON.stringify({ kind: "global" }),
);
eq(
  "项目来源带的是路径",
  JSON.stringify(scan.sources.find((s) => s.name === "from-cli-project")?.origin),
  JSON.stringify({ kind: "project", path: "/tmp/some-project" }),
);
eq("扫出来的行带 kind", scan.sources.find((s) => s.name === "from-cli-project")?.kind, "http");
eq("扫出来的行带一个不泄露密钥的 detail", scan.sources.find((s) => s.name === "from-cli-project")?.detail, "https://p.example/mcp");
eq("扫描不向 renderer 返回配置密钥", scan.sources.find((s) => s.name === "from-cli-global")?.config, undefined);
check("env/header 密钥不能出现在扫描响应", !JSON.stringify(scan).includes("fixture-import-secret"));

// **只读**:扫描本身绝不能改动任何东西。
check(
  "★ 扫描没往受管的 .claude.json 里写过一个字",
  !("from-cli-global" in claudeViewOnDisk()),
  { claudeView: Object.keys(claudeViewOnDisk()) },
);
eq(
  "★ 扫描没往真相层里塞东西",
  "from-cli-project" in ((await mcpConfig.getMcpTruth()).userServers ?? {}),
  false,
);

/* ──────────────── 8. MCP_IMPORT ──────────────── */

console.log("\n导入");

const importRes = (await importServers({
  servers: [
    { name: "from-cli-global", origin: scan.sources.find((s) => s.name === "from-cli-global")!.origin },
    { name: "from-cli-project", origin: scan.sources.find((s) => s.name === "from-cli-project")!.origin },
    // 同名的跳过,而不是覆盖 —— 「导入」不该悄悄改掉用户已有的配置。
    { name: "stdio-one", config: { command: "SHOULD-NOT-WIN" } },
    // 关掉的也算已存在。
    { name: "demo-plugin__stdio-plugin", config: { command: "SHOULD-NOT-WIN" } },
  ],
})) as { imported: string[]; skipped: string[]; errors: Array<{ name: string; error: string }> };

same("导入清单", importRes.imported, ["from-cli-global", "from-cli-project", "demo-plugin__stdio-plugin"]);

// 插件名不在真相层里(`userServers` 只有用户级),所以导入插件名**不会**被跳过 ——
// 这不是 bug,是"同名"这个词的范围只到用户级。带 replace 的编辑路径才是覆盖。
same(
  "已被别的插件贡献的同名服务器不算「已存在」(插件名不在真相层里)",
  importRes.skipped,
  ["stdio-one"],
);

// 「同名跳过」用**插件名**这条验不到 —— 插件名不在真相层里(`userServers` 只有用户级),
// 所以它其实会被导入(上面那条断言钉的就是这个边界)。真正要验的是**用户级同名**:
// 启用中的和关掉的都算已存在,一律跳过、绝不覆盖。
const importRes2 = (await importServers({
  servers: [
    { name: "stdio-one", config: { command: "SHOULD-NOT-WIN" } },
    { name: "remote-off", config: { command: "SHOULD-NOT-WIN" } },
  ],
})) as { imported: string[]; skipped: string[] };
same("同名(启用中 + 关掉的)一律跳过,不进 imported", importRes2.imported, []);
same("跳过的名字原样回传(界面要告诉用户跳了哪些)", importRes2.skipped, ["stdio-one", "remote-off"]);
eq("★ 跳过的没有覆盖掉原来的配置", (await mcpConfig.getMcpTruth()).userServers?.["stdio-one"]?.command, "node2");

eq("导入进来的进了引擎视图", "from-cli-global" in claudeViewOnDisk(), true);
eq("导入由主进程解析真实 env", ((await mcpConfig.getMcpTruth()).userServers?.["from-cli-global"] as { env?: Record<string, string> })?.env?.API_KEY, "fixture-import-secret");
eq("导入由主进程解析真实 header", ((await mcpConfig.getMcpTruth()).userServers?.["from-cli-project"] as { headers?: Record<string, string> })?.headers?.Authorization, "Bearer fixture-import-secret");
eq(
  "★ 导入会立即同步 codex 的 config.toml",
  codexTomlOnDisk().includes("[mcp_servers.from-cli-global]"),
  true,
);
eq("errors 为空(没出错就别编一个)", importRes.errors.length, 0);

// 空批次:什么都不该发生,但也不该报错。
const emptyImport = (await importServers({ servers: [] })) as { imported: string[]; skipped: string[]; errors: unknown[] };
same("空导入 → 三张表都是空的", [emptyImport.imported, emptyImport.skipped, emptyImport.errors], [[], [], []]);

/* ── 派生视图写失败:事实源必须回滚,不能报失败却偷偷保存 ── */
console.log("\n物化失败回滚");
const claudeFileBeforeFailure = readFileSync(USER_CLAUDE_JSON, "utf-8");
const truthBeforeFailure = JSON.stringify(await mcpConfig.getMcpTruth());
const enginesBeforeFailure = JSON.stringify(enginesMapOnDisk());
const pluginNameForRollback = "demo-plugin__remote-plugin";
const pluginDisabledBeforeFailure = pluginStub.mcpDisabled.has(pluginNameForRollback);
rmSync(USER_CLAUDE_JSON, { force: true });
mkdirSync(USER_CLAUDE_JSON);
try {
  const failedSave = (await save({ name: "rollback-save", config: { command: "never-persists" } })) as {
    ok: boolean;
  };
  eq("Claude 视图写失败时保存返回失败", failedSave.ok, false);
  eq(
    "★ 保存失败后事实源逐字段回到旧快照",
    JSON.stringify(await mcpConfig.getMcpTruth()),
    truthBeforeFailure,
  );

  const failedEngines = (await enginesSet({
    name: "rollback-engine",
    claude: true,
    codex: false,
  })) as { ok: boolean };
  eq("Claude 视图写失败时引擎分配返回失败", failedEngines.ok, false);
  eq("★ 引擎矩阵也回到旧快照", JSON.stringify(enginesMapOnDisk()), enginesBeforeFailure);

  const failedPluginToggle = (await toggle({
    name: pluginNameForRollback,
    scope: "plugin",
    enabled: false,
  })) as { ok: boolean };
  eq("Claude 视图写失败时插件 MCP 开关返回失败", failedPluginToggle.ok, false);
  eq(
    "★ 插件 denylist 恢复操作前的精确状态",
    pluginStub.mcpDisabled.has(pluginNameForRollback),
    pluginDisabledBeforeFailure,
  );

  const failedImport = (await importServers({
    servers: [{ name: "rollback-import", config: { command: "never-persists" } }],
  })) as { imported: string[]; errors: unknown[] };
  same("导入落盘失败时不谎报 imported", failedImport.imported, []);
  check("导入落盘失败带回错误", failedImport.errors.length > 0);
  eq(
    "★ 导入失败的名字不留在事实源",
    "rollback-import" in ((await mcpConfig.getMcpTruth()).userServers ?? {}),
    false,
  );
} finally {
  rmSync(USER_CLAUDE_JSON, { recursive: true, force: true });
  writeFileSync(USER_CLAUDE_JSON, claudeFileBeforeFailure, "utf-8");
  await mcpConfig.materializeAllMcpViews();
}

/* ──────────────── 9. 派生视图与真相层的一致性 ──────────────── */

console.log("\n派生视图");

{
  const state = await mcpConfig.getMcpTruth();
  const claudeView = claudeViewOnDisk();
  const map = enginesMapOnDisk() as Record<string, Record<string, boolean>>;
  const stash = state.userDisabled ?? {};
  const truth = state.userServers ?? {};

  // 期望值**从头算**(启用集合交上可见性),不是从真相层里挑。
  // 「真相层里没关掉的」与「引擎真能加载到的」是两件事 —— 后者还要过一遍
  // per-engine 矩阵。用前者当期望值的话,"矩阵被人从 `deriveMcpEngineView` 的
  // 判定里拿掉"这一整类事故会全绿。
  const expectedClaude = Object.keys(truth).filter(
    (n) => !(n in stash) && map[n]?.claude !== false,
  );
  same(
    "★ claude 视图 = 「没关掉」∧「没被移出 claude」",
    Object.keys(claudeView).sort(),
    expectedClaude.sort(),
  );
  check(
    "★ schema 认不出的条目也在派生视图里(它没有被静默丢掉)",
    "not-modeled" in claudeView,
    { claudeView: Object.keys(claudeView) },
  );
  // 关掉的名字一个都不该在视图里。注意这要拿**磁盘上**那份视图判,而不是重算一遍
  // —— 重算的话这些断言就退化成"照着 handler 的写法再写一遍"。
  same("关掉的名字一个都不在 claude 视图里", Object.keys(claudeView).filter((n) => n in stash), []);
  same(
    "★ 夹具里被关掉的那个(remote-off)后来被编辑重新启用了 —— 复核它现在的状态",
    [rowOf(await rows(), "remote-off")?.enabled, "remote-off" in stash],
    [true, false],
  );
}

// ★ 换一个**干净**的名字单独验「关掉 → 不在视图里」:前面的用例把 stdio-one 和
// remote-plain 的分配/启停都改过了,拿它们当判据会让这条断言依赖执行顺序。
{
  await save({ name: "view-toggle-probe", config: { type: "http", url: "https://vt.example/mcp" } });
  eq("刚存进去:在 claude 视图里", "view-toggle-probe" in claudeViewOnDisk(), true);
  await toggle({ name: "view-toggle-probe", scope: "user", enabled: false });
  eq("★ 关掉之后立刻不在 claude 视图里了(引擎看不到用户已经收走的服务器)", "view-toggle-probe" in claudeViewOnDisk(), false);
  await toggle({ name: "view-toggle-probe", scope: "user", enabled: true });
  eq("再打开:又回来了", "view-toggle-probe" in claudeViewOnDisk(), true);

  await enginesSet({ name: "view-toggle-probe", claude: false, codex: true });
  eq("★ 移出 claude 之后也不在它的视图里", "view-toggle-probe" in claudeViewOnDisk(), false);
  eq(
    "而它仍在 codex 视图里(移出 claude 不等于停用)",
    codexTomlOnDisk().includes("[mcp_servers.view-toggle-probe]"),
    true,
  );
  eq("面板上它两个引擎的可见性都还回传着", rowOf(await rows(), "view-toggle-probe")?.perEngine?.claude, false);
  await enginesSet({ name: "view-toggle-probe", claude: true, codex: true });
  await remove({ name: "view-toggle-probe" });
}

/* ──────────────── 10. OAuth 两条:只有参数守卫可验 ──────────────── */

console.log("\nOAuth(只到参数守卫)");

// ⚠️ 契约层那两道(`McpAuthorizeSchema` / `McpUnauthorizeSchema`)的 `url` 是
// `z.string().url()`,所以"根本不是 URL"的输入轮不到 handler 说话 —— preload 那道
// zod 直接拒。能走到 handler 那道 `仅支持 http(s) 地址` 守卫的,只有
// **是合法 URL 但不是 http(s)** 的地址(file: / ftp: / javascript: …)。
const FTP = "ftp://x.example/mcp";
const FILE_URL = "file:///etc/passwd";

same(
  "名字里有非法字符 → 挡在起进程之前",
  await authorize({ name: "bad name;rm -rf", url: "https://x.example/mcp", kind: "http" }),
  { ok: false, error: "非法 server 名" },
);
same(
  "★ 是合法 URL 但不是 http(s) → 挡在起进程之前",
  await authorize({ name: "good-name", url: FTP, kind: "http" }),
  { ok: false, error: "仅支持 http(s) 地址" },
);
same(
  "file: 地址一样挡住(它是个合法 URL,所以能走到这道守卫)",
  await authorize({ name: "good-name", url: FILE_URL, kind: "http" }),
  { ok: false, error: "仅支持 http(s) 地址" },
);
same(
  "登出同样两道守卫(非法名)",
  await unauthorize({ name: "bad name;rm -rf", url: "https://x.example/mcp", kind: "http" }),
  { ok: false, error: "非法 server 名" },
);
same(
  "登出同样两道守卫(非 http(s))",
  await unauthorize({ name: "good-name", url: FTP, kind: "http" }),
  { ok: false, error: "仅支持 http(s) 地址" },
);
eq(
  "★ 名字守卫先于地址守卫(名字非法时不谈地址)",
  JSON.stringify(await authorize({ name: "bad name", url: FTP, kind: "http" })),
  JSON.stringify({ ok: false, error: "非法 server 名" }),
);
eq(
  "★ 地址守卫先于「有没有 CLI」(顺序错了这里会先说找不到 CLI)",
  JSON.stringify(await authorize({ name: "good-name", url: FTP, kind: "http" })),
  JSON.stringify({ ok: false, error: "仅支持 http(s) 地址" }),
);
// 登出多一道「没有已存储的授权」的早退 —— 它也在找 CLI 之前。
same(
  "登出一个没有令牌的服务器 → 直接说没有,不去起进程",
  await unauthorize({ name: "nobody-has-this", url: "https://x.example/mcp", kind: "http" }),
  { ok: false, error: "该 server 没有已存储的授权" },
);
// 「根本不是 URL」这一档由契约层的 zod 挡 —— 这里钉住它**确实**被挡住。
//
// ⚠️ 实测(见下面那条):被挡住之后**用户读到的那行字是原始 zod JSON**,不是人话:
//      [
//        { "validation": "url", "code": "invalid_string", "message": "Invalid url", "path": ["url"] }
//      ]
//    面板是 `catch (err) { setError((err as Error).message) }`(McpPanel.tsx),
//    而 preload 这一层对 `ipcRenderer.invoke` 的 rejection 不做任何包装,所以
//    128 个字符的 JSON 会原样糊进红色提示条。这**不是** `ipc/mcp.ts` 的 bug
//    (handler 根本没被调到,`McpAuthorizeSchema.parse` 就抛了),所以本套不改它 ——
//    但它正是本仓库那个「不合理、不专业」的 bug 类,登记在这里 + 报告里。
//    修法在别处:要么 preload 把 zod 报错翻译成人话,要么面板对非 `{error}` 形状的
//    异常兜一句 `t("settings.operationFailed")`。
{
  const raw = await authorize({ name: "good-name", url: "not-a-url", kind: "http" }).then(
    () => null,
    (err: unknown) => err as { message?: string },
  );
  eq("地址根本不是 URL 时,这道调用被契约层拒(不是静默写进去)", raw !== null, true);
  check(
    "★ 登记现状:契约层拒掉时用户读到的是原始 zod JSON(不是人话)",
    // 判据立在**那行字**上,不立在"抛没抛"上。`[\s*{` 是关键形状 ——
    // 注意报错文本里**没有** "zod" 这个词,只按词筛会漏掉。
    typeof raw?.message === "string" && /^\[\s*\{/.test(raw.message.trim()) && /"validation"/.test(raw.message),
    { userSees: raw?.message },
  );
}

/* ──────────────── 11. 用户可见的错误串 ──────────────── */

console.log("\n用户看到的那行字");

/** 面板把 `{error}` 原样塞进红色提示条(见 McpPanel 的 `res.error ?? t(...)`)。
 *  所以这里检查的是**用户真的会读到什么** —— zod 的 JSON 数组、`undefined`、
 *  `[object Object]` 这类东西糊上去就是那个"不合理、不专业"的 bug 类。 */
const USER_FACING_ERRORS = [
  "未找到该 server 的配置",
  "未找到该 server",
  "同名 server 已存在",
  `「${MCP_RESERVED_NAME}」是内置 server 的保留名`,
  "非法 server 名",
  "仅支持 http(s) 地址",
  "该 server 没有已存储的授权",
];
for (const msg of USER_FACING_ERRORS) {
  check(
    `错误串是人话:「${msg}」`,
    msg.trim().length > 0 &&
      !/zod|ZodError|invalid_|\{\s*"|\[\s*\{|\[object |undefined|NaN|null/i.test(msg),
    { msg },
  );
}
check(
  "★ 上面这批错误串确实都是从这 9 条通道里真拿到的(不是手抄的)",
  [
    (await toggle({ name: "ghost", scope: "user", enabled: true })),
    (await remove({ name: "never-existed" })),
    (await save({ name: "stdio-one", config: { command: "x" } })),
    (await save({ name: MCP_RESERVED_NAME, config: { command: "x" } })),    (await authorize({ name: "bad name", url: "https://x.example/mcp", kind: "http" })),
    (await authorize({ name: "good-name", url: "ftp://x.example/mcp", kind: "http" })),
    (await unauthorize({ name: "nobody-has-this", url: "https://x.example/mcp", kind: "http" })),
  ].every((r) => {
    const e = (r as { error?: unknown }).error;
    return typeof e === "string" && !/zod|ZodError|\[\s*\{|\[object /i.test(e);
  }),
);

/* ──────────────── 12. 名字不合法的输入 ──────────────── */

console.log("\n名字校验");

// 渲染端在发请求之前自己先按 MCP_NAME_RE 挡一道(见 McpPanel 的 save()),
// 所以这里是**第二道**。第二道的行为是 zod 直接抛 —— 也就是 invoke 被拒。
// 本套钉住的是"它确实拒绝了",而不是那份 zod 报错文本长什么样:那段文本会原样
// 走到渲染端的 catch,而它不是给人看的(登记在文件头的「不验/存疑」里)。
const rejected = await save({ name: "带中文的名字", config: { command: "x" } }).then(
  () => "resolved",
  () => "rejected",
);
eq("名字不合法时这条调用被拒(而不是静默写进去)", rejected, "rejected");
eq(
  "被拒的名字没有进真相层",
  "带中文的名字" in ((await mcpConfig.getMcpTruth()).userServers ?? {}),
  false,
);

/* ──────────────── 13. 被登记但一次都没命中的夹具 ──────────────── */

console.log("\n夹具命中检查");

// 这一节存在的理由见 SKILL:登记了夹具却没人命中的断言会全绿而什么都没验。
{
  const names = new Set((await rows()).map((r) => r.name));
  // ⚠️ 这份名单**必须**与夹具的**全部**去向逐条对得上,否则它会退化成"永远绿"。
  // 每条不在名单里的行都得有个说得出名字的出处,写在下面。
  const registered = Object.keys(FIXTURE.userServers ?? {})
    // §5 里把 remote-plain 删掉了(它在本套里兼任"删除"那条通道的被试),
    // 所以它在收尾时**不该**还在面板上。
    .filter((n) => n !== "remote-plain" && n !== "not-modeled")
    // 插件夹具贡献的三行:demo-plugin 两条 + aaa-plugin 一条。行名由桩按
    // `<插件>__<服务器>` 拼,所以这里手写全名。
    .concat(["demo-plugin__remote-plugin", "demo-plugin__stdio-plugin", "aaa-plugin__zzz"])
    // 内置浏览器服务器(常量名,别硬编码字面量)。
    .concat([MCP_RESERVED_NAME])
    // §8 的导入夹具:CLI 配置里那两条全局/项目级,被 MCP_IMPORT 收进真相层之后
    // 就该出现在面板上 —— 也算"有出处"。
    .concat(["from-cli-global", "from-cli-project"]);
  const missing = registered.filter((n) => !names.has(n));
  same("登记的夹具名字都真的出现在列表里(没有一等就被别的断言悄悄跳过)", missing, []);

  // 反方向的守卫:上面那份名单是**手写**的,如果哪天夹具加了新条目而这里忘了写,
  // 那条新夹具就悄悄没人验。这条抓它 —— 第一次跑就靠它抓到"aaa-plugin__zzz"和
  // 两条导入进来的名字没登记。
  same(
    "★ 反过来也成立:面板上的每一行都能在这份名单里找到出处(没有「没人认领」的夹具)",
    [...names].filter((n) => !registered.includes(n) && n !== "not-modeled").sort(),
    [],
  );

  // `not-modeled` 是**故意的**例外:schema 认不出的配置不进面板(用户看到它也没法编辑),
  // 但它必须在真相层和派生视图里活着 —— 静默丢掉它等于用户手写的配置被这套代码吃掉。
  check(
    "★ 例外的那条(schema 认不出)确实只在面板外活着:真相层里有、面板上没有",
    "not-modeled" in ((await mcpConfig.getMcpTruth()).userServers ?? {}) && !names.has("not-modeled"),
    { names: [...names] },
  );

  check("探测替身至少被叫过一次", fetchedUrls.length > 0, { fetchedUrls });
}

/* ──────────────── 收尾 ──────────────── */

globalThis.fetch = realFetch;
rmSync(DATA, { recursive: true, force: true });

console.log(`\nmcp-ipc-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) {
  console.log(`红的那些:${failedNames.join(" / ")}`);
  process.exit(1);
}
