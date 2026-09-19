"use strict";
/**
 * `node-pty` 的替身 —— **本套的主角**。
 *
 * ## 它为什么是一个"包",而不是 stubs/ 下面一个正常的 .ts 桩
 *
 * `TerminalManager` 拿 node-pty 走的是 `loadNodePty()` 里那句**运行期**
 * `require("node-pty")`。esbuild 的 `--alias:` **只改写静态 import、管不到它** ——
 * 实测:加了 `--alias:node-pty=./stubs/nodeNty.ts` 之后,bundle 里那句
 * `require("node-pty")` 原样还在,于是它去磁盘上找**真的** node-pty。
 *
 * 所以这一份必须**真的躺在 bundle 旁边的 node_modules/ 里**(run.sh 把它拷过去),
 * 让 `createRequire(import.meta.url)` 的解析顺序先撞上它。
 *
 * ## 为什么必须换掉真的 node-pty(两条独立的原因)
 *
 * ### 1. 真 ConPTY 冷启动 3 秒,本套要建十几个终端
 *
 * 实测这台机器上 `pty.spawn("cmd.exe", ["/c","echo","hi"])` 从 spawn 到**第一个有用的
 * 字节**要 **3094ms**(ConPTY 先把控制台属性、光标、代码页全握一遍手)。十几条断言
 * 每条真起一个进程 = 一分钟起步,而且时序飘(断言会跟着飘)。
 *
 * ### 2. 坏路径在真 pty 上是"抛在原生层",而本套要验的是"抛了之后下发给界面的那行字"
 *
 * 实测两条(照抄进下面的 thrown message):
 *   - cwd 不存在 → `Cannot create process, error code: 267`
 *   - file 不存在 → `File not found: C:\nope\nosuch.exe`
 *
 * ## 账本挂在 `globalThis` 上(本套最容易踩死的一处)
 *
 * 这个替身会被以**两种方式**装进来(运行期 require 这一条,加上 bundle 里
 * `await import("node-pty")` 那一条),而 `mcode-smoke/SKILL.md` 记过一个同形状的坑:
 * 「会得到两份模块实例 —— `setX` 写进 A、`getX` 从 B 读,断言全红而红的不是被测的
 * 东西」。这里把**唯一的账本**放 `globalThis`,`spawn()` 每次都从上面取同一个数组。
 *
 * ## 本替身保留真实现的四条硬事实(断言的前提就立在这四条上)
 *
 *   - `spawn` 在 file / cwd 不存在时**抛**,message 照抄上面的实测值;
 *   - `pid` 是数字(真的返回宿主 PID);
 *   - `onData` 递给回调的 `data` 是 **string**:真 pty 在 Windows 上把 out socket
 *     `setEncoding("utf8")`(node-pty 的 `windowsPtyAgent.js` 第 72 行),它**从不**
 *     吐 Buffer 给 onData;
 *   - `write` / `resize` 在已退出的 pty 上**抛**(`Cannot resize a pty that has
 *     already exited`,同样是实测的真 message);
 *   - `kill()` **是异步的**:真 `WindowsTerminal.kill` 走 `_deferNoArgs`,排队后立刻返回,
 *     `exit` 事件是之后才到的。这条很要紧 —— 同步的话 `kill()` 里那句显式
 *     `sendToRenderer(TERMINAL_EXIT, exitCode: null)` 与 `onExit` 那句的**顺序会反过来**。
 */

const KEY = "__mcodeTerminalSmokePtyLedger";
const g = globalThis;
if (!g[KEY]) g[KEY] = { spawns: [], total: 0 };

const fs = require("node:fs");

class FakePty {
  constructor(file, args, opts, record) {
    this.pid = 4242 + g[KEY].spawns.length;
    this.process = file;
    this.cols = (opts && opts.cols) || 80;
    this.rows = (opts && opts.rows) || 24;
    this.record = record;
    /** 脚本写进 PTY 的每一条(验 `write` 真的把字节交下去了)。 */
    this.written = [];
    /** `resize` 被调到的每一组尺寸。 */
    this.resizes = [];
    this._dataCbs = [];
    this._exitCbs = [];
    this._exited = false;
    this._killThrows = null;
  }

  onData(cb) {
    this._dataCbs.push(cb);
    return { dispose: () => { this._dataCbs = this._dataCbs.filter((c) => c !== cb); } };
  }

  onExit(cb) {
    this._exitCbs.push(cb);
    return { dispose: () => { this._exitCbs = this._exitCbs.filter((c) => c !== cb); } };
  }

  write(data) {
    if (this._exited) throw new Error("Cannot write to a pty that has already exited");
    this.written.push(data);
  }

  resize(cols, rows) {
    if (this._exited) throw new Error("Cannot resize a pty that has already exited");
    this.resizes.push([cols, rows]);
    this.cols = cols;
    this.rows = rows;
  }

  kill() {
    if (this._killThrows) throw new Error(this._killThrows);
    this.record.killed = true;
    // ⚠️ **必须异步。** 真 node-pty 的 `WindowsTerminal.kill` 走 `_deferNoArgs`
    // (`windowsTerminal.js`)—— 也就是说 `kill()` 只把活排进队列就返回了,真正的
    // `_agent.kill()` 与随之而来的 `exit` 事件是**之后**才发生的。本替身头一版
    // 同步 fire,于是 `kill()` 里那句显式推送和 `onExit` 里那句的**先后顺序整个反过来**,
    // 断言数出来的东西和真机上不一样(真机上先收到 exitCode:null,后收到真 exitCode)。
    setImmediate(() => this._exit(0));
  }

  /* ── 下面几个只给脚本用(真实现里没有) ── */

  /** 让下一次 `kill()` 抛 —— 验 TerminalManager 那条 catch 路径。 */
  __makeKillThrow(message) { this._killThrows = message; }
  /** 模拟子进程自己退出(用户敲了 exit)。 */
  __exit(code) { this._exit(code); }
  /** 模拟 shell 往界面吐了一段输出。 */
  __emitData(d) { if (this._exited) return; for (const cb of [...this._dataCbs]) cb(d); }
  /** 有没有注册过 onData / onExit。 */
  listenerCounts() { return { data: this._dataCbs.length, exit: this._exitCbs.length }; }
  get isExited() { return this._exited; }

  _exit(code) {
    if (this._exited) return;
    this._exited = true;
    for (const cb of [...this._exitCbs]) cb({ exitCode: code });
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 与真实现同形的入口。抛出的两条 message 照抄 ConPTY 的实测值。 */
function spawn(file, args, opts) {
  opts = opts || {};
  if (opts.cwd !== undefined && !fs.existsSync(opts.cwd)) {
    throw new Error("Cannot create process, error code: 267");
  }
  if (!isFile(file)) {
    throw new Error("File not found: " + file);
  }
  const record = { file, args, opts, killed: false };
  const pty = new FakePty(file, args, opts, record);
  record.pty = pty;
  g[KEY].spawns.push(record);
  g[KEY].total += 1;
  return pty;
}

function createTerminal() {
  throw new Error("terminal-smoke 不该走到 node-pty.createTerminal");
}

function open() {
  throw new Error("terminal-smoke 不该走到 node-pty.open");
}

/** 与本套 main.ts 看到的是**同一个数组**(见上面的注释)。 */
const spawns = g[KEY].spawns;

function resetSpawns() {
  g[KEY].spawns.length = 0;
}

/** `resetSpawns()` 清不掉的累计计数 —— 给"空过守卫"用:确认这个替身**真的**被走到过。
 *
 *  ⚠️ **必须是函数,不能是 getter。** 这个包是被 `--external:node-pty` 留着、由 Node 的
 *  CJS→ESM interop 供上去的,而那一层用的是 `cjs-module-lexer`,它**认不出 getter**:
 *  写成 `get totalSpawned()` 的话,本套那边读到的是 `undefined`(守卫静默失效,而它本来
 *  就是防"静默失效"的)。函数声明它认。 */
module.exports = {
  spawn,
  createTerminal,
  open,
  spawns,
  resetSpawns,
  totalSpawned() {
    return g[KEY].total;
  },
};
