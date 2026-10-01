/**
 * **agent 的子进程会继承的那个环境** —— 应用在这里做一次性加工。
 *
 * ## 为什么集中在一处
 *
 * 三个 provider 造子进程环境时都是 `{...process.env}`(Claude 有标准/自定义两条
 * 路径,codex 在 buildCodexEnv 里,Pi 直接继承父进程)。所以改 `process.env` 一次,
 * 三家全部拿到 —— 而逐个 provider 拼要改四处,以后加第五个 provider 还得记得改
 * 第五处。顺带的副作用是**应用内终端也拿到了**,那是好事。
 *
 * `main/index.ts` 启动时调一次;工具装/卸之后各调一次(路径会变)。
 *
 * ## 管两件事
 *
 * ### 1. 工具目录(PATH)
 *
 * 两类:
 *
 * - **自管工具**(pandoc / LaTeX)—— 应用自己装在 `<userData>/tools/` 下,目录必然
 *   不在 PATH 上;
 * - **装了但不上 PATH 的系统工具**(LibreOffice 是典型:装完不把自己加进 PATH)——
 *   检测靠硬编码位置找得到它们,**但 agent 的 shell 里敲裸名字找不到**。这一类不补
 *   的话会出现"面板显示 ✓、agent 却 command not found"这种检查与能力脱节的状态。
 *
 * 幂等:每次先把**上一次注入的那几条**摘掉再加新的。不这么做的话,反复安装会把
 * 同一个目录在 PATH 里越堆越多,而且被删掉的旧版本目录会永远留着(每多一个失效
 * 条目,每次 spawn 都多一次无用的路径探测)。
 *
 * ### 2. Python 的编码(`PYTHONUTF8` / `PYTHONIOENCODING`)
 *
 * 这一条是修一个**会让 agent 误判的坑**,不是锦上添花。中文 Windows 上 Python 的
 * 默认编码是 GBK,而文档技能的脚本一律按 UTF-8 读写 —— 实测内置技能里的
 * `office/validate.py` 对一份**完全没动过**的 docx 报:
 *
 *     FAILED - Found NEW validation errors:
 *       word\document.xml: 1 new error(s)
 *         - 'gbk' codec can't decode byte 0x80 …
 *
 * 它把"自己读不了这个文件"报成了"这份文档有 XML 错误"。agent 看到这条会以为
 * 自己的编辑改坏了东西,然后开始"修"一份本来完全正确的文档 —— 这是最坏的一类
 * 失败:不是报错,而是把人骗到错误的方向上。
 *
 * `PYTHONUTF8=1` 打开 UTF-8 模式(PEP 540),`open()` 的默认编码随之变 UTF-8,
 * 上面那份文档立刻变成 `All validations PASSED!`。
 *
 * **用户已经设过就不覆盖** —— 那是他明确的配置,不该被应用悄悄改掉。
 *
 * ### 3. Claude 的配置根(`CLAUDE_CONFIG_DIR`)
 *
 * 引擎侧的子进程一直拿得到这个变量 —— 三个入口(`customEnv.buildCustomEnv`、
 * provider 标准路径的 `options.env`、`ipc/mcp.ts` 里探服务器那几处)各自显式设过。
 * 漏掉的是**主进程自己**:SDK 里另有一组函数(`forkSession` / `listSessions` /
 * `deleteSession`)是**在我们这个进程里跑的**,它们自己按
 * `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude` 解析根目录。
 *
 * 于是「复制一份对话」报 `Session <id> not found in project directory for <dir>` ——
 * 那个 `.jsonl` 就在 `~/.mcode/projects/` 下摆着,而 SDK 去 `~/.claude/projects/`
 * 找。**这条错看起来像"会话没了",其实是"找错地方了"**,所以放在这里一次设好。
 *
 * ⚠️ 这个变量与前面两个**性质不同**:PATH / PYTHONUTF8 漏给用户的 shell 无害,
 * 而这个会把用户手敲的 `claude` 指到 Mcode 的会话列表、MCP 服务器和凭据上去。
 * `terminal/envRefresh.ts` 里有一条对应的 `delete`(PTY 的 env 是主进程 env 的
 * 逐字拷贝),**两处要一起看**。
 */
import { delimiter } from "node:path";
import { managedToolBinDirs } from "./managedToolRoots.js";
import { macShellPathDirs, systemToolBinDirs } from "./systemToolPaths.js";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";

/** 上一次由本模块注入的 PATH 目录 —— 下次重算时先摘掉它们。 */
let injected: string[] = [];

/** 当前注入的目录(给面板 / 诊断看)。 */
export function injectedToolDirs(): string[] {
  return [...injected];
}

/** 重算 `process.env.PATH`,让自管工具与"装了但不在 PATH 上"的系统工具都能被
 *  裸名字找到。装/卸工具后必须调。 */
function refreshToolchainPath(): void {
  const previous = injected;
  // macShellPathDirs:macOS 从访达启动时缺的 Homebrew / MacTeX 等目录(见那边注释)。
  const dirs = [...managedToolBinDirs(), ...systemToolBinDirs(), ...macShellPathDirs()];

  const base = (process.env.PATH ?? "")
    .split(delimiter)
    // 空段(结尾多一个分隔符)会让 Windows 把当前目录塞进查找路径 —— 掉它
    .filter((entry) => entry.length > 0 && !previous.includes(entry));

  // 只加 PATH 上还没有的:用户可能自己装了 pandoc 并且已经在 PATH 里,
  // 那就没必要让自管的那份抢在前面(他的那份是他明确选择的)。
  const fresh = dirs.filter((d) => !base.includes(d));
  injected = fresh;
  process.env.PATH = [...fresh, ...base].join(delimiter);
}

/** 把 agent 需要的环境变量补齐。启动时一次,工具装/卸后再来一次。 */
export function applyAgentEnvironment(): void {
  refreshToolchainPath();

  // 见文件头第 2 节:不设这个,中文 Windows 上文档技能的校验脚本会把"读不出
  // 文件"报成"文档有错",把 agent 带偏。
  if (!process.env.PYTHONUTF8) process.env.PYTHONUTF8 = "1";
  if (!process.env.PYTHONIOENCODING) process.env.PYTHONIOENCODING = "utf-8";

  // 见文件头第 3 节。**这里不判断"用户设过没有"**:引擎侧那三处是无条件覆盖的
  // (`env.CLAUDE_CONFIG_DIR = MCODE_CONFIG_DIR`),主进程要是尊重环境里那个值,
  // 就会变成"回合把会话写进 ~/.mcode、fork 却去别处找"——两边指的不是同一个根,
  // 那正是这个 bug 的形状。要一致就得一样地无条件。
  process.env.CLAUDE_CONFIG_DIR = MCODE_CONFIG_DIR;
}
