/**
 * `node:child_process` 的替身 —— 本套里 `rgInstall` / `toolInstall` / `updater` 三个模块
 * **都**从这条 import 走,而它们在无头脚本里各自不能真的起进程:
 *
 *   - `updater.detectManualInstallRequired` 要跑 `codesign`(只有 macOS 有);
 *   - `toolInstall` 要跑 `tar` / 自解压 exe / `tlmgr` / `pip`(全都不能真跑,`pip`
 *     尤其 —— 真跑就是往用户解释器里装包);
 *   - `rgInstall` 要跑 `tar` 解压、再跑解出来的 rg 二进制做自检。
 *
 * ## 口径:登记了就模拟,没登记就**原样交给真的**
 *
 * 这个桩不是"全换掉",是**按命令名路由**。没登记的命令走真 `execFile`/`spawn`
 * —— 于是 `toolInstall.systemTar()` 真去跑本机 System32 的 bsdtar 解压一个真 zip
 * ("解包"这一步因此是真验的,不是模拟的)。登记了的那几条才是模拟。
 *
 * ## `execFileSync` 为什么必须**照 Node 的真实行为**返回
 *
 * `updater.ts:114` 那句是 `execFileSync("codesign", [...], { encoding: "utf8",
 * stdio: ["ignore", "ignore", "pipe"] })`,然后把**返回值**拿去跑正则。真 Node 在
 * `stdio[1] === "ignore"` 时**返回 null**(stdout 被丢弃了),`RegExp.test(null)`
 * 不抛、只是不匹配 —— 于是"ad-hoc 签名"永远判不出来,而且**不报错**。
 *
 * 所以这里的 `execFileSync` 老老实实按 stdio 决定返回什么:返回 `null` 的那一半
 * 是 Node 的行为,不是我编的。如果哪天有人"顺手"把这个桩改成永远返回 stdout,
 * 那条断言就会假绿 —— 见文件末尾的 `assertStubFaithful()` 守卫,那一条就是防这个的。
 */
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { slot } from "./shared.js";

const real = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");

export interface CmdOutcome {
  /** 退出码。0 = 成功。 */
  code?: number;
  /** stdout 的内容。 */
  stdout?: string;
  /** stderr 的内容。真工具把诊断信息写在这儿。 */
  stderr?: string;
}

/** 一次调用的形状 —— 断言"到底调了哪个命令、传了什么参数"用。 */
export interface CmdCall {
  cmd: string;
  args: string[];
  /** 该次调用是不是被登记的桩接管的(false = 原样跑的真进程)。 */
  stubbed: boolean;
}

export const calls: CmdCall[] = [];

type Route = (args: string[], opts: unknown) => CmdOutcome;

/** 按 basename 精确匹配的路由。 */
const routes = new Map<string, Route>();
/** 按 basename 正则匹配的路由 —— 给文件名里带时间戳的那几条用。
 *  最典型的:`downloadVerified` 把工具下到 `mcode-tool-latex-<ts>.download`,
 *  而 `runSelfExtractor` 拿这个**没有 `.exe` 后缀**的临时文件当自解压包起 —— 名字
 *  每次都不同,只能按形状认。 */
const patterns: Array<{ re: RegExp; route: Route }> = [];

function base(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return (i >= 0 ? p.slice(i + 1) : p).toLowerCase();
}

function routeFor(cmd: string): Route | undefined {
  const b = base(cmd);
  const exact = routes.get(b);
  if (exact) {
    slot.fired.add(`route:${b}`);
    return exact;
  }
  for (const { re, route } of patterns) {
    if (re.test(b)) {
      slot.fired.add(`pattern:${re.source}`);
      return route;
    }
  }
  return undefined;
}

/** 登记一条命令的替身。`cmd` 按**basename** 匹配(命令可能是绝对路径)。
 *  同名重复登记 = **覆盖**(和 `--alias:` 一样,后者覆盖前者)。 */
export function register(cmd: string, reply: CmdOutcome | Route): void {
  routes.set(cmd.toLowerCase(), typeof reply === "function" ? reply : () => reply);
}

/** 按 basename 的正则登记 —— 见 `patterns` 的说明。
 *
 *  ⚠️ **同一条正则重复登记是覆盖,不是追加** —— 这一条踩过坑。`routeFor` 按登记
 *  顺序取**第一个**命中的,所以「后面再登记一条更精确的」在追加语义下**永远轮不到**,
 *  而表现是"新登记的那个桩没生效"(第一版 癸.2 就是这样:它想登记一个"什么都不解"
 *  的自解压桩,结果被癸那一条"会 mkdir TinyTeX/"的抢先接管,于是断言全绿在
 *  一个错误的形状上)。这里的语义与 `register` 对齐:同一个 `re.source` 只留一条。 */
export function registerPattern(re: RegExp, reply: CmdOutcome | Route): void {
  const route = typeof reply === "function" ? reply : () => reply;
  const at = patterns.findIndex((p) => p.re.source === re.source);
  if (at >= 0) patterns[at] = { re, route };
  else patterns.push({ re, route });
}

/** 某条命令被调了几次(本套用完就该是 0 —— 那是"没人回头再跑一遍"的反面判据)。 */
export function callsOf(cmd: string): CmdCall[] {
  return calls.filter((c) => base(c.cmd) === cmd.toLowerCase());
}

export function resetCalls(): void {
  calls.length = 0;
}

/** 一条命令在本进程里**登记了却一次没被调用** —— 死夹具守卫(同 library-citation-smoke)。
 *
 *  判据走 `slot.fired` 而不是本文件的局部 `fired`:**这个桩有两条入口**
 *  (`node:child_process` 换桩的那一份,和 `assertStubFaithful` 直接引的那一份),
 *  状态必须落在 `globalThis` 槽里才看得见两边(同 `stubs/shared.ts` 的文件头)。
 *
 *  ⚠️ 命中是在 `routeFor` 里记的 —— 也就是**所有**入口(execFile / execFileSync /
 *  spawn)都算。第一版只在 `execFileSync` 里记,于是 `register` 登记的那些
 *  **只走 execFile 的**命令(自解压包、cmd.exe、python.exe)全被误报成"死夹具"。 */
export function unfiredRoutes(): string[] {
  const dead: string[] = [];
  for (const k of routes.keys()) {
    if (!slot.fired.has(`route:${k}`)) dead.push(k);
  }
  for (const { re } of patterns) {
    if (!slot.fired.has(`pattern:${re.source}`)) dead.push(re.source);
  }
  return dead;
}

/* ── spawn ── */

interface ChildLike extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: () => void;
}

/** `rgInstall` 用到的全部形状:`stdout` / `stderr` 的 `"data"`、`on("error")`、
 *  `on("exit")`、`kill()`。**不实现别的** —— 哪天用法变了,这里会显形而不是安静地少发一件事。 */
export function spawn(cmd: string, args: string[] = [], opts?: unknown): ChildLike {
  const route = routeFor(cmd);
  calls.push({ cmd, args, stubbed: !!route });
  if (!route) {
    return real.spawn(cmd, args, opts as never) as unknown as ChildLike;
  }
  const out = route(args, opts);
  const child = new EventEmitter() as ChildLike;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  setImmediate(() => {
    const o = out.stdout ?? "";
    const e = out.stderr ?? "";
    if (o) child.stdout.emit("data", Buffer.from(o, "utf8"));
    if (e) child.stderr.emit("data", Buffer.from(e, "utf8"));
    child.emit("exit", out.code ?? 0);
    child.emit("close", out.code ?? 0);
  });
  return child;
}

/* ── execFile ── */

export function execFile(
  cmd: string,
  args: string[],
  opts: unknown,
  cb?: (err: Error | null, stdout: string, stderr: string) => void,
): ChildLike {
  const route = routeFor(cmd);
  calls.push({ cmd, args, stubbed: !!route });
  if (!route) {
    return real.execFile(cmd, args, opts as never, cb as never) as unknown as ChildLike;
  }
  const out = route(args, opts);
  const child = new EventEmitter() as ChildLike;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  setImmediate(() => {
    const err = out.code ? Object.assign(new Error(`Command failed: ${cmd}`), { code: out.code }) : null;
    cb?.(err, out.stdout ?? "", out.stderr ?? "");
  });
  return child;
}

/* ── execFileSync ── */

export function execFileSync(cmd: string, args: string[] = [], opts?: unknown): unknown {
  const route = routeFor(cmd);
  calls.push({ cmd, args, stubbed: !!route });
  if (!route) return real.execFileSync(cmd, args, opts as never);
  const out = route(args, opts);
  const options = opts as { encoding?: string; stdio?: Array<string | null> } | undefined;
  if (out.code) {
    throw Object.assign(new Error(`Command failed: ${cmd}`), { status: out.code, stderr: out.stderr });
  }
  // ⚠️ Node 的真实行为:`stdio[1] === "ignore"` 时 stdout 不被捕获,返回 **null**。
  const stdio = options?.stdio;
  if (Array.isArray(stdio) && stdio[1] === "ignore") return null;
  return options?.encoding ? (out.stdout ?? "") : Buffer.from(out.stdout ?? "", "utf8");
}

/** 本套不该走到 `execFile` 的**同步 shell**形态 —— 走到就显形。 */
export function exec(): never {
  throw new Error("本套不该走到 child_process.exec");
}
export function fork(): never {
  throw new Error("本套不该走到 child_process.fork");
}

/**
 * 守卫:证明这个桩**没有**把 `execFileSync` 变成"永远返回 stdout"。
 *
 * 把 `stdio[1] === "ignore"` 那一支去掉,`execFileSync` 就会开始返回 `typeof string`,
 * 于是"ad-hoc 签名没被认出来"那条断言会**假绿** —— 而它绿的原因是这个桩不忠实,
 * 不是被测代码修好了。这一条就把那种情况变成一句人话。
 */
export function assertStubFaithful(): { ok: boolean; detail: string } {
  register("__probe__", { code: 0, stdout: "out", stderr: "err" });
  const ignored = execFileSync("__probe__", [], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  const piped = execFileSync("__probe__", [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  routes.delete("__probe__");
  const ok = ignored === null && piped === "out";
  return { ok, detail: `stdio[1]=ignore → ${JSON.stringify(ignored)}(应为 null);stdio[1]=pipe → ${JSON.stringify(piped)}(应为 "out")` };
}
