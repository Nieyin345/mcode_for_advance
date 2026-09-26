/**
 * 源级不变量:**一条 IPC 要走全三层,缺一层调用端就看不到 —— 而且没人会发现。**
 *
 * ## 为什么要有这一套
 *
 * 仓库里那条架构规矩(CLAUDE.md 第 1 条)写的是:
 *
 *   > 契约先行。IPC 方法(`RpcMap` 312 个)的 schema 定义在 `packages/contracts/`
 *   > → preload 白名单 → 主进程 handler。**加一条 IPC 要走全三层,缺一层调用端就看不到。**
 *
 * 而**没有任何一套测试验过这句话**。`RpcMap` 三百多条,`preload/index.ts` 一千多行
 * 是一条条手抄的,主进程三十多个 `ipc/*.ts` 一条条 `ipcMain.handle`。漏一层的表现是
 * `undefined` / `not a function` —— 它长得**像"这个功能还没写"**,不像"接线漏了"。
 * 下一个人会去重写一遍功能,而不是去补那一行映射。
 *
 * 所以这一套不测行为,测**结构**:把三层各自的真相从**三个不同的文件**里读出来,
 * 两两对账。判据只有一条形状:
 *
 *   > 契约里有 / preload 里发出去 / 主进程里得有人接。
 *
 * ## 为什么两边不共用一份名单(这决定了整套有没有价值)
 *
 * 如果从 `RpcMap` 生成一份列表、再拿同一份列表去比对,**什么都没验**。
 * 所以每一层的名单都是从**它自己的文件**里、按**它自己的写法**扫出来的:
 *
 *   - 第 1 层: `packages/contracts/src/ipc/rpcMap.ts` 的 `interface RpcMap` 键
 *   - 第 2 层: `apps/desktop/src/preload/index.ts` 里的 `as RpcMap["x.y"]` 标注
 *     **以及** `ipcRenderer.invoke(IPC.XXX)` 用的常量 —— 两边都读,再互相对账
 *   - 第 3 层: `apps/desktop/src/main/**` 里的 `ipcMain.handle(IPC.XXX)` 调用
 *   - 通道名的真相: `rpcMap.ts` 的 `IPC` 表(**运行期 import 真对象**,不是文本解析)
 *
 * 第 2 层和第 3 层的"谁在 import 谁"也是真的:preload 与主进程用的是**同一个** `IPC`
 * 对象(运行期 import),而 `RpcMap` 的键只能从文本里读(`interface` 编译后不存在)。
 * 所以"契约加了、preload 没加"和"preload 常量写错了通道名"是两类不同的红。
 *
 * ## 三层之外还有一条:手机端
 *
 * 手机端(`AppMobile.tsx` + `renderer/lib/webApi.ts`)是**独立组件树**,走无 preload 的
 * HTTP 桥。共用组件里每加一个 RPC 都要在 `webApi.ts` 补一项,漏了会同步抛错、React 19
 * 整棵卸载(踩过)。这一套覆盖它:**webApi 路由到的通道,主进程的移动白名单里必须有**。
 * 见下面检查 4 里那段注释 —— 那里也写清楚了这条**做不到的部分**。
 *
 * ## 已知的边界(不是"没验",是"这个形状验不了")
 *
 *  - **纯文本扫描,不跑代码。** 它认的是源码里那几个形状;把这几个形状写法换掉
 *    (比如动态拼通道名),对应那条断言会以"扫不到"的形式红 —— 那正是要的:说明
 *    扫描器看不懂了,得补它,而不是当它过了。
 *  - **只按 `as RpcMap[...]` 标注判第 1 层。** 一个 `window.api` 上的 key 完全可以
 *    存在却不带这个标注(那就绕过了类型校验,不是这里能测的)。
 *  - **主进程 handler 只认 `ipcMain.handle` / `ipcMain.on`。** 别的收信方式
 *    (`ipcMain.handleOnce` 之类)今天没有;出现时要在这里补。
 *
 * Run: scripts/ipc-wiring-smoke/run.sh
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { IPC } from "@contracts/ipc";

/* ────────────────────────── 基准目录与断言工具 ────────────────────────── */

/**
 * 基准目录 = `apps/desktop`。
 *
 * **不能用 `import.meta.url`**:这一套是按 esbuild 打包成单文件、放到临时目录里跑的
 * (见 `run.sh`),那个路径跟源码无关。`run.sh` 已经 `cd` 到 `apps/desktop`,所以用 cwd ——
 * 顺带在下面断言它真的是 `apps/desktop`(不是的话宁可红,也别去扫错的目录然后"全过")。
 */
const DESKTOP = resolve(process.cwd());
const MAIN = join(DESKTOP, "src/main");
const CONTRACTS = resolve(DESKTOP, "../../packages/contracts/src");
const PRELOAD = join(DESKTOP, "src/preload/index.ts");
const WEB_API = join(DESKTOP, "src/renderer/lib/webApi.ts");
const MOBILE_RPC = join(MAIN, "mobile/mobileRpc.ts");
const MOBILE_GIT_RPC = join(MAIN, "mobile/mobileGitRpc.ts");

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 收尾用:红的时候把两边的差集原样打出来,而不是只打一句"少了几条"。 */
function diff(name: string, a: Iterable<string>, b: Iterable<string>, labelA: string, labelB: string): void {
  const B = new Set(b);
  const miss = [...a].filter((x) => !B.has(x)).sort();
  check(name, miss.length === 0, miss.length === 0 ? undefined : { [labelA + " 有、" + labelB + " 没有"]: miss });
}

/* ────────────────────────── 通道名:运行期 import 那一份真相 ───────────── */

/**
 * `IPC` 是从 `@contracts/ipc` **真的 import 进来的那一个对象** —— 通道名到常量名的
 * 映射就是它本身,不存在第二份抄写。`MEMORY_LIST` 这种值是引用另一个常量得来的,
 * 也由这个对象在运行期兑现(文本扫描就得自己再追一层)。
 */
const CHANNEL_OF_CONST = IPC as unknown as Record<string, string>;
const CHANNELS = new Set(Object.values(CHANNEL_OF_CONST));

/** 常量名 → 通道名。查不到(名字漂了)返回 undefined,由调用方当失败处理。 */
function channelOf(constName: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(CHANNEL_OF_CONST, constName)
    ? CHANNEL_OF_CONST[constName]
    : undefined;
}

/* ────────────────────────── 文本小工具 ────────────────────────── */

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/**
 * 把**注释**和**字符串字面量**都挖空(等长占位,下标不变)。
 *
 * 为什么必须挖:一个被 `//` 注掉的 `ipcMain.handle(IPC.X, …)` 在纯正则眼里和真的一模一样 ——
 * 于是"这一层有接"会被凭空判出来,而真相是调用端拿到 undefined。**这个错法本套自己踩到过**:
 * 临时注掉一条 handler 验它会不会红,结果它全绿了(见报告里那段红→绿)。同理,注释里提到
 * `ipcRenderer.invoke(...)` 也会被当成一条真映射。
 *
 * 挖空而不是删掉 —— 行号、缩进、括号配对全都要保持原样,后面的括号深度扫描才准。
 *
 * ⚠️ **这里有个真踩过的坑:英文注释里的撇号。** 这个仓库的注释是英文写的,
 * `the main window's renderer`、`it can't host it` 里的 `'` 在朴素扫描器眼里就是
 * **一个单引号字符串的开头** —— 于是从这里一路"吞"到下一个撇号,中间几十行代码(含
 * `ipcMain.handle` 那几处)全被当成字符串挖掉,主进程那一层就**整片消失**了
 * (第一版写着写着,`orchestration.ts` 22 处、`BrowserManager.ts` 13 处一次都没扫到,
 * 而报告出来的却是"preload 发了、main 没接").
 *
 * 所以规则是:**只在"不是注释里"的地方认引号**。做法是先按行把注释切掉(每行独立看),
 * 再在剩下的代码上做"字符串状态机"。行注释不会跨行 —— 这一点让整件事变得简单。
 *
 * 已知边界(今天没有这种形状):**跨行的模板串**(`` ` `` 里含换行)里如果又出现
 * `//` 或 `/*`,这一版的按行切会切错。今天全仓库没有这种写法;真出现了,这里要升级
 * 成单趟状态机(注释/字符串/模板三层状态),而不是按行。
 */
function blankCommentsAndStrings(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < Math.min(to, n); k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  /** `//` 之后到行尾 —— 行注释不跨界,所以这一刀永远安全。 */
  const blankLineComment = (from: number) => {
    let j = from + 2;
    while (j < n && text[j] !== "\n") j += 1;
    blank(from, j);
    return j;
  };

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      i = blankLineComment(i);
    } else if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j += 1;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
    } else if (c === "`") {
      // 模板串:允许跨行(挖空时保留换行,行号不变)。里面的 `//` 不当作注释。
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "`") break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '"' || c === "'") {
      /**
       * 普通字符串。**必须先确认"不在注释里"** —— 但走到这里说明当前下标不在注释内
       * (注释在上面两个分支就跳过去了)。真正的坑是**撇号**:英文注释已经被挖空了,
       * 剩下的撇号只可能是字符串开头 —— 除非它出现在**行尾**(`… window's` 这种被
       * 挖空后只剩空格,不会走到这儿)。所以再补一条保险:单引号后面紧跟着空格的、
       * 或者本行内找不到配对的收尾引号,就当成"不是字符串",只挖它自己一个字符。
       */
      let j = i + 1;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        j += 1;
      }
      if (j >= n || text[j] !== c) {
        // 本行内没有收尾引号 —— 不是字符串(是撇号或残缺),只挖一个字。
        blank(i, i + 1);
        i += 1;
      } else {
        blank(i + 1, j);
        i = j + 1;
      }
    } else if (c === "/") {
      /**
       * ⚠️ **正则字面量里也有引号。** `mcp.ts` 里那句
       * `/^https?:\/\/[^\s"'`<>^|]*$/` 的字符类里就有一个 `"` —— 朴素的引号扫描器
       * 把它当字符串开头,一路吞到下一个引号,于是**那之后所有 handler 都消失了**
       * (实测:`MCP_UNAUTHORIZE` 那条在 `ipcMain.handle(…)` 明明写着,扫描器却报
       * "preload 有、main 没有")。
       *
       * 认正则的办法只能靠**前一个有效字符**:`/` 前面是 `(`,`,`,`=`,`:`,`[`,`!`,`&`,`|`,`?`,`{`,`}`,`;`、
       * 行首、或关键字 `return`/`typeof` 之类时,它是正则;否则是除号或者是注释(上面两个分支
       * 已处理)。这不是完备的 JS 词法分析,但对"源码里那几个形状"够用 —— 认错了只会多挖
       * 一段,**而多挖又会被下面"扫到的 handler 数"那条断言抓住**。
       */
      const prev = (() => {
        for (let k = i - 1; k >= 0; k -= 1) {
          if (!/\s/.test(text[k])) return text[k];
        }
        return "";
      })();
      const regexOk = prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev);
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const ch = text[j];
          if (ch === "\\") {
            j += 2;
            continue;
          }
          if (ch === "\n") break; // 正则字面量不能跨行 —— 不是正则,退出
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          j += 1;
        }
        if (j < n && text[j] === "/") {
          // 只挖**内容**,两个 `/` 留着(和字符串的处理一致)。
          blank(i + 1, j);
          i = j + 1;
          // 吃掉 flags(`g` / `i` / `m` / `s` / `u` / `y`)—— 不挖,只是跳过。
          while (i < n && /[a-z]/.test(text[i]) && !/\s/.test(text[i]) && "gimsuy".includes(text[i])) i += 1;
        } else {
          i += 1;
        }
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/** 括号配对:返回从 `text[open]`(必须是 `(`)到配对 `)` 之间的原文。 */
function balancedArg(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/* ────────────────────── 第 1 层:契约里的 RpcMap 键 ────────────────────── */

/**
 * `interface RpcMap { ... }` 的键,按**行首的引号名**认。
 *
 * 为什么不用 TS 编译器 / 为什么不在运行期 import:interface 编译后不存在,拿不到键;
 * 而这一套要的是"源码里写的是什么",文本读已经是够强的形状了(`"a.b": (input: X) => ...`)。
 * 一条 RPC 的键必须含一个点(`域.方法`),`skills.engines.set` 这种两个点的也合法。
 */
function rpcMapKeys(text: string): string[] {
  const at = text.indexOf("export interface RpcMap {");
  if (at < 0) return [];
  const end = text.indexOf("\n}\n", at);
  const body = text.slice(at, end < 0 ? text.length : end);
  const out: string[] = [];
  for (const m of body.matchAll(/^\s*"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"\s*:/gm)) {
    out.push(m[1]);
  }
  return out;
}

/** 检查 1 要的两份真相,抽成函数是为了让下面那段自检能喂人造样本。 */
function rpcMapKeysOfFile(path: string): string[] {
  return rpcMapKeys(read(path));
}

/* ────────────────────── 第 2 层:preload 里的映射 ────────────────────── */

/**
 * preload 的两种写法都要认(去 `src/preload/index.ts` 看,真实形状是这三种):
 *
 *   A. `foo: ((input) => ipcRenderer.invoke(IPC.FOO_BAR, input)) as RpcMap["foo.bar"]`
 *      —— `IPC` 常量 + `RpcMap` 标注**配对**出现的那些
 *   B. `pickFolder: (): Promise<...> => ipcRenderer.invoke("dialog:pickFolder")`
 *      —— 直接写字面量、没有 `RpcMap` 标注(历史遗留的两个,不是漏)
 *   C. `on: { claudeEvent(handler) { … ipcRenderer.on(IPC.CLAUDE_EVENT, listener) } }`
 *      —— 推送通道,只 `ipcRenderer.on` / `.off`(从不 invoke)
 *
 * A 的"标注"要跟着**同一个 invoke** 走,所以是**前向扫描**:找到 `ipcRenderer.invoke(`,
 * 往后一小段里先取通道名、再取最近的那个 `as RpcMap["…"]`。
 *
 * ⚠️ 这个"往后一小段"必须**在下一个 `ipcRenderer.invoke(` 之前截断** —— 否则没有标注的
 * B 类(pickFolder)会去吃掉**下一条**函数的标注,于是它看起来
 * "有标注但通道对不上",而真相只是"它们本来就没有标注"。这个错法很隐蔽:它把两条
 * **正常的历史遗留**报成了坏接线,而真正的问题(以后新加一条也照抄 B 类写法)反倒看不见。
 */
const NEAR = 400;

/**
 * 从 `from` 起,取到下一个 `ipcRenderer.invoke(` 之前的原文(不含)。
 *
 * **截断点按挖空版 `code` 算**(注释里举的例子不是一次真 invoke),**返回的是原文
 * `text` 的切片**(标注 `as RpcMap["…"]` 里的键在原文里才读得到)。
 */
function untilNextInvoke(text: string, from: number, code: string): string {
  const next = code.indexOf("ipcRenderer.invoke(", from);
  const cap = from + NEAR;
  return text.slice(from, next < 0 ? cap : Math.min(next, cap));
}


interface PreloadRow {
  /** 所在对象字面量的名字(`claude` / `clipboardFile` / `pickFiles`…),只作报告用。 */
  ns: string;
  /** invoke 的第一参数:常量名(如 `CLAUDE_START_SESSION`)或字面量通道名。 */
  arg: string;
  /** 常量形式时查出来的通道名;字面量时就是它自己。 */
  channel: string | undefined;
  /** `as RpcMap["…"]` 标注;没有时 null(= B 类)。 */
  rpcKey: string | null;
}

function preloadInvokes(text: string): PreloadRow[] {
  /**
   * ⚠️ 同样:在**挖空注释与字符串**的那一份上找"这里有一次 invoke"。
   * 一个被注掉的映射(或者注释里举的例子 `ipcRenderer.invoke(IPC.X, …)`)绝不能
   * 算成一条真映射 —— 那会让本套对"preload 漏了这条"视而不见。
   * 通道名与标注仍从原文里取(挖空后引号里的内容成了空格,读不出来了)。
   */
  const code = blankCommentsAndStrings(text);

  // 顶层对象字面量的成员(`  claude: {`)—— 用来给每条 invoke 标个"它在哪个命名空间里"。
  const nsSites: Array<{ at: number; name: string }> = [];
  for (const m of text.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[{(]/gm)) {
    nsSites.push({ at: m.index, name: m[1] });
  }
  const nsAt = (pos: number): string => {
    let cur = "<未知>";
    for (const s of nsSites) {
      if (s.at < pos) cur = s.name;
      else break;
    }
    return cur;
  };

  const out: PreloadRow[] = [];
  for (const m of code.matchAll(/ipcRenderer\.invoke\(/g)) {
    const argAt = m.index + m[0].length;
    // 截断点也按挖空版算(注释里的 invoke 不是真 invoke),但文本用原文。
    const tail = untilNextInvoke(text, argAt, code);
    const argMatch = /^\s*(IPC\.([A-Z0-9_]+)|"([^"]+)")/.exec(tail);
    if (!argMatch) continue; // 动态参数(理论上没有)—— 留给下面那条"每一条都认出来了"的断言
    const rpcMatch = /as RpcMap\["([a-zA-Z0-9_.]+)"\]/.exec(tail);
    const constName = argMatch[2];
    const literal = argMatch[3];
    out.push({
      ns: nsAt(m.index),
      arg: constName ?? `"${literal}"`,
      channel: constName ? channelOf(constName) : literal,
      rpcKey: rpcMatch ? rpcMatch[1] : null,
    });
  }
  return out;
}

/** preload 里 `ipcRenderer.on/off` 用到的通道(推送方向)。 */
function preloadPushChannels(text: string): Array<{ arg: string; channel: string | undefined }> {
  const out: Array<{ arg: string; channel: string | undefined }> = [];
  for (const fn of ["on", "off"]) {
    for (const m of text.matchAll(new RegExp(`ipcRenderer\\.${fn}\\(`, "g"))) {
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + NEAR);
      const am = /^\s*(IPC\.([A-Z0-9_]+)|"([^"]+)")/.exec(tail);
      if (!am) continue;
      out.push({
        arg: am[2] ?? `"${am[3]}"`,
        channel: am[2] ? channelOf(am[2]) : am[3],
      });
    }
  }
  return out;
}

/* ────────────────────── 第 3 层:主进程里的 handler ────────────────────── */

/**
 * 主进程注册 handler 的**四种**真实写法(去 `src/main/` 里看,全都存在):
 *
 *   1. `ipcMain.handle(IPC.CLAUDE_START_SESSION, …)`       —— 用契约常量(主流)
 *   2. `ipcMain.handle(MEMORY_LIST_CHANNEL, …)`            —— 用 `@contracts/memory` 的常量
 *   3. `ipcMain.handle(MONITORING_OVERVIEW, …)`            —— 文件内 `const X = "…"` 局部常量
 *   4. `ipcMain.handle("claude:healthCheck", …)`           —— 裸字面量(不带常量)
 *
 * 间接注册的 handler,扫描器要认得出并说出来,否则它们会伪装成"没接过":
 *   - `target.handle(channel, …)`        —— `ipc/index.ts` 里的 DB 就绪包装器,通道名是形参
 * 这两处靠**形参类型是 `IpcMain`** 认出来(见 `IpcMain` 参数扫描)。
 *
 * 全局常量(方案 2)由 `contractsGlobalConsts()` 覆盖 `packages/contracts/src/**` 里
 * 所有 `export const X = "literal";` —— 与 `IPC` 表那条 `MEMORY_*` 用的是同一份字面量,
 * 所以两边天然一致,不需要在这里再对一遍。
 */
const RECEIVER_METHOD = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.(handle|on)\(/g;

interface HandlerSite {
  file: string;
  line: number;
  /** 解析出来的通道名;null = 解析不出来。 */
  channel: string | null;
  /** 原始实参文本(报告用)。 */
  raw: string;
}

/** `packages/contracts/src/**` 里所有 `export const X = "literal";`。 */
function contractsGlobalConsts(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of walk(CONTRACTS)) {
    const src = read(file);
    for (const m of src.matchAll(/^export const ([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*;/gm)) {
      map.set(m[1], m[2]);
    }
  }
  return map;
}

/**
 * 主进程某文件内的 `const X = "literal";` 或 `const X = OTHER_CONST;`。
 *
 * ⚠️ **不要求分号。** `ipc/monitoring.ts` 里写的是 `const MONITORING_OVERVIEW = "monitoring:overview";`,
 * 而 `ipc/memory.ts` 里那几条是 `const { MEMORY_LIST_CHANNEL } = ...` 的 import —— 前者有分号,
 * 但**换个格式化器就会没有**(prettier 的 `semi: false` 模式)。要分号等于把这一套绑在
 * 排版习惯上:少一个分号,`memory:*` 那五条就从"认出来了"变成"解析不出来",红得莫名其妙。
 * 所以这里只要求"行尾是那个字面量/标识符",后面是不是 `;` 不管。
 */
function fileLocalConsts(src: string, globals: Map<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of src.matchAll(/^\s*const ([A-Z][A-Z0-9_]*)\s*=\s*("([^"]*)"|([A-Z][A-Z0-9_]*))\s*;?\s*$/gm)) {
    const literal = m[3];
    const ref = m[4];
    const value = literal !== undefined ? literal : globals.get(ref);
    if (value !== undefined) map.set(m[1], value);
  }
  return map;
}

/** 形参名 → 类型,用来认出 `ipc.handle(...)` / `target.handle(...)` 这两处间接写法。 */
function ipcParamNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*IpcMain\b/g)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * 形参名 → 是否"收 IPC 通道"的形参(`handle(channel: string, handler: X): Y`)。
 *
 * `main/ipc/index.ts` 那个 DB 就绪包装器就是这一条:
 *
 *   ```ts
 *   handle(channel, handler) { target.handle(channel, async (event, raw) => …) }
 *   ```
 *
 * 它**自己**不是一次注册,是"每一条注册都要穿过的那一层"。所以那个 `channel` 形参
 * 要认出来、并且**区分**开:它不是一条漏接的通道,是"通道名的值与类型来自调用方"。
 * 认出来的判据只有一条 —— **那是某个 `handle(` 的第一个形参**。
 */
function channelParams(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/\bhandle\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*string)?\s*,/g)) {
    names.add(m[1]);
  }
  // `handle(channel, handler)` 之外还有一种:解构或纯形参名不带类型 —— 上面那条已覆盖。
  return names;
}

/** 直接接收者名 —— 这四种之外的都是别的东西(`req.on` / `child.on` / …),不扫。 */
const DIRECT_RECEIVERS = new Set(["ipcMain", "ipc"]);

interface HandlerScan {
  sites: HandlerSite[];
  /** 直接接收者里解析不出通道名的实参(报告用,正常应为空)。 */
  unresolved: HandlerSite[];
  /** 通道名来自形参的那几处(包装器本身;不是漏接线,但要看得见)。 */
  viaParam: HandlerSite[];
  /** 疑似 IPC 注册但接收者不是上面那几个名字的(报告用;今天应为空)。 */
  otherReceivers: Array<{ file: string; line: number; receiver: string; raw: string }>;
  /** 走 DB 包装器那种"接收者靠形参类型认出来"的站点(报告用)。 */
  indirect: HandlerSite[];
}

function scanMainHandlers(globals: Map<string, string>): HandlerScan {
  const sites: HandlerSite[] = [];
  const unresolved: HandlerSite[] = [];
  const viaParam: HandlerSite[] = [];
  const otherReceivers: HandlerScan["otherReceivers"] = [];
  const indirect: HandlerSite[] = [];

  for (const path of walk(MAIN)) {
    const src = read(path);
    /**
     * ⚠️ 扫描要在**挖空注释与字符串之后**的那一份上做 —— 否则一条被注掉的
     * `ipcMain.handle(IPC.X, …)` 会被算成"接好了",而这正是最要命的那种绿。
     * 通道名与实参都从**原文** `src` 里取(挖空后那些字面量是空格,读不出来了),
     * 但**判断"这里是不是一次注册"只用挖空版**。
     */
    const code = blankCommentsAndStrings(src);
    const rel = relative(MAIN, path).replace(/\\/g, "/");
    const locals = fileLocalConsts(src, globals);
    const ipcParams = ipcParamNames(src);
    const chanParams = channelParams(src);

    for (const m of code.matchAll(RECEIVER_METHOD)) {
      const receiver = m[1];
      const open = m.index + m[0].length - 1;
      const raw = balancedArg(src, open).split("\n")[0].trim().slice(0, 60);
      const line = src.slice(0, m.index).split("\n").length;
      const isIpc = DIRECT_RECEIVERS.has(receiver) || ipcParams.has(receiver);

      if (!isIpc) {
        // 只在"实参长得像 IPC 通道"时才抱怨:别的东西(`req.on("error")`)是绝大多数。
        if (/^\s*(IPC\.|"[a-z][a-zA-Z0-9_]*:[^"]*")/.test(` ${src.slice(open + 1, open + 40)}`)) {
          otherReceivers.push({ file: rel, line, receiver, raw });
        }
        continue;
      }

      const am = /^\s*(?:IPC\.([A-Z0-9_]+)|"([^"]+)"|([A-Z][A-Z0-9_]*))/.exec(
        src.slice(open + 1, open + 80),
      );
      /**
       * 裸标识符那条要查**两处**:本文件的局部 `const`(`monitoring.ts` 的
       * `MONITORING_OVERVIEW`)与契约包的 `export const`(`memory.ts` 从
       * `@contracts/memory` import 的那五个 `MEMORY_*_CHANNEL`)。
       * 少查 globals 那一处,`memory:*` 五条就会**伪装成"主进程没接"** ——
       * 这是本套自己最容易犯的错(`ipc/memory.ts` 的注释里写着那两份值是刻意同一份)。
       */
      const channel = am
        ? (am[2] ?? (am[1] ? channelOf(am[1]) : undefined) ?? locals.get(am[3]) ?? globals.get(am[3]))
        : undefined;
      const site: HandlerSite = { file: rel, line, channel: channel ?? null, raw };
      sites.push(site);
      if (!channel) {
        // 包装器形参(`target.handle(channel, …)`)—— 不是漏接线,是"通道名由调用方给"。
        const argText = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/.exec(src.slice(open + 1, open + 40));
        if (argText && chanParams.has(argText[1])) viaParam.push(site);
        else unresolved.push(site);
      }
      if (ipcParams.has(receiver)) indirect.push(site);
    }
  }
  return { sites, unresolved, viaParam, otherReceivers, indirect };
}

/* ────────────────────── 判据 A:每一条推送通道都要有人发 ────────────────── */

/**
 * 主进程把事件送出界面的唯一出口是 `sendToRenderer(channel, …)`
 * (`main/window.ts`)。推送方向的判据是**两边的名单必须相等**:
 * preload 在监听谁,主进程就得发给谁;主进程发给谁,preload 就得有人听。
 * 少一边的症状:界面订阅了一个永不响的通道(或者主进程在往虚空里发)。
 */
function sentToRendererChannels(): Set<string> {
  const out = new Set<string>();
  for (const path of walk(MAIN)) {
    const src = read(path);
    for (const m of src.matchAll(/sendToRenderer\(\s*(?:IPC\.([A-Z0-9_]+)|"([^"]+)")/g)) {
      const channel = m[2] ?? (m[1] ? channelOf(m[1]) : undefined);
      if (channel) out.add(channel);
    }
  }
  return out;
}

/**
 * 三条**刻意**的、不算问题的东西。列在这里而不是散在断言里,是为了让"为什么它不算"
 * 有地方写清楚 —— 下一个人看到这里没红,不会以为漏了。
 *
 *  - `__mcode_pick_result__` —— 内嵌浏览器那个**独立 preload**(`src/preload/browserPicker.ts`,
 *    electron.vite 里打成第二个 bundle `out/preload/browserPicker.mjs`)从远程页面点选完
 *    元素后 `ipcRenderer.send` 回来的。它不是 renderer→main 的 RPC:没有 `RpcMap` 键、
 *    不走 `invoke`、`window.api` 上也没有它。`main/browser/BrowserManager.ts` 里
 *    `ipcMain.on("__mcode_pick_result__", …)` 就是它的全部接线,**两边都在,不需要第三层**。
 *    主进程那边是裸字面量(它本来就不该有常量 —— 常量表是给 `window.api` 那一层用的)。
 *  - `dialog:pickFolder` —— 一条**直接写字面量、不带 `RpcMap` 标注**
 *    的 invoke(见检查 1 里钉住它的那条断言)。它**有** handler,只是通道名不在 `IPC` 表里。
 */
const KNOWN_NON_CONTRACT_CHANNELS = new Set([
  "__mcode_pick_result__",
  "dialog:pickFolder",
]);

/* ══════════════════════════ 开始扫描 ══════════════════════════ */

const rpcMapFile = join(CONTRACTS, "ipc/rpcMap.ts");
const preloadSrc = read(PRELOAD);
const rpcKeys = rpcMapKeysOfFile(rpcMapFile);
const invokes = preloadInvokes(preloadSrc);
const pushes = preloadPushChannels(preloadSrc);
const globals = contractsGlobalConsts();
const scan = scanMainHandlers(globals);

const handledChannels = new Set<string>();
for (const s of scan.sites) if (s.channel) handledChannels.add(s.channel);

const invokeChannels = new Set<string>();
for (const r of invokes) if (r.channel) invokeChannels.add(r.channel);

const pushChannels = new Set<string>();
for (const p of pushes) if (p.channel) pushChannels.add(p.channel);

const sentChannels = sentToRendererChannels();

/* ────────────────────── 检查 0:扫描器自己得能认出坏东西 ────────────────── */

/**
 * 一套"永远绿"的测试比没有测试更坏 —— 它会让下一个人以为自己有保护。所以先拿
 * **人造样本**喂给同一批扫描器:一份是好样子,一份正是"漏了一层"的形状。
 * 第二份**必须**被认出来,否则下面任何一条总判据都只是摆设。
 */
console.log("\n扫描器自检(能不能认出「漏了一层」的那种)");
{
  const mapSample = [
    'export interface RpcMap {',
    '  "demo.good": (input: X) => Promise<void>;',
    '  "demo.leaky": (input: X) => Promise<void>;',
    '}',
  ].join("\n");
  const preloadSample = [
    "const api = {",
    '  demo: {',
    "    good: ((input) =>",
    "      ipcRenderer.invoke(IPC.DEMO_GOOD, input)) as RpcMap[\"demo.good\"],",
    "  },",
    "} as const;",
  ].join("\n");
  const mainSample = [
    "export function registerDemoHandlers(ipcMain: IpcMain): void {",
    "  ipcMain.handle(IPC.DEMO_GOOD, () => 1);",
    "}",
  ].join("\n");
  const ipcSample = { DEMO_GOOD: "demo:good" } as Record<string, string>;
  const keysOf = (t: string) => rpcMapKeys(t);
  const preIn = preloadInvokes(preloadSample);
  check(
    "认得出契约里的键(含漏接线的那条)",
    keysOf(mapSample).join(",") === "demo.good,demo.leaky",
    keysOf(mapSample),
  );
  check(
    "认得出 preload 里那条配对的常量 + 标注",
    preIn.length === 1 && preIn[0].arg === "DEMO_GOOD" && preIn[0].rpcKey === "demo.good",
    preIn,
  );
  check(
    "认得出主进程里的 ipcMain.handle(IPC.X)",
    /ipcMain\.handle\(IPC\.DEMO_GOOD/.test(mainSample) && ipcSample.DEMO_GOOD === "demo:good",
  );
}

/* ──────────────── 检查 0.5:扫描器扫到的都是真东西(不是空跑) ──────────── */

console.log("\n扫描器自己(名字对不对得上一件真事)");
check(
  `cwd 就是 apps/desktop(否则下面扫的是别的树,"全过"没有意义)`,
  existsSync(join(DESKTOP, "package.json")) && existsSync(MAIN) && existsSync(CONTRACTS),
  DESKTOP,
);
check(`扫到了契约的 RpcMap 键(共 ${rpcKeys.length} 条)`, rpcKeys.length > 200, rpcKeys.length);
check(`扫到了 preload 的 invoke(共 ${invokes.length} 条)`, invokes.length > 200, invokes.length);
check(`扫到了主进程的 handler(共 ${scan.sites.length} 处)`, scan.sites.length > 200, scan.sites.length);
check(
  `preload 的每一条 invoke 都认出了通道名(没有解析不出来的)`,
  invokes.every((r) => typeof r.channel === "string"),
  invokes.filter((r) => !r.channel).map((r) => r.arg),
);
check(
  `主进程每一处 handle/on 都解析出了通道名`,
  scan.unresolved.length === 0,
  scan.unresolved.map((s) => `${s.file}:${s.line} ${s.raw}`),
);
check(
  "认得出 DB 就绪包装器那条间接写法(target.handle(channel) 的通道名来自形参,不算漏接线)",
  scan.viaParam.some((s) => s.file === "ipc/index.ts"),
  scan.viaParam.map((s) => `${s.file}:${s.line} ${s.raw}`),
);
check(
  "没有「疑似 IPC 注册、但接收者名字不认识」的地方",
  scan.otherReceivers.length === 0,
  scan.otherReceivers.map((s) => `${s.file}:${s.line} ${s.receiver}(${s.raw})`),
);
check(
  "认得出 DB 就绪包装器那条间接写法(target.handle(channel))",
  scan.indirect.some((s) => s.file === "ipc/index.ts"),
  scan.indirect.map((s) => `${s.file}:${s.line}`),
);

/* ────────────────── 检查 1:RpcMap 的键 ↔ preload 的映射 ────────────────── */

console.log("\n第 1 层 → 第 2 层:RpcMap 里写了的,preload 得发得出去");
console.log(`  (真相 A = ${relative(DESKTOP, rpcMapFile).replace(/\\/g, "/")} 的 interface RpcMap)`);
console.log(`  (真相 B = ${relative(DESKTOP, PRELOAD).replace(/\\/g, "/")} 的 as RpcMap["…"] 标注)`);

const annotatedKeys = new Set(invokes.filter((r) => r.rpcKey).map((r) => r.rpcKey as string));
diff("契约里每一条 RPC,preload 都有对应的映射", rpcKeys, annotatedKeys, "RpcMap", "preload");

// 反向:preload 标了 `RpcMap["x.y"]` 而契约里没这个键 —— 名字漂了 / 抄错了。
diff("preload 标出来的每一条,契约里都真的有", annotatedKeys, rpcKeys, "preload", "RpcMap");

/**
 * 同一个语句里,`IPC.XXX` 的通道名与 `as RpcMap["a.b"]` 的键**必须指的是同一件事**。
 * 这是第 2 层自己内部的判据,不需要第三份真相 —— 它抓的是"复制粘贴时改了标注没改常量"
 * (那会让调用端拿到一个真实存在的通道,但类型说的是另一条)。
 *
 * 三个**认识的例外**(都写在源码的注释里,不是漏):
 *   - `skills.engines.set` —— 键里两个点,通道名是 `skills:enginesSet`(驼峰),拼不出规律;
 *   - `MEMORY_*` 五条 —— 常量名以 `_CHANNEL` 结尾,值来自 `@contracts/memory`;
 *   - B 类(pickFolder)—— 没有标注,下面单独钉住。
 */
const KNOWN_KEY_FORM_MISMATCH = new Set([
  "skills.engines.set",
  "memory.list",
  "memory.read",
  "memory.save",
  "memory.delete",
  "memory.categories",
]);
const mismatched = invokes
  .filter((r) => r.rpcKey !== null && !KNOWN_KEY_FORM_MISMATCH.has(r.rpcKey))
  .filter((r) => {
    const rpcNs = (r.rpcKey as string).split(".");
    const channel = r.channel ?? "";
    const colon = channel.indexOf(":");
    if (colon < 0) return true;
    return channel.slice(0, colon) !== rpcNs[0] || channel.slice(colon + 1) !== rpcNs[rpcNs.length - 1];
  });
check(
  "每一条 preload 映射里,常量通道与 RpcMap 键说的是同一条",
  mismatched.length === 0,
  mismatched.map((r) => `${r.arg} → ${r.channel} 但标注 ${r.rpcKey}`),
);

/**
 * B 类:preload 上这条**直接写字面量、不带 RpcMap 标注**的。它是历史遗留,
 * 不是本套要修的东西 —— 但必须**钉住**(数量、名字、通道),否则"以后新加一条也照抄
 * 这种写法"就绕过了上面所有的断言,而这一套会静默放行。
 */
const literalInvokes = invokes.filter((r) => r.rpcKey === null);
check(
  "不带 RpcMap 标注的 invoke 仍然只有已知的 pickFolder",
  literalInvokes.length === 1 && literalInvokes[0]?.channel === "dialog:pickFolder",
  literalInvokes.map((r) => `${r.ns}.? → ${r.channel}`),
);

/* ────────────────── 检查 2:preload 的通道 ↔ 主进程的 handler ────────────── */

console.log("\n第 2 层 → 第 3 层:preload 发得出去的,主进程得有人接");
console.log(`  (真相 A = ${relative(DESKTOP, PRELOAD).replace(/\\/g, "/")} 的 ipcRenderer.invoke)`);
console.log(`  (真相 B = src/main/** 的 ipcMain.handle / ipcMain.on)`);

/**
 * 推送通道(22 条)只出现在 `ipcRenderer.on`,永远不会 `invoke` —— 它们不该有 handler。
 * 反过来说,凡是 `invoke` 出去的通道,必须有 handler。两类的划分**不靠手抄名单**,
 * 而是按"preload 里是怎么用它的"自动分出来的:
 *   - 只 on、从不 invoke ⇒ 推送;
 *   - 只出现一次的那个 `notification:focusSession` 两边都有(主进程既可被调、也会发),
 *     它在下面单独钉住 —— 它不是"事件 vs 方法"二选一,它两样都是。
 */
const BOTH_WAYS = new Set(["notification:focusSession"]);

check(
  `invoke 的通道与推送的通道没有重叠(除了已知的 ${[...BOTH_WAYS].join(", ")})`,
  [...invokeChannels].filter((c) => pushChannels.has(c) && !BOTH_WAYS.has(c)).length === 0,
  [...invokeChannels].filter((c) => pushChannels.has(c) && !BOTH_WAYS.has(c)),
);

diff("preload 每次 invoke 出去的通道,主进程都有 handle", invokeChannels, handledChannels, "preload", "main");

/**
 * 反向:主进程接了但 preload(`window.api`)从没发过 —— 死 handler,或者名字两边漂了。
 *
 * `__mcode_pick_result__` 要加回右边(它来自那个独立 preload,不走 `window.api`),
 * 但它**不是靠这条豁免活下来的** —— 下面有一条专门钉住它两边都在。豁免只是不让它
 * 出现在这条方向性断言的差集里(那条断言问的是"`window.api` 这一层")。
 */
const NON_API_HANDLER_CHANNELS = ["__mcode_pick_result__"];
diff(
  "主进程每条 handle 的通道,preload 都发得出去(或属于已知的独立 preload)",
  [...handledChannels].sort(),
  [...invokeChannels, ...NON_API_HANDLER_CHANNELS].sort(),
  "main",
  "preload",
);

/**
 * 钉住那条独立 preload 的两端。它不是本套要管的三层之一,但"主进程单方面收一个没人发的
 * 通道"和"独立 preload 在发一个没人收的通道"都是真 bug —— 而它们只在这条断言里看得见。
 */
{
  const browserPicker = read(join(DESKTOP, "src/preload/browserPicker.ts"));
  const pickSent = [...browserPicker.matchAll(/ipcRenderer\.send\(\s*"([^"]+)"/g)].map((m) => m[1]);
  check(
    "内嵌浏览器的独立 preload 发的通道,主进程正好收着那一端",
    pickSent.length === 1 && handledChannels.has(pickSent[0]),
    { browserPickerSends: pickSent, mainOnlyHandlers: [...handledChannels].filter((c) => !invokeChannels.has(c)) },
  );
}

// 自检:上面那条反向断言如果因为"主进程也接推送通道"而失真,这里挡住。
const handledPush = [...pushChannels].filter((c) => handledChannels.has(c));
check(
  `主进程接的每个通道都确实是被 invoke 的(不是把推送通道算进来凑数)`,  handledPush.every((c) => BOTH_WAYS.has(c)),
  handledPush.filter((c) => !BOTH_WAYS.has(c)),
);

/* ────────────────── 检查 3:推送通道:preload 在听、主进程在发 ─────────── */

console.log("\n推送方向:preload 监听的每一条,主进程都要发得出去");
diff(
  "preload 订阅的每个推送通道,主进程都 sendToRenderer 过",
  [...pushChannels].sort(),
  [...sentChannels].sort(),
  "preload.on",
  "main.sendToRenderer",
);
diff(
  "主进程 sendToRenderer 的每个通道,preload 都有人听",
  [...sentChannels].sort(),
  [...pushChannels].sort(),
  "main.sendToRenderer",
  "preload.on",
);

/* ────────────────── 检查 4:手机端(独立组件树,走 HTTP 桥) ────────────── */

/**
 * 手机端这一层比前两层**薄**,而且薄在什么地方必须说清楚。
 *
 * 这一条能做到的、也是真正会红的那一条:
 *
 *   > `webApi.ts` **路由**到的每个通道(`rpc("claude:startSession")`),主进程的移动
 *   > 白名单(`mobileRpc.ts` + `mobileGitRpc.ts` 的 key)里必须有。
 *
 * 这正是那个已经踩过的坑的形状:共用组件调一个 RPC → webApi 有这一项 → 白名单没有 →
 * 服务端 404 → 前端同步抛 → React 19 整棵卸载。
 *
 * **做不到的(不硬凑)**:webApi 里 `webUnsupported(...)` 的 59 项**没法自动断言**。
 * 那个函数抛的是"桌面端专属,手机上不可用",而它是对还是错取决于**共用组件会不会在
 * 手机端调到它** —— 那是一个可达性问题(哪个组件挂在 `AppMobile` 那棵树上),不是
 * 文本形状能回答的。今天它是**刻意**的:源码里写着几条注释解释了为什么某些路由留着
 * 只为满足 `Api[...]` 的类型完整性(`session.fork` / `claude.inject` / `listSideChats` /
 * `saveSubagents` / `git.fileBlob`),而这些路由的调用点都在手机端不挂载的组件里
 * (IDE 的 Git 面板、设置页的子代理编辑器、桌面左栏)。所以下面**只报不判**。
 *
 * 另外两条小的、确实能判的:
 *   - `on` 那 22 个推送订阅的键,webApi 必须**逐个列全**(源码注释写着:少一个键连类型
 *     检查都过不去;而 Proxy 上未列出的名字会**同步抛**,那正是卸载 React 的路径)。
 *   - `webApi` 里的通道字面量必须是契约里真的有的通道(打字错了会在 404 那一层才炸)。
 */
console.log("\n手机端:webApi 路由到的通道,移动白名单里必须有");
console.log(`  (真相 A = ${relative(DESKTOP, WEB_API).replace(/\\/g, "/")} 的 rpc("<通道>") 字面量)`);
console.log(`  (真相 B = ${relative(DESKTOP, MOBILE_RPC).replace(/\\/g, "/")} 的 HANDLERS key)`);

const webApiSrc = read(WEB_API);
const webRouted = new Set<string>();
for (const m of webApiSrc.matchAll(/rpc\(\s*"([^"]+)"/g)) webRouted.add(m[1]);

const mobileServed = new Set<string>();
for (const path of [MOBILE_RPC, MOBILE_GIT_RPC]) {
  const src = read(path);
  for (const m of src.matchAll(/^\s*"([a-zA-Z0-9_]+:[a-zA-Z0-9_]+)"\s*:/gm)) mobileServed.add(m[1]);
}

/**
 * 六条**服务端不认、但手机端跑不到**的路由。这是本套最需要解释的一处,别一眼看成漏。
 *
 * `webApi.ts` 是个**全量手写**的 `Api` 形状(`const claude: Api["claude"] = {…}`),
 * 所以共用组件里**每加一个 RPC 都要在这里补一项** —— 补不上就会同步抛、React 19 整棵卸载。
 * 这个坑是真的,而这一条断言就是为它写的。下面六条是它今天唯一的缺口,
 * 每条都**核过"调用点在哪棵树上"**:
 *
 *   - `session:listAll` —— 调用方只有 `sessionStore.loadStreamSessions`,
 *     而它只在 `components/layout/StreamSidebar.tsx` 里被调;`AppMobile` 不挂 StreamSidebar。
 *   - `claude:listSideChats` —— 调用方是 `sessionStore.hydrateSideChats`,
 *     而手机端**明确没有**侧聊(`SessionTabs` 里的 `sideChatsByParent` 是桌面左栏的东西)。
 *   - `session:fork` / `claude:inject` / `claude:saveSubagents` —— `webApi.ts` 自己的
 *     注释就写着它们是"仅为满足 `Api[...]` 的类型完整性"而留的(手机上没有那几个入口)。
 *   - `git:fileBlob` —— 调用方是 `components/ide/GitRepoCard.tsx`;手机端那个 Git 屏
 *     (`components/mobile/MobileGitScreen.tsx`)只调 discoverRepos/status/stage/unstage/
 *     commit/push/pull/listBranches/checkout/generateCommitMessage/cancelGenerateCommitMessage
 *     —— **文件内容对比在手机上不存在**,所以 `fileBlob` 到不了。
 *
 * ⚠️ 也就是说这张名单是**手工核出来的**,不是自动推出来的。所以下面配了一条**反查**:
 * 名单里每一条仍然必须真是"`webApi` 路由了、白名单没服务"的那个状态;一旦有人把某条
 * 服务端补上(或者把路由删掉),这条会红 —— 那份名单不会静静地过期成一句谎话。
 */
const MOBILE_UNREACHABLE_ROUTES = new Set([
  "claude:inject",
  "claude:listSideChats",
  "claude:saveSubagents",
  "git:fileBlob",
  "session:fork",
  "session:listAll",
]);

diff(
  "webApi 路由到的每个通道,移动白名单里都有(或属于已核过「手机端跑不到」的那几条)",
  webRouted,
  [...mobileServed, ...MOBILE_UNREACHABLE_ROUTES],
  "webApi",
  "mobileRpc",
);

/**
 * 反查上一行的豁免名单没过期:上面那六条必须**仍然**是"webApi 有、白名单没有"。
 * 谁把它们补上了服务端(或删了路由),这一条就红 —— 提醒把名单里那一条删掉,
 * 而不是让它继续豁免一条其实已经接好的路由。
 */
const staleExemptions = [...MOBILE_UNREACHABLE_ROUTES].filter(
  (c) => !webRouted.has(c) || mobileServed.has(c),
);
check(
  "「手机端跑不到」那六条豁免没有过期(仍是「路由了、白名单没服务」的状态)",
  staleExemptions.length === 0,
  staleExemptions,
);

/** `claude:healthCheck` 是**两处都刻意**不走 `IPC` 表的裸通道(见检查 1 的 B 类),单独认。 */
const KNOWN_UNLISTED_CHANNELS = new Set(["claude:healthCheck"]);
check(
  "webApi 里的通道名都是契约里真的有的(没打字打错)",
  [...webRouted].every((c) => CHANNELS.has(c) || KNOWN_UNLISTED_CHANNELS.has(c)),
  [...webRouted].filter((c) => !CHANNELS.has(c) && !KNOWN_UNLISTED_CHANNELS.has(c)),
);
check(
  "移动白名单里的通道名都是契约里真的有的(没打字打错)",
  [...mobileServed].every((c) => CHANNELS.has(c) || KNOWN_UNLISTED_CHANNELS.has(c)),
  [...mobileServed].filter((c) => !CHANNELS.has(c) && !KNOWN_UNLISTED_CHANNELS.has(c)),
);

/** `on` 的键:preload 是**唯一真相**,webApi 必须逐个列全(注释里写着这是硬要求)。 */
const onKeysOf = (src: string, open: string, entryRe: RegExp): string[] =>
  [...src.slice(src.indexOf(open)).matchAll(entryRe)].map((m) => m[1]);
const onPreload = [...preloadSrc.slice(preloadSrc.indexOf("  on: {")).matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]);
const onWeb = [
  ...webApiSrc
    .slice(webApiSrc.indexOf('const on: Api["on"] = {'))
    .matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm),
].map((m) => m[1]);
void onKeysOf;
check(`preload 的 on 有 ${onPreload.length} 个订阅(与 push 通道数一致)`, onPreload.length === pushChannels.size, {
  preloadOn: onPreload.length,
  pushChannels: pushChannels.size,
});
diff("webApi 的 on 把 preload 的每个订阅都列全了(少一个 = 手机端同步抛)", onPreload, onWeb, "preload.on", "webApi.on");
diff("webApi 的 on 没有多出来的键", onWeb, onPreload, "webApi.on", "preload.on");

/**
 * 只报不判:webApi 里 `webUnsupported` 的那些(桌面端专属声明)。**列出来是为了让
 * 下一个人一眼看到"哪些路由在手机上是死路"** —— 判断它们对不对要去看组件可达性,
 * 那是人做的事,不是这一套能自动回答的。
 */
const unsupportedRoutes = [...webApiSrc.matchAll(/webUnsupported\(\s*"([^"]+)"\)/g)].map((m) => m[1]);
console.log(
  `\n  (仅报告,不断言)webApi 里声明为「桌面端专属」的路由 ${unsupportedRoutes.length} 条:` +
    `\n    ${unsupportedRoutes.join(" ")}`,
);

/* ────────────────────── 收尾 ────────────────────── */

// 两个已退役的 composer 功能不能只藏按钮：各自的调用链也必须断开。
const toolbar = read(join(DESKTOP, "src/renderer/components/chat/ComposerToolbar.tsx"));
const sessionStore = read(join(DESKTOP, "src/renderer/stores/sessionStore.ts"));
const rpcMap = read(rpcMapFile);
check("会话插件选择器已离开 composer", !toolbar.includes("PluginResidencyControl"));
check("长任务按钮已离开 composer，守望仍保留", !toolbar.includes("LongTaskSegment") && toolbar.includes("<WatchSegment"));
check("长任务状态和自动续轮不再由会话 store 驱动", !sessionStore.includes("longTaskBySession") && !sessionStore.includes("api.longtask.start"));
check("长任务 RPC 契约和 IPC 常量已移除", !rpcMap.includes('"longtask.start"') && !rpcMap.includes("LONGTASK_START"));
check("preload 不再暴露长任务入口", !preloadSrc.includes("IPC.LONGTASK_START"));
check("主进程不再启动循环器", !read(join(MAIN, "index.ts")).includes("longTaskRunner"));
check("运行时事件不再广播长任务", !read(join(CONTRACTS, "runtime.ts")).includes("LongTaskUpdateEvent"));
check("主进程不再读写历史长任务", !read(join(MAIN, "store/repositories.ts")).includes("LongTaskRepo"));

if (failures > 0) {
  console.error(`\n${failures} failed, ${checks - failures} passed`);
  process.exit(1);
}
console.log(`\n${checks}/${checks} 通过`);
