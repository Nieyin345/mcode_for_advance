/**
 * `ipc/index.ts` 的回归网 —— 但它验的不是那个文件本身,而是**它守的那条规矩**。
 *
 * ## 为什么这套是这样写的
 *
 * `CLAUDE.md` 第一条:"**契约先行**。IPC 方法(`RpcMap` 313 个)的 schema 定义在
 * `packages/contracts/src/ipc/` → preload 白名单 → 主进程 handler。**加一条 IPC
 * 要走全三层,缺一层调用端就看不到**。"
 *
 * 而 `ipc/index.ts` 是那座总注册表(`registerIpcHandlers` 把 36 个域的
 * `register*Handlers` 串起来),所以"三层对不对得上"的落脚点在这里。
 *
 * 缺一层的三种形状,后果各不一样:
 *
 * | 缺哪层 | 现象 |
 * |---|---|
 * | 契约有、主进程没注册 | 渲染端调下去 → Electron 抛 `No handler registered` |
 * | 契约有、preload 没放行 | 渲染端**根本调不到**(`window.api.x.y` 是 undefined)|
 * | 同一个渠道注册两次 | Electron **启动即抛**,应用起不来 |
 *
 * 三种 typecheck 都报不出来(第一、三种完全在运行时),所以要有这一套。
 *
 * ## 为什么是读源码文本,以及为什么必须**解析标识符**
 *
 * `registerIpcHandlers()` 真跑起来要起整个 Electron。而这里要断言的东西
 * (注册了哪些渠道)在源码里是静态的:渠道名到不了运行时,只能是常量。
 *
 * 但"只能是常量"不等于"都走 `IPC.*`":这个仓库里其实有**三种写法**同时存在 ——
 *
 *   ```ts
 *   ipcMain.handle(IPC.TERMINAL_CREATE, …)        // 从 @contracts/ipc 取的 barrel 常量
 *   ipcMain.handle(MEMORY_LIST_CHANNEL, …)        // 从 @contracts/memory 直接取的域常量
 *   ipcMain.handle("claude:healthCheck", …)       // 就地写的字面量(见 §4)
 *   const MONITORING_OVERVIEW = "monitoring:overview";  // 先落到本文件的 const 再注册
 *   ```
 *
 * 第一版只认第一种,于是 memory / monitoring 那七个渠道**看着像"契约有、主进程
 * 没注册"** —— 一个假阳性,而且是最坏的那种:它让人去改对的代码。所以这一版按
 * **per-file 的标识符绑定**解析:读那个文件的 import 语句,把 `IPC.X` 和
 * `域常量` 都还原成渠道字符串,再由这个文件里的局部 `const` 接一层。
 *
 * ⚠️ 副作用是这套**会跟着 import 语句的写法走**。以后有人换一种新写法(比如
 * `import * as C from …` + `C.X`),这套会把它误报成"没注册"。真遇到了就在
 * `resolveBindings` 里补一种,别删断言。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { IPC } from "@contracts/ipc";

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
/** `Object.is` 比不了数组;这个连顺序都要一样。 */
function eqArr(name: string, actual: readonly unknown[], expected: readonly unknown[]): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const APP = process.cwd();
const SRC = join(APP, "src");
const read = (p: string): string => readFileSync(p, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const CONTRACT_CHANNELS = new Set(Object.values(IPC) as string[]);

// ────────────────────────────────────────────────────────────────
// §1 契约侧:IPC 常量表本身的完整性
// ────────────────────────────────────────────────────────────────
console.log("\n§1 契约侧:IPC 常量表");

const entries = Object.entries(IPC) as Array<[string, string]>;
const byChannel = new Map<string, string[]>();
for (const [key, channel] of entries) {
  const list = byChannel.get(channel);
  if (list) list.push(key);
  else byChannel.set(channel, [key]);
}

/**
 * 表里是不是**每个键都指向唯一一个渠道字符串**。
 *
 * 两个键指向同一个字符串不会当场炸,但意味着有一条通道有**两个名字** —— 加
 * 消息、改白名单时改一处漏一处,而且从两边读代码都看不出它们是同一条。
 */
eqArr(
  "表里没有两个键指向同一个渠道字符串",
  [...byChannel.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([ch, keys]) => `${ch} ← ${keys.join(",")}`),
  [],
);

/**
 * 渠道字符串必须都是 `<域>:<动作>` 的形状。
 *
 * 这条不是洁癖:preload 那条桥、主进程的 `handle`、以及以后可能有的按域过滤
 * 都按这个形状切域名。掺进一个 `foo.bar` 或裸名字,按域做事的地方会静默漏掉它。
 */
eqArr(
  "每个渠道字符串都是「域:动作」的形状",
  entries.filter(([, ch]) => !/^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9_.-]+$/.test(ch)).map(([k, ch]) => `${k}=${ch}`),
  [],
);

// ────────────────────────────────────────────────────────────────
// §2 主进程侧:注册了哪些渠道
// ────────────────────────────────────────────────────────────────

/**
 * 把一个源文件里所有**能当渠道名用的标识符**换算成渠道字符串。
 *
 * 三条来源:
 *   - 本文件 `import { X } from "@contracts/ipc"` → `IPC` 这个 barrel,
 *     `IPC.KEY` 直接查常量表;
 *   - 本文件 `import { X } from "@contracts/xxx"` → 域常量,去那个契约模块里
 *     找 `export const X = "…"` 的**字面量值**;
 *   - 本文件自己的 `const X = "…"` 或 `const X = IPC.KEY` → 局部名(monitoring.ts
 *     那种"渠道名先就地定义"的写法)。
 *
 * 还额外收一层 `const A = B` 的转发,够这个仓库现有五种写法用。
 */
function resolveBindings(file: string): Map<string, string> {
  const text = read(file);
  const bound = new Map<string, string>();

  // ── a) `IPC.*` 的键名直接可查 ──
  // 不检查这个文件有没有真的 import IPC:重名到 `IPC` 这个名字上的概率是零,
  // 而多认一个不该认的只会让它**更不容易漏报**(这套宁可误报不可漏报)。
  for (const key of Object.keys(IPC)) bound.set(`IPC.${key}`, (IPC as Record<string, string>)[key]);

  // ── b) 从契约模块 import 进来的域常量 ──
  const importRe = /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const m of text.matchAll(importRe)) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim())
      .filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s));
    if (names.length === 0) continue;

    const spec = m[2];
    if (spec === "@contracts/ipc") {
      for (const n of names) {
        const v = (IPC as Record<string, string>)[n];
        if (v !== undefined) bound.set(n, v);
      }
      continue;
    }
    // 契约包内的相对/别名模块 → 落到 packages/contracts/src/…
    const modPath = spec.startsWith("@contracts/")
      ? join(APP, "..", "..", "packages", "contracts", "src", `${spec.slice("@contracts/".length)}.ts`)
      : spec.startsWith(".")
        ? resolvePath(dirname(file), spec)
        : undefined;
    if (modPath === undefined) continue;
    let modText: string;
    try {
      modText = read(modPath);
    } catch {
      continue;
    }
    for (const n of names) {
      const decl = new RegExp(`export\\s+const\\s+${n}\\s*=\\s*"([^"]+)"`).exec(modText);
      if (decl) bound.set(n, decl[1]);
    }
  }

  // ── c) 本文件自己的 const(就地定义的渠道名)──
  // 跑两趟:第一趟只认字面量,第二趟认 `const A = B` 这种指向已知绑定的转发。
  for (let pass = 0; pass < 2; pass++) {
    for (const m of text.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
      const [, name, rhsRaw] = m;
      const rhs = rhsRaw.trim();
      const lit = /^"([^"]+)"$/.exec(rhs);
      if (lit) {
        bound.set(name, lit[1]);
        continue;
      }
      if (bound.has(rhs)) bound.set(name, bound.get(rhs)!);
    }
  }
  return bound;
}

/**
 * 去掉注释,**逐个字符扫**,不是拿两条正则各扫一遍。
 *
 * ## 为什么不能用正则(实测踩到的)
 *
 * 两条正则各自的写法都对,但**顺序**是错的:先删块注释,再删行注释。于是
 * `ipc/claude.ts:120` 这句
 *
 *     // Form fork: "branch" materializes on a generated mcode/* ref (durable
 *
 * 里的 `/*` 被当成了块注释的开头 —— 而它其实在一个**行注释**里面。那个块注释
 * 一路吃到几百行之外才遇上 `*\/`,把中间**五个真的 `ipcMain.handle` 全删了**。
 * 症状是"契约有、主进程没注册"报了 `claude:startSession` 那四条 —— 一个指向
 * 完全正确代码的假阳性,而根因在一个跟 IPC 毫无关系的注释里。
 *
 * 一个字符一个字符扫就没这个问题:进了行注释就不再看 `/*`,进了字符串就不看
 * `//`。要处理的状态一共四种(字符串 / 模板串 / 行注释 / 块注释),模板串里还
 * 可能有 `${}` 嵌套 —— 这里不追求完备(它只用来数 `handle(`,不构成安全边界),
 * 只求**不把代码误删**。
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          out += text[i] + (text[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 把一个文件里所有 `handle(X)` 的 X 换算成渠道字符串。
 *
 * 判据是**"这个参数看起来是不是渠道名"**,不是"这个函数是不是 ipcMain.handle":
 *
 *   - 字符串字面量且以 `<小写域名>:` 开头 → 收;
 *   - `IPC.KEY` 或 `SCREAMING_CASE` 标识符 → 收,查绑定,查不到算**解析不出来**;
 *   - 别的(小写标识符之类)→ **不是渠道表达式,跳过**。
 *
 * 第三条是实测逼出来的:去掉注释之后仍有 `collector.handle(e)`
 * (`monitoring/collector.ts` 里一个不相干的方法,收事件对象)。把它当"解析不出来"
 * 报上来的话,下面那条守卫就永远是红的 —— 而一条永远红的守卫等于没有守卫。
 */
function collectHandlers(file: string, bound: Map<string, string>): { channels: string[]; unknown: string[] } {
  const text = stripComments(read(file));
  const channels: string[] = [];
  const unknown: string[] = [];
  for (const m of text.matchAll(/\.handle\(\s*([^,)]+)/g)) {
    const arg = m[1].trim();
    const lit = /^"([a-z][a-zA-Z0-9]*:[^"]*)"$/.exec(arg);
    if (lit) {
      channels.push(lit[1]);
      continue;
    }
    if (!/^(IPC\.[A-Z0-9_]+|[A-Z][A-Z0-9_]*)$/.test(arg)) continue; // 不是渠道表达式
    const v = bound.get(arg);
    if (v !== undefined) channels.push(v);
    else unknown.push(`${file.slice(SRC.length + 1).replace(/\\/g, "/")}: ${arg}`);
  }
  return { channels, unknown };
}

const mainFiles = walk(join(SRC, "main"));
const mainChannels = new Map<string, string[]>();
const unresolved: string[] = [];
for (const file of mainFiles) {
  const bound = resolveBindings(file);
  const { channels, unknown } = collectHandlers(file, bound);
  unresolved.push(...unknown);
  for (const ch of channels) {
    const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
    const list = mainChannels.get(ch);
    if (list) list.push(rel);
    else mainChannels.set(ch, [rel]);
  }
}

/**
 * 每个 `handle(...)` 的第一个参数都解析出来了。
 *
 * 这条是**这套自己的防空洞**:解析器一旦跟不上某种新写法,上面 `collectHandlers`
 * 会把它丢进 `unknown` 而不是静默跳过 —— 那样 §4 的"漏注册"就会假绿。有了这条,
 * 解析器失灵时红的是这里,读起来就是"解析器要补",不是"契约出问题了"。
 */
eqArr("每个 handle(...) 的渠道名都解析出来了(解析器失灵会红在这里)", unresolved, []);

/**
 * 同一个渠道**不许被注册两次**。
 *
 * Electron 的 `ipcMain.handle` 对重复渠道是直接 **throw**
 * (`Attempted to register a second handler for 'x'`),发生在 `registerIpcHandlers()`
 * 里 = **应用启动即崩**,而且崩在 36 个域串起来的中间某一环,报错只说渠道名、
 * 不说是谁注册的。这条断言把那件事变成一次能读的失败。
 */
eqArr(
  "没有渠道被注册两次(重复注册 = 启动即崩)",
  [...mainChannels.entries()].filter(([, files]) => files.length > 1).map(([ch, files]) => `${ch} ← ${files.join(",")}`),
  [],
);

// ────────────────────────────────────────────────────────────────
// §3 preload 侧:白名单 + 推送订阅
// ────────────────────────────────────────────────────────────────
console.log("\n§3 preload 侧");

const preloadPath = join(SRC, "preload", "index.ts");
const preloadText = read(preloadPath);
const preloadBound = resolveBindings(preloadPath);

/** 渲染端能**发起**的调用(`invoke`)。 */
const preloadInvoked = new Set<string>();
for (const m of preloadText.matchAll(/invoke\(\s*([^,)]+)/g)) {
  const arg = m[1].trim();
  const lit = /^"([^"]+)"$/.exec(arg);
  if (lit) preloadInvoked.add(lit[1]);
  else if (preloadBound.has(arg)) preloadInvoked.add(preloadBound.get(arg)!);
}

/**
 * 主进程 → 渲染端的**推送**渠道。
 *
 * 这份名单是**推出来的,不是手写的**:preload 里每一句 `ipcRenderer.on(X, …)`
 * 就是在告诉这个应用"这条渠道是用来推的"。
 *
 * 手写一份的代价实测过:第一版把推送名单写死成一组 `IPC.*` 常量,里面混进了
 * 两个**根本不存在的键**(`IPC.MCP_EVENT` / `IPC.PLUGINS_EVENT`),于是名单里
 * 混进一个 `undefined`,把下面"推送渠道都在契约表里"那条弄红 —— 而那跟契约
 * 一点关系都没有,纯粹是这份手写名单自己写错了。推出来的就不会有这个问题。
 */
const pushChannels = new Set<string>();
for (const m of preloadText.matchAll(/ipcRenderer\.on\(\s*([^,)]+)/g)) {
  const arg = m[1].trim();
  const lit = /^"([^"]+)"$/.exec(arg);
  if (lit) pushChannels.add(lit[1]);
  else if (preloadBound.has(arg)) pushChannels.add(preloadBound.get(arg)!);
}

eqArr(
  "preload 引用的 IPC 键都在常量表里",
  [...preloadText.matchAll(/IPC\.([A-Z0-9_]+)/g)]
    .map((m) => m[1])
    .filter((k) => (IPC as Record<string, string>)[k] === undefined)
    .filter((k, i, a) => a.indexOf(k) === i)
    .sort(),
  [],
);

// ────────────────────────────────────────────────────────────────
// §4 三层对齐
// ────────────────────────────────────────────────────────────────
console.log("\n§4 三层对齐");

const pushList = [...pushChannels].sort();
check(
  "推送渠道都是从 preload 的 ipcRenderer.on 推出来的(不是手写名单)",
  pushList.length > 15,
  { count: pushList.length },
);
eqArr(
  "推送渠道都在契约表里(推出来的,所以这条其实是在验常量表)",
  pushList.filter((ch) => !CONTRACT_CHANNELS.has(ch)),
  [],
);

/**
 * **契约声明了、主进程没注册。**
 *
 * 这是最坏的一种:typecheck 全过、preload 白名单也有这一项,渲染端调下去才在
 * 运行时抛 `No handler registered for 'x'`。而这类代码路径往往是"用户点了某个
 * 不常用的按钮"—— 平时没人发现。
 *
 * 判据是 `请求类 = 契约 − 推送`。预load 的 `invoke` 集合是**更大**的那个事实
 * (它还包含以后可能加的转发),所以这里不拿它做减数 —— 拿它当减数的话,任何
 * 一条"契约有、谁都没调"的渠道都会被算成推送而漏掉。
 */
const requestChannels = [...CONTRACT_CHANNELS].filter((ch) => !pushChannels.has(ch));
const missingInMain = requestChannels.filter((ch) => !mainChannels.has(ch)).sort();
eqArr("契约声明的请求类渠道,主进程都注册了(漏注册的在这里)", missingInMain, []);

/**
 * **主进程注册了、preload 没放行。**
 *
 * 后果是"功能写完了但渲染端根本调不到" —— `window.api.x.y` 是 undefined,点
 * 下去是 JS 的 `undefined is not a function`,和"功能没做"长得一模一样。
 *
 * ⚠️ 手机端那条 HTTP 桥(`renderer/lib/webApi.ts`)不走 preload,它调的渠道不该
 * 算进"preload 该放行"里。所以先把它读出来当豁免集。
 */
const webApiText = read(join(SRC, "renderer", "lib", "webApi.ts"));
const mobileOnly = new Set<string>([...webApiText.matchAll(/rpc\(\s*"([^"]+)"/g)].map((m) => m[1]));
// 手机端的 HTTP 桥直接打主进程注册的渠道,所以主进程里那些只有手机端用的
// (`claude:healthCheck`)也算豁免。
for (const m of preloadText.matchAll(/invoke\(\s*"([^"]+)"/g)) preloadInvoked.add(m[1]);

const notSurfaced = [...mainChannels.keys()]
  .filter((ch) => !preloadInvoked.has(ch) && !mobileOnly.has(ch) && !pushChannels.has(ch))
  .sort();
eqArr("主进程注册的渠道,渲染端都够得着(preload 或手机端桥)", notSurfaced, []);

/**
 * 计数对账 —— 上面几条都是"差集为空",空得可疑时这一条能说明**确实比过了**。
 *
 * 没有它的话,把文件读成空字符串会让上面两条**双双变绿**(空集相减还是空集),
 * 而那看起来和"对齐了"一模一样。这是本仓库那类"空过的断言"。
 */
check(
  "三边都真的读到了东西(防止读成空文件导致上面几条空过)",
  CONTRACT_CHANNELS.size > 300 && mainChannels.size > 250 && preloadInvoked.size > 250 && mainFiles.length > 100,
  {
    contract: CONTRACT_CHANNELS.size,
    main: mainChannels.size,
    preload: preloadInvoked.size,
    mainFiles: mainFiles.length,
  },
);

/**
 * `registerIpcHandlers()` 必须把 `index.ts` 里 import 的每个 `register*Handlers`
 * 都**真的调了**。
 *
 * 这是这个文件独有的一种漏:`import { registerXxxHandlers } from "./xxx.js";`
 * 写了但下面忘了一行。typecheck 只在 `noUnusedLocals` 开着时才报,而且 import
 * 了却漏调的**那一域所有渠道一起消失** —— 症状是"整个设置页白屏",排查要一行行数。
 */
const indexText = read(join(SRC, "main", "ipc", "index.ts"));
const importedRegistrars = [...indexText.matchAll(/import\s*\{\s*(register\w+Handlers)\s*\}/g)].map((m) => m[1]);
const calledRegistrars = new Set([...indexText.matchAll(/(?:^|\n)\s*(register\w+Handlers)\(/g)].map((m) => m[1]));
eqArr(
  "index.ts 里 import 的每个 register*Handlers 都被调了",
  importedRegistrars.filter((n) => !calledRegistrars.has(n)).sort(),
  [],
);
check(
  "index.ts 真的 import 了一大批注册函数(防止上面那条空过)",
  importedRegistrars.length > 30,
  { imported: importedRegistrars.length },
);

/**
 * 每个 `register*Handlers(ipc)` 在 `index.ts` 里**只能出现一次**。
 *
 * 这条是变异验证时发现的洞:上面"都被调了"只保证**至少一次**,而调两次的后果
 * 和不调一样重 —— 那个域的每一条渠道都会被注册两遍,Electron 的
 * `ipcMain.handle` 直接 throw,**应用启动即崩**。
 *
 * 而 §2 那条"没有渠道被注册两次"抓不到它:`ipc/index.ts` 里一个 `.handle(` 都
 * 没有(它是转发层),重复调用不会在那个计数里留下痕迹。两次调用之间隔着几百行
 * import,肉眼看 diff 也看不出来 —— 典型的一次烂合并。
 */
const registrarCalls = [...indexText.matchAll(/(?:^|\n)\s*(register\w+Handlers)\(/g)].map((m) => m[1]);
const calledTwice = importedRegistrars
  .filter((n) => registrarCalls.filter((c) => c === n).length > 1)
  .map((n) => `${n} × ${registrarCalls.filter((c) => c === n).length}`)
  .sort();
eqArr("index.ts 里每个 register*Handlers 只被调了一次(调两次 = 启动即崩)", calledTwice, []);

// ────────────────────────────────────────────────────────────────
console.log();
console.log(`ipc-parity-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
