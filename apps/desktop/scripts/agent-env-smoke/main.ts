/**
 * Headless smoke for **环境变量的两个方向** —— `env/agentEnv.ts` 与
 * `terminal/envRefresh.ts`。
 *
 * ## 为什么要单独钉这两条
 *
 * 它们都是"改一个字符串",看代码看不出来,错了也不报错:
 *
 * 1. **`CLAUDE_CONFIG_DIR` 必须进主进程的 `process.env`。** 引擎侧的子进程一直拿得到
 *    它(三处各自显式设过),漏的是主进程自己 —— 而 SDK 里有几个函数
 *    (`forkSession` / `listSessions` / `deleteSession`)是**跑在我们进程里**的,它们
 *    自己按 `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude` 解析根。少这一句,
 *    「复制一份对话」就会去 `~/.claude/projects/` 找一个明明在 `~/.mcode/` 下的文件,
 *    报的却是 `Session <id> not found` —— **看起来像会话丢了,其实是找错地方了**。
 * 2. **它必须不进应用内终端。** PTY 的 env 是主进程 env 的逐字拷贝,而这一条与
 *    PATH / PYTHONUTF8 性质不同:那两个漏出去只是"工具更好找、python 正常",这一条漏
 *    出去会把用户手敲的 `claude` 指到 Mcode 的会话列表、MCP 服务器和凭据上。
 *
 * 这两条是**同一个变量的两个方向**,所以放在一份里 —— 改了一边没改另一边,这里会红。
 *
 * 全都是纯函数(读几个目录 + 改字符串),不起进程、不碰网络。
 *
 * Run: scripts/agent-env-smoke/run.sh
 */
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import { applyAgentEnvironment } from "@main/env/agentEnv.js";
import { buildTerminalEnv } from "@main/terminal/envRefresh.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
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

console.log("启动时把配置根交给主进程(见 agentEnv 文件头第 3 节)");

// 先把环境**弄脏**:模拟一个真装了 Claude Code CLI 的机器 —— 环境里已经有用户自己的
// `CLAUDE_CONFIG_DIR`(或者是别的什么值)。applyAgentEnvironment 要的是"和引擎侧一样
// 无条件覆盖",不是"没设才设" —— 两边指的必须是同一个根。
const before = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = "C:\\somewhere-else\\.claude";
applyAgentEnvironment();

eq("设成了 Mcode 自己的根", process.env.CLAUDE_CONFIG_DIR, MCODE_CONFIG_DIR);
check(
  "盖掉了环境里原本那个值(而不是「没设才设」)",
  process.env.CLAUDE_CONFIG_DIR !== "C:\\somewhere-else\\.claude",
);
check(
  "Mcode 的根确实是 ~/.mcode(不是 .claude)",
  /[\\/]\.mcode$/.test(MCODE_CONFIG_DIR),
  MCODE_CONFIG_DIR,
);

console.log("但终端里不能有它(PTY 的 env 是主进程 env 的逐字拷贝)");

const { env } = await buildTerminalEnv();

/** 按变量名取值 —— **大小写不敏感**。win32 那一步注册表覆盖会把键换成注册表里的
 *  拼法(实测本机是 `Path` 而不是 `PATH`),直接写 `env.PATH` 会拿不到。 */
const get = (name: string): string | undefined => {
  const upper = name.toUpperCase();
  const k = Object.keys(env).find((x) => x.toUpperCase() === upper);
  return k === undefined ? undefined : env[k];
};

// 判据是「**我们的**那个根没有漏出去」,不是「这个键不存在」—— 用户自己的
// HKCU\Environment 里真设过 CLAUDE_CONFIG_DIR 的话,win32 那一步注册表覆盖会把它
// 放回来,而那**正是对的**(那是他自己的配置,在他自己的终端里该生效)。所以这里
// 不能钉"键不存在",只能钉"不是 Mcode 的值"。
check(
  "终端 env 里没有 Mcode 的配置根",
  get("CLAUDE_CONFIG_DIR") !== MCODE_CONFIG_DIR,
  get("CLAUDE_CONFIG_DIR"),
);
check(
  "别的东西照旧继承(只摘这一个,不是整个 env 清空)",
  Object.keys(env).length > 3 && (get("PATH")?.length ?? 0) > 0,
  { keys: Object.keys(env).length, hasPath: (get("PATH")?.length ?? 0) > 0 },
);
// PATH 那条是给 `pandoc` 那种工具用的,漏出去无害且正是目的 —— 顺手钉一下
// "该漏的还在",免得以后有人为了安全把整个 env 过滤掉。
check(
  "PYTHONUTF8 还在(这一条漏出去是好事)",
  get("PYTHONUTF8") === "1",
  get("PYTHONUTF8"),
);

// 还原,免得后面别的东西(同一进程里的其他断言)看到我们摆出来的状态。
if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = before;

/* ───────────────────────────── report ───────────────────────────── */

if (failures > 0) {
  console.error(`\n${failures} failed, ${checks - failures} passed`);
  process.exit(1);
}
console.log(`\n${checks}/${checks} 通过`);