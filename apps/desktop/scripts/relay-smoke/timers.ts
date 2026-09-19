/**
 * 定时器观察台 —— 只给这套 smoke 用。
 *
 * ## 为什么非要有它
 *
 * 中继的重连是 `setTimeout` 排的,间隔是 `RECONNECT_BASE_DELAY_MS * 2^(n-1)`
 * (`2s / 4s / 8s / 16s / 32s`)。无头脚本里**真等**这 62 秒是不可接受的,而那几个
 * 常量写在 `RelayManager.ts` 顶层,不是可注入的配置。
 *
 * 所以把 `setTimeout` / `clearTimeout` 换成记录版。于是三个问题一次问清楚:
 *
 *   1. **排的间隔是多少** —— 记的是**排定的那个数字**,不是墙钟(加速执行不影响它);
 *   2. **有几个还在飞** —— 排了、既没执行也没人去清的,就是泄漏;
 *   3. **有没有人清它** —— `clearTimeout` 认不认得出我们包出去的句柄。
 *
 * ## 两种模式
 *
 * - `"fast"`(默认):一律立刻执行。用来**驱动**退避链,看它到底排了几次、退到多大、
 *   什么时候放弃。
 * - `"hold"`:把**重连退避**那一类按住不执行,别的照旧立刻执行。
 *   用来数"排了没清的定时器" —— fast 模式下它们当场执行掉了,数不出来。
 *   (别的必须照旧:端口轮询那个 `sleep()` 要是也不执行,部署会**挂死**。)
 *
 * ## 栈指纹
 *
 * 记录时带上 `new Error().stack`。esbuild 打包**不 minify**,类的名字与方法的
 * 名字都原样保留,所以 `RelayManagerImpl.scheduleReconnect` 排的定时器与
 * `RelayManagerImpl.waitForPortState` 里那个 `sleep()` 在栈上分得开。
 *
 * ⚠️ **TypeScript 的 `private` 不是 JS 的 `#`。** 前者编译出来就是一个普通方法
 * (`RelayManagerImpl.scheduleReconnect`),后者才留 `#名字`。本套第一版按 `#` 写,
 * 于是筛出来恒为 0 —— 正是"指纹守卫"那条断言当场把它抓了出来(见 main.ts 第 0 节)。
 *
 * ⚠️ 指纹是**字符串匹配**,名字改了它就再也匹配不上 —— 于是计数恒为 0、断言全绿
 * 而什么都没验(仓库里说的"空过")。所以用到指纹的地方都配了一条"指纹对得上"的
 * 守卫断言,见 main.ts。
 *
 * ## 不拦谁
 *
 * `node_modules` 里发起的定时器(实测只有 `ssh2` 自己的 `readyTimeout`)**原样放过**:
 * 把它们也加快,每次连接都会当场超时,而那报出来的东西与中继无关。
 *
 * ⚠️ **"是不是第三方的"只能看*直接调用者*,不能在整个栈里搜 `node_modules`。**
 * 中继的 `scheduleReconnect` 是在 ssh2 的事件回调里被调的(连接断了 → ssh2 的
 * EventEmitter 调 `conn.on("close")` 的监听者),于是它的栈**底下**全是 ssh2 的
 * node_modules 帧。按"整条栈里有 node_modules 就算第三方"判,中继自己的退避定时器
 * 会被判成第三方的 —— 于是它们**不加速**(真的等 2s/4s/8s…)、而且**永远不会被标成
 * 已执行**。第一版就是这样:退避那几条断言看着有数字(2s/4s/8s 排定值是对的),但
 * "恰好 5 跳"永远走不到,`pendingWith` 恒为排过的那几个 —— 断言看着在验,其实那条
 * 链根本没被加速跑完。
 */

interface Entry {
  /** 排定的延迟(毫秒)。 */
  ms: number;
  /** 排它的那一刻的调用栈。 */
  stack: string;
  /** 拿到过 `clearTimeout` 没有。 */
  cleared: boolean;
  /** 已经**执行过**没有。 */
  fired: boolean;
  /** 直接排它的是 `node_modules` 里的代码 —— 不算中继的。 */
  thirdParty: boolean;
}

const entries: Entry[] = [];
const wrappers = new Map<unknown, Entry>();
let seq = 0;
let mode: "fast" | "hold" = "fast";

/** 原始的那对定时器函数 —— 在**本模块求值**这一刻抓下来(此时观察台还没装上)。
 *  别的模块(见 `fakeVps.ts` 的 `phoneGet`)也要借这个:它们可能是**装完观察台之后**
 *  才被求值的,那时再去读 `globalThis.setTimeout` 拿到的是包出去的那个。 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** 重连退避那一类的栈指纹(被测代码里的方法名)。 */
export const BACKOFF_FP = "scheduleReconnect";
/** 端口轮询那一类的栈指纹(`sleep()` ← `RelayManagerImpl.waitForPortState`)。 */
export const POLL_FP = "waitForPortState";

/* eslint-disable @typescript-eslint/no-empty-function */
/**
 * 包给调用方的句柄。
 *
 * ⚠️ **不能是个光秃秃的对象。** Node 的 `setTimeout` 回的是 `Timeout`,而调用方
 * 会顺手用它的 `unref()` / `hasRef()`(`store/db.ts` 的 `persistFallback` 就是这么
 * 干的)。少一个方法,报出来的是 `persistFallback.unref is not a function` ——
 * 那看起来像"库坏了",与中继一个字都不沾。所以这里把 `Timeout` 那几个成员补齐。
 */
function makeHandle(id: number): Record<string, unknown> {
  return {
    __relaySmokeTimer: id,
    unref: () => {},
    ref: () => {},
    hasRef: () => false,
    refresh: () => {},
    [Symbol.toPrimitive]: () => id,
  };
}

function record(fn: () => void, ms: number): unknown {
  // ⚠️ V8 默认只留 10 帧,**ssh2 自己的定时器**(readyTimeout / keepalive)是从我们
  //    的 `conn.connect()` 底下几层排的 —— 10 帧常常已经用完,栈里一个
  //    `node_modules` 都看不见,于是它被当成"中继的定时器"记进来,把
  //    `pendingTimers() === 0` 那条泄漏断言染红。染红的理由与中继无关。
  //    抓栈之前临时放宽,抓完立刻还回去(别改全局,别的库也在抓栈)。
  const prevLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = prevLimit;
  const entry: Entry = {
    ms,
    stack,
    cleared: false,
    fired: false,
    thirdParty: isThirdParty(stack),
  };
  entries.push(entry);

  // 句柄包一层:一是能把 `clearTimeout` 认回来(中继存的是我们返回的那个东西),
  // 二是 `if (this.reconnectTimer)` 这类判空照常成立。
  const handle = makeHandle((seq += 1));
  wrappers.set(handle, entry);

  if (entry.thirdParty) {
    return realSetTimeout(fn, ms);
  }
  if (mode === "hold" && stack.includes(BACKOFF_FP)) {
    // 按住不执行 —— 它就该一直"在飞"直到有人清它。
    return handle;
  }
  // 端口轮询那个 `sleep()` 要尽快还回去,否则部署会挂死;别的也一并立刻执行。
  const effective = stack.includes(POLL_FP) && ms <= 500 ? 1 : 1;
  realSetTimeout(() => {
    entry.fired = true;
    fn();
  }, effective);
  return handle;
}

/** 装上观察台。幂等 —— 必须在被测模块之前调用(见 main.ts 第一行)。 */
export function install(): void {
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms?: number) =>
    record(fn, ms ?? 0);
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = (h: unknown) => {
    const entry = wrappers.get(h);
    if (entry) {
      entry.cleared = true;
      return;
    }
    return realClearTimeout(h as never);
  };
}

/** 卸掉,恢复真的定时器(收尾用)。 */
export function uninstall(): void {
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
}

/** 换模式。见文件头。 */
export function setMode(m: "fast" | "hold"): void {
  mode = m;
}

/** 清空计数。每条场景开始前叫。 */
export function reset(): void {
  entries.length = 0;
  wrappers.clear();
}

/** 在**真**定时器上等一会儿(跨 I/O 轮询用,别拿它验退避)。 */
export function realSleep(ms: number): Promise<void> {
  return new Promise((r) => realSetTimeout(r, ms));
}

/**
 * 借**没被换过**的那个 `setTimeout` 给别的模块用。
 *
 * ⚠️ 别的模块自己在模块求值那一刻去抓 `globalThis.setTimeout` 是**靠不住**的:
 * 只要它是在 `timers.install()` **之后**才被 import 的(main.ts 里 `fakeVps` 就是),
 * 抓到的就是包出去的那个记录版 —— 于是 `phoneGet` 自己的超时也被压成 1ms,
 * 隧道那边还没来得及回话它就返回 `<timeout>` 了,看着像数据通路坏了。
 * 装观察台的人自己知道真的那对在哪儿,所以从这里借。
 */
export const real = {
  setTimeout: realSetTimeout,
  clearTimeout: realClearTimeout,
};

/** 按栈指纹筛出来的条目。 */
function withFp(fp: string): Entry[] {
  return entries.filter((e) => e.stack.includes(fp));
}

/** 筛选结果的延迟序列(排定的毫秒)。 */
export function delaysWith(fp: string): number[] {
  return withFp(fp).map((e) => e.ms);
}

/** 排了、既没执行也没被清的条数 —— 泄漏的唯一判据。 */
export function pendingWith(fp: string): number {
  return withFp(fp).filter((e) => !e.cleared && !e.fired).length;
}

/** 所有非第三方定时器里,排了没执行也没人清的条数。 */
export function pendingTimers(): number {
  return entries.filter((e) => !e.thirdParty && !e.cleared && !e.fired).length;
}

/** 全部条目(诊断用)。 */
export function all(): Array<{ ms: number; stack: string; cleared: boolean; fired: boolean }> {
  return entries.map((e) => ({ ms: e.ms, stack: e.stack, cleared: e.cleared, fired: e.fired }));
}

/**
 * 还"在飞"的**中继**定时器(排了、既没执行也没人清),连排它的栈一起给出来 ——
 * 断言失败时能一眼看出是哪一处排的,而不是只看到一个数字。
 */
export function pendingDetail(): Array<{ ms: number; line: string }> {
  return entries
    .filter((e) => !e.thirdParty && !e.cleared && !e.fired)
    .map((e) => ({ ms: e.ms, line: stackTop(e.stack) }));
}

/** 观察台**自己**那两帧 —— 每次都在栈顶,必须先跳过。
 *
 *  ⚠️ 它们与真实代码在**同一个文件**里(写死的打包产物),所以按文件分不开,
 *  只能认函数名。名字取自 `install()` 里那两个包法,产物没 minify,原样保留。
 *  实测的栈(见 timers.ts 的注释里那三份):
 *    [0] at record (…/smoke.mjs:74:17)                 ← 观察台
 *    [1] at globalThis.setTimeout (…/smoke.mjs:16:37)   ← 观察台
 *    [2] at startTimeout (…/node_modules/ssh2/lib/client.js:1113:30)  ← 真正的调用者 */
const HARNESS_FRAME = /^at (record|globalThis\.setTimeout) \(/;

/**
 * 排这个定时器的**直接调用者**是不是 `node_modules` 里的代码。
 *
 * ⚠️ **只看栈顶那个"真帧",不能整条栈搜 `node_modules`。** 中继的重连是在 ssh2 的
 * 事件回调里排的(栈底下全是 ssh2 的帧),整条搜会把中继自己的定时器判成第三方的 ——
 * 于是它们既不加速、也永远不会被标成已执行,退避链根本走不完。见文件头。
 */
function isThirdParty(stack: string): boolean {
  for (const raw of stack.split("\n").slice(1)) {
    const line = raw.trim();
    if (HARNESS_FRAME.test(line)) continue;
    const loc = /\(?([^()\s]+:\d+:\d+)\)?$/.exec(line);
    if (!loc) continue;
    const file = loc[1];
    if (file.startsWith("node:") || file.startsWith("internal/")) continue;
    return file.includes("node_modules");
  }
  return false;
}

/** 从捕获的栈里挑出**第一帧属于本仓库的**(跳过 node: 内部帧与观察台自己那两帧)。 */
function stackTop(stack: string): string {
  const frames = stack.split("\n").slice(1);
  const mine = frames.find(
    (f) => !HARNESS_FRAME.test(f.trim()) && !/\((node:|internal\/)/.test(f) && !f.includes("node_modules"),
  );
  return (mine ?? frames[0] ?? "").trim();
}
