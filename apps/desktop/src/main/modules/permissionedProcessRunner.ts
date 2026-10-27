/**
 * 【MC-035】**用户扩展代码的受控执行进程** —— 独立子进程 + 操作系统级权限隔离。
 *
 * ## 它在补哪个洞
 *
 * 台账 MC-035 的系统性修复要求:「用户安装的代码需受控进程/OS 权限隔离,**不能把现有
 * worker_threads 当安全沙箱**」。`isolatedActionRunner.ts` 顶注自己写得很清楚:worker
 * 同进程同堆,里面的代码照样读写盘、起子进程、发网络 —— 它挡的是崩溃与挂死,不是权限。
 *
 * 本模块走另一条路:把扩展程序放进**独立进程**,用 Node/Electron 内置的
 * `--permission` 权限模型约束它:
 *
 *   - 文件系统:只放行**本次调用具体资源**的读(和声明了 `resource.write` 时的写)。
 *     越界读/写/建目录/删文件一律 `ERR_ACCESS_DENIED`,由操作系统边界拒绝;
 *   - `child_process`、`worker_threads`、原生插件加载:默认**全部拒绝**;
 *   - 网络:⚠️ **Node 的 `--permission` 不管网络**(它只治理 fs / 子进程 / worker /
 *     原生模块)。台账第十七轮复核用真子进程实测过:没有任何网络 grant 的扩展照样能
 *     HTTP POST 外传。本模块因此在引导脚本里**先于扩展代码**安装一层网络拦截
 *     (见 {@link NETWORK_GUARD}):`http`/`https`/`net`/`dns`/`fetch`/`WebSocket`
 *     全部替换为抛错,除非调用方**显式**给了 `allowNetwork`。
 *     ⚠️ 这不是 OS 级沙箱 —— 进程内拦截挡不住绕过 Node API 的路径(原生插件、直接
 *     系统调用)。真正的出站限制需要 OS 沙箱(seccomp / AppContainer / 受限代理);
 *     本层的作用是让"未声明的网络访问"在**默认路径上**明确失败,而不是静默放行。
 *
 * ## 为什么用 `-e <引导脚本>` 而不是落一个 runner 文件
 *
 * `--allow-fs-read` 的粒度是**文件**:权限模型下,引导脚本自身也得在允许名单里;若把它
 * 写成一个文件,每次执行都要多放行一个路径,而且那个文件本身也就成了可被扩展代码读取的
 * 对象。`node -e` / `ELECTRON_RUN_AS_NODE=1 electron -e` 都**不触发** fs 读检查(实测),
 * 于是引导脚本可以内联,扩展进程的文件系统面**只剩**调用方明确放行的那一个资源。
 * 扩展源码与入参经 **stdin** 送入(结构化 JSON),不经文件、不经命令行(命令行在进程列表
 * 里对同机其他用户可见,且长度有上限)。
 *
 * ## 进程身份
 *
 * `process.execPath` + `ELECTRON_RUN_AS_NODE=1`(与 `codeRunner` 同一条既有模式):
 * 在打包后的 Electron 里 execPath 是 electron.exe,在无头 smoke 里就是 node。两者都支持
 * `--permission`(实测 Node 22 / Electron 44-as-Node)。环境变量**不继承**宿主 —— 只给
 * `ELECTRON_RUN_AS_NODE` 与最小 PATH,避免把宿主的密钥/代理配置带进第三方代码。
 *
 * ## 失败分类(与 `isolatedActionRunner` 同一套码)
 *
 * `isolated_timeout` / `isolated_cancelled` / `isolated_crash` / `isolated_spawn_failed`
 * 之外,多一档 **`isolated_denied`**:扩展代码自己在进程内撞到权限边界(ERR_ACCESS_DENIED)。
 * 把它与"程序抛了个普通错"分开,是因为前者是**安全边界按预期工作**的证据,调用端据码
 * 可以给出"这个扩展试图越界"的明确诊断,而不是一句笼统的失败。
 */
import { spawnRun } from "@main/lib/spawnRun.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ResultSchema, type ModuleResult } from "@contracts/modules";
/** 隔离执行失败的结构化码 —— 定义在唯一使用者这里（原在已删除的 `isolatedActionRunner.ts`）。 */
export const ISOLATION_FAILURE_CODES = ["isolated_timeout", "isolated_cancelled", "isolated_crash", "isolated_spawn_failed"] as const;
export type IsolationFailureCode = (typeof ISOLATION_FAILURE_CODES)[number];
export const ISOLATION_FAILURE_MARKER = "mcodeModuleIsolationFailure" as const;

export interface PermissionedProcessOptions {
  /** 工厂源码(清单 `program.source`):求值为 `{ [短名]: async (resource) => result }`。 */
  source: string;
  /** 清单引用的能力短名 —— 只调用它。 */
  capability: string;
  /** 传给扩展函数的资源(已过宿主 `authorize`,路径是**真实路径**)。 */
  resource: { projectPath: string; path: string };
  /** true = 放行对该资源的写(模块声明了 `resource.write` 且已获逐次批准)。 */
  allowWrite: boolean;
  /** 【MC-035】true = 放行网络。**默认 false** —— 未声明网络能力的扩展不能出站。
   *  清单里声明了网络权限且用户逐次批准时才传 true(见 ModuleHost 的权限判定)。 */
  allowNetwork?: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  /** If provided, activate a bounded duplex NDJSON channel for mcode.api.call. */
  onAppCall?: (method: string, input: unknown) => Promise<unknown>;
}

/**
 * 引导脚本(在目标进程里**第一个**执行的东西)。职责只有三件:
 *   1. 从 stdin 读 JSON 载荷(超限直接拒,未读的输入不进入求值);
 *   2. `eval` 工厂源码、取出被引用的那一个函数;
 *   3. 把结果/错误以**单行协议**写回 stdout。
 *
 * 不用 console.log:扩展代码可能自己往 stdout 打印,协议行必须能凭前缀认出来。
 * 结果 JSON 里的换行已被 `JSON.stringify` 转义,不会把协议行拆断。
 */
/**
 * 【MC-035】**网络拦截** —— 在扩展代码求值**之前**执行。
 *
 * ## 为什么必须有
 *
 * Node 的 `--permission` 只治理 fs / 子进程 / worker / 原生模块,**完全不限制网络**。
 * 台账第十七轮用真子进程实测:一个只放行单文件读的扩展进程仍能 `http.request` 到
 * `127.0.0.1` 并成功 POST 内容 —— 「只约束 fs 不能阻止扩展读已授权文件后外传」。
 *
 * ## 它怎么拦
 *
 * 把 Node 的对外网络入口替换成抛错函数。替换发生在工厂源码 `eval` 之前,扩展拿到的
 * 就是被替换过的模块对象:
 *   - `http` / `https` / `http2` 的 `request` / `get` / `connect`,以及 `Agent.prototype`
 *     的 `createConnection` / `createSocket` 与 `globalAgent.createConnection`(直接拿一条
 *     出站套接字,不经过 `request`);
 *   - `net` 的 `connect` / `createConnection`,**`Socket.prototype.connect`**(原型方法,
 *     模块导出替换管不到),以及内部符号键上的同一实现;
 *   - `tls` 的 `connect` / `createConnection` 与 `TLSSocket.prototype.connect`;
 *   - `dgram` 的 `createSocket` 与 `Socket.prototype` 的 `send` / `sendto` / `connect`
 *     (默认 lookup 被 dns 那条拦住是偶然 —— 调用方可传自定义 lookup);
 *   - `dns` 的查询函数、`dns.promises` 命名空间、`dns.Resolver.prototype` 与
 *     `dns.promises.Resolver.prototype` 的 resolve* / reverse;
 *   - 全局 `fetch` / `WebSocket` / `EventSource`;
 *   - 最后 `syncBuiltinESMExports()`,让 `import("node:net")` 的具名导出与 require
 *     拿到同一份替换。
 *
 * ## 它不是什么(如实)
 *
 * **不是 OS 级沙箱**:原生插件、直接系统调用、`process.binding` 一类底层路径仍可能绕过。
 * 真正的出站限制需要 seccomp / AppContainer / 受限代理。本层的作用是让**未声明的网络
 * 访问在默认路径上明确失败**,而不是静默放行;它把"能不能出网"从"没人管"变成
 * "默认不能,声明并批准才放行"。
 *
 * `allowNetwork=true` 时整段跳过(扩展拿到的就是原始模块对象)。
 */
const NETWORK_GUARD = String.raw`
const mcodeNetworkGuardSelfCheck = (function installNetworkGuard(){
  try {
    const DENY_MARKER = Symbol("mcode-network-denied");
    const deny = (what) => {
      const blocked = function(){ throw new Error("network_access_denied: 扩展未声明网络权限(" + what + ")"); };
      Object.defineProperty(blocked, DENY_MARKER, { value: true });
      return blocked;
    };
    // 【MC-035】原型方法替换的**通用形状**:own-property 优先(不覆盖继承来的实现);
    // 不存在的可选入口跳过;已存在但拦截失败必须 fail-closed。
    const wrapOwn = (proto, key, what) => {
      if (!proto || typeof proto[key] !== "function") return;
      const blocked = deny(what);
      try { proto[key] = blocked; }
      catch (e) { throw Error("network_guard_setup_failed: " + what + ": " + String(e)); }
      if (proto[key] !== blocked) throw Error("network_guard_setup_failed: " + what + " non-writable");
    };
    const wrapAll = (obj, keys, prefix) => {
      for (const key of keys) wrapOwn(obj, key, prefix + key);
    };
    for (const name of ["http","https","http2"]) {
      try {
        const mod = require("node:" + name);
        wrapAll(mod, ["request","get","connect"], name + ".");
        // 【MC-035】Agent 的 createConnection 是**原型方法** —— 扩展可以绕过被替换的
        // request,直接 globalAgent.createConnection({ host, port }) 拿到一条出站套接字。
        // --permission 不管网络,这条纯 JS 路径曾端到端成功过。
        if (mod.Agent && mod.Agent.prototype) {
          wrapOwn(mod.Agent.prototype, "createConnection", name + ".Agent.prototype.createConnection");
          wrapOwn(mod.Agent.prototype, "createSocket", name + ".Agent.prototype.createSocket");
        }
        // globalAgent 的 createConnection 钉成自有属性(防御性:部分版本在构造时绑定,
        // 不查原型;直接钉住那个对象更稳)。
        wrapOwn(mod.globalAgent, "createConnection", name + ".globalAgent.createConnection");
      } catch (e) {
        if (name !== "http2" || !/ERR_UNKNOWN_BUILTIN_MODULE|MODULE_NOT_FOUND/.test(String(e))) throw e;
      }
    }
    try {
      const net = require("node:net");
      wrapAll(net, ["connect","createConnection"], "net.");
      // 【MC-035】new net.Socket().connect(...) 不走模块导出,走**原型方法**。
      // net.connect 是另一份实现(不是原型那个函数),两处都替换。
      wrapOwn(net.Socket && net.Socket.prototype, "connect", "net.Socket.prototype.connect");
      // net 内部连接实现的符号键(运行时私有,拿不到就跳过;它挡的是
      // tls.connect 内部对同一实现的直接调用)。
      const internalKey = Symbol.for("nodejs.internal.net.Socket.prototype.connect");
      wrapOwn(net.Socket.prototype, internalKey, "net.Socket(内部 connect)");
    } catch (e) { throw e; }
    try {
      const tls = require("node:tls");
      // 【MC-035】tls.connect 与 TLSSocket 的原型方法。守卫从前完全没提 node:tls ——
      // 扩展可以 require("node:tls").connect 直接建 TLS 连接外传。实测
      // TLSSocket.prototype 上**没有自有** connect(继承自 net 的同一函数),但显式补一个
      // 自有替换作为纵深:依赖别的替换被改动时不至于一起失效。
      wrapAll(tls, ["connect","createConnection"], "tls.");
      wrapOwn(tls.TLSSocket && tls.TLSSocket.prototype, "connect", "tls.TLSSocket.prototype.connect");
    } catch (e) { throw e; }
    try {
      const dgram = require("node:dgram");
      // 【MC-035】dgram:createSocket 从模块导出拦;new dgram.Socket + send/sendto 走
      // 原型方法。默认 lookup 被 dns 那条挡住是**偶然** —— 调用方可传自定义 lookup,
      // 因此 send/sendto 本身必须拦。
      wrapAll(dgram, ["createSocket"], "dgram.");
      wrapOwn(dgram.Socket && dgram.Socket.prototype, "send", "dgram.Socket.prototype.send");
      wrapOwn(dgram.Socket && dgram.Socket.prototype, "sendto", "dgram.Socket.prototype.sendto");
      wrapOwn(dgram.Socket && dgram.Socket.prototype, "connect", "dgram.Socket.prototype.connect");
    } catch (e) { throw e; }
    try {
      const dns = require("node:dns");
      const DNS_QUERIES = [
        "lookup","lookupService","resolve","resolve4","resolve6","resolveAny","resolveCaa",
        "resolveCname","resolveMx","resolveNaptr","resolveNs","resolvePtr","resolveSoa",
        "resolveSrv","resolveTxt","reverse",
      ];
      wrapAll(dns, DNS_QUERIES, "dns.");
      // 【MC-035】promises 命名空间是**另一个对象**(getter 返回),原型上的 resolve* 也
      // 各是一份。从前只替换了 dns 模块对象上的 5 个函数,dns.promises.resolve4 与
      // new dns.promises.Resolver() / new dns.Resolver() 全是敞开的。
      // setServers 不发起查询,不拦(拦它会让"只配了服务器就算被挡"的假绿出现)。
      try {
        const promisesNs = dns.promises;
        if (promisesNs && typeof promisesNs === "object") {
          wrapAll(promisesNs, DNS_QUERIES, "dns.promises.");
          const PromiseResolver = promisesNs.Resolver;
          if (PromiseResolver && PromiseResolver.prototype) {
            const PromiseResolverProto = PromiseResolver.prototype;
            // 原型上的 resolve* / reverse(以及部分版本里的 resolve*Promise —— 正则一并覆盖)。
            for (const key of Object.getOwnPropertyNames(PromiseResolverProto)) {
              if (key === "constructor") continue;
              if (/^(resolve|reverse)/.test(key)) {
                wrapOwn(PromiseResolverProto, key, "dns.promises.Resolver.prototype." + key);
              }
            }
          }
        }
      } catch (e) { throw e; }
      const Resolver = dns.Resolver;
      if (Resolver && Resolver.prototype) {
        for (const key of Object.getOwnPropertyNames(Resolver.prototype)) {
          if (key === "constructor") continue;
          if (/^(resolve|reverse)/.test(key)) {
            wrapOwn(Resolver.prototype, key, "dns.Resolver.prototype." + key);
          }
        }
      }
    } catch (e) { throw e; }
    for (const key of ["fetch","WebSocket","EventSource"]) {
      if (typeof globalThis[key] === "function") globalThis[key] = deny(key);
    }
    // 【MC-035】require("node:net") 与 import("node:net") 走同一个模块对象(实测),
    // 但 ESM 的**具名导出**是静态 facade —— 这里同步一次,让动态 import 也拿到替换后的
    // 函数(不依赖扩展是否拿到同步前的 facade)。
    // 【MC-035】旧版把守卫初始化错误全部吞掉：部分网络入口未能覆盖也继续
    // 执行不可信工厂。这些核心入口若拦截失败，应直接终止子进程而不是 fail-open。
    require("node:module").syncBuiltinESMExports();
    const requireDenied = (obj, key, source) => {
      if (!obj || typeof obj[key] !== "function" || obj[key][DENY_MARKER] !== true) {
        throw new Error("network_guard_setup_failed: " + source + "." + key);
      }
    };
    requireDenied(require("node:http"), "request", "http");
    requireDenied(require("node:https"), "request", "https");
    requireDenied(require("node:net"), "connect", "net");
    requireDenied(require("node:net").Socket.prototype, "connect", "net.Socket.prototype");
    requireDenied(require("node:tls"), "connect", "tls");
    requireDenied(require("node:dgram"), "createSocket", "dgram");
    requireDenied(require("node:dns"), "lookup", "dns");
    if (typeof globalThis.fetch === "function") requireDenied(globalThis, "fetch", "globalThis");
    // Captured in the trusted bootstrap lexical scope, not on globalThis.
    const invariant = () => {
      requireDenied(require("node:http"), "request", "http");
      requireDenied(require("node:https"), "request", "https");
      requireDenied(require("node:net"), "connect", "net");
      requireDenied(require("node:net").Socket.prototype, "connect", "net.Socket.prototype");
      requireDenied(require("node:tls"), "connect", "tls");
      requireDenied(require("node:dgram"), "createSocket", "dgram");
      requireDenied(require("node:dns"), "lookup", "dns");
      if (typeof globalThis.fetch === "function") requireDenied(globalThis, "fetch", "globalThis");
    };
    invariant();
    return invariant;
  } catch (e) {
    throw new Error("network_guard_setup_failed: " + String(e && e.message || e));
  }
})();
`;

/** MC-035 临时协议硬化的真实边界：
 * 每次调用的 proof + 间接 eval + 捕获原 stdout.write，只针对已复现的
 * 「单行伪造、拿到局部 p、覆盖 write」进行防护；不构成不可信任意 JS 的认证通道。
 * 子进程里更深层的 stream 原型修改/内部 write hook、OS 网络出站仍无强隔离保证。
 * 完整闭环仍须采用可信独立监督层/OS 沙箱，并进行适用系统的真 U1 对抗验证。
 */
const BOOTSTRAP = [
  '"use strict";',
  'const MAX=8*1024*1024;',
  'let raw="";process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",c=>{raw+=c;if(raw.length>MAX){process.stdout.write("@@mcode:ext-result "+JSON.stringify({ok:false,code:"input",message:"payload too large"})+"\\n");process.exit(0);}});',
  'process.stdin.on("end",()=>{ let p; try{p=JSON.parse(raw);}catch(e){process.stdout.write("@@mcode:ext-result "+JSON.stringify({ok:false,code:"input",message:String(e&&e.message||e)})+"\\n");return;}',
  '  (async()=>{ const protocolWrite=process.stdout.write.bind(process.stdout); try{',
  '    if(typeof mcodeNetworkGuardSelfCheck==="function")mcodeNetworkGuardSelfCheck();',
  '    const guardTimer=typeof mcodeNetworkGuardSelfCheck==="function"?setInterval(()=>{try{mcodeNetworkGuardSelfCheck()}catch(e){process.stderr.write("network_guard_integrity_failed: "+String(e)+"\\n");process.exit(78)}},50):null;',
  '    if(guardTimer)guardTimer.unref();',
  '    const factory=(0,eval)("("+p.source+")");',
  '    if(!factory||typeof factory!=="object")throw Error("扩展程序工厂没有求出对象");',
  '    const fn=factory[p.capability];',
  '    if(typeof fn!=="function")throw Error("扩展程序没有声明能力 "+p.capability);',
  '    const result=await fn(p.resource);',
  '    if(typeof mcodeNetworkGuardSelfCheck==="function")mcodeNetworkGuardSelfCheck();',
  '    protocolWrite("@@mcode:ext-result "+JSON.stringify({ok:true,result,proof:p.proof})+"\\n");',
  '  }catch(e){',
  '    const message=String(e&&e.message||e);',
  '    const denied=/ERR_ACCESS_DENIED|Access to this API has been restricted|ERR_ACCESS_PERMISSION|permission/i.test(message);',
  '    protocolWrite("@@mcode:ext-result "+JSON.stringify({ok:false,code:denied?"denied":"failed",message,proof:p.proof})+"\\n");',
  '  }})();',
  '});',
].join("\n");

/** 构造权限参数。**每一条都有存在的理由**,改动它等于改动扩展的权限面:
 *  - `--permission` 打开权限模型(不打开时所有 allow 参数都无意义);
 *  - 读:资源文件一项。写:资源文件一项(仅 `allowWrite`)。
 *    **不给目录** —— 权限模型对"目录"的放行等于给整个子树,与"一次调用一个文件"不符。 */
export function permissionArgs(resourcePath: string, allowWrite: boolean): string[] {
  const args = [
    "--permission",
    "--allow-fs-read=" + resourcePath,
  ];
  if (allowWrite) args.push("--allow-fs-write=" + resourcePath);
  return args;
}

/**
 * 安装期核验引导脚本 —— **零文件系统放行**(连 `--allow-fs-read` 都不给):它只读 stdin、
 * 求值工厂、检查被引用的短名是不是函数,然后回一行结果。扩展的代码在这里**跑起来**,
 * 但没有任何可读/可写路径;任何试图读盘的工厂会当场拿到 `ERR_ACCESS_DENIED` 并导致
 * 安装被拒(这本身就是"恶意执行体"的一道诊断)。
 */
const VERIFY_BOOTSTRAP = [
  '"use strict";',
  'const MAX=8*1024*1024;let raw="";process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",c=>{raw+=c;if(raw.length>MAX){process.stdout.write("@@mcode:ext-verify "+JSON.stringify({ok:false,message:"payload too large"})+"\\n");process.exit(0);}});',
  'process.stdin.on("end",()=>{ let p; try{p=JSON.parse(raw);}catch(e){process.stdout.write("@@mcode:ext-verify "+JSON.stringify({ok:false,message:String(e&&e.message||e),proof:p && p.proof})+"\\n");return;}',
  '  (async()=>{ const protocolWrite=process.stdout.write.bind(process.stdout); try{',
  '    if(typeof mcodeNetworkGuardSelfCheck==="function")mcodeNetworkGuardSelfCheck();',
  '    const guardTimer=typeof mcodeNetworkGuardSelfCheck==="function"?setInterval(()=>{try{mcodeNetworkGuardSelfCheck()}catch(e){process.stderr.write("network_guard_integrity_failed: "+String(e)+"\\n");process.exit(78)}},50):null;',
  '    if(guardTimer)guardTimer.unref();',
  '    const factory=(0,eval)("("+p.source+")");',
  '    if(!factory||typeof factory!=="object"||Array.isArray(factory))throw Error("扩展程序工厂没有求出对象");',
  '    const declared=Object.keys(factory);',
  '    if(declared.length>12)throw Error("扩展程序声明的能力过多");',
  '    for(const name of p.capabilities) if(typeof factory[name]!=="function")throw Error("扩展程序没有声明能力 "+name);',
  '    protocolWrite("@@mcode:ext-verify "+JSON.stringify({ok:true,declared,proof:p.proof})+"\\n");',
  '  }catch(e){ protocolWrite("@@mcode:ext-verify "+JSON.stringify({ok:false,message:String(e&&e.message||e),proof:p && p.proof})+"\\n"); }})();',
  '});',
].join("\n");

/** 核验结果:成功时给工厂声明的短名(诊断用),失败时给人能读懂的原因。 */
export type ProgramVerification = { ok: true; declared: string[] } | { ok: false; reason: string };

/** OS egress is applied wherever available; Windows has only a JS network guard.
 * The downgrade is explicit in the result, never represented as OS isolation.
 * Linux/macOS still require a verified OS probe before executing untrusted code.
 * A manifest that *declares* network is separately blocked on Windows at install
 * and invocation (including restored manifests), rather than silently downgrading.
 */
type EgressLaunch = { command: string; prefix: string[] };
export type EgressMode = "explicitly-approved" | "js-guard-only" | "os-sandbox";
/** Pure platform decision, for OS branch testing without pretending to run Linux on Windows. */
export function egressMode(platform: NodeJS.Platform, allowNetwork: boolean): EgressMode {
  if (allowNetwork) return "explicitly-approved";
  return platform === "win32" ? "js-guard-only" : "os-sandbox";
}
/** Manifests that request network must not be installed or invoked on unsupported Windows.
 * This also protects already-persisted manifests restored after upgrading Mcode. */
export function requireNetworkExtensionSupport(): void {
  if (process.platform === "win32") {
    throw Error("egress_isolation_unavailable: 这台 Windows 机器没有可验证的 OS 网络沙箱，无法安装或运行声明 network 的可执行扩展；请在支持 OS 网络隔离的平台安装，或移除 network 权限。");
  }
}
/**
 * Explicit JS-only downgrade is a *host-owned persisted user setting*, not a
 * manifest field, environmental variable or per-invocation option (which the
 * untrusted caller could self-grant). Reader is injected by the production
 * module service and evaluated on EVERY installation verification/invocation:
 * revocation is immediate; missing/throwing reader fails closed.
 */
let jsOnlyEgressConsentReader: (() => boolean) | null = null;
export function configureJsOnlyEgressConsentReader(reader: (() => boolean) | null): void {
  jsOnlyEgressConsentReader = reader;
}
export function hasJsOnlyEgressConsent(): boolean {
  try { return jsOnlyEgressConsentReader?.() === true; } catch { return false; }
}
/** One launch decision for installer and runtime, never skip a required OS probe. */
async function unapprovedNetworkLaunch(): Promise<EgressLaunch> {
  if (egressMode(process.platform, false) === "js-guard-only") {
    if (!hasJsOnlyEgressConsent()) {
      throw Error("egress_isolation_unavailable: Windows 无 OS 网络沙箱；默认拒绝运行所有可执行扩展。请在「设置 → 扩展 → 模块管理」明确启用仅 JS 网络守卫的风险降级，或换用有 OS 隔离的平台。");
    }
    return { command: process.execPath, prefix: [] };
  }
  return egressLaunch();
}
let cachedEgressLaunch: Promise<EgressLaunch> | undefined;
const EGRESS_PROBE = String.raw`
const net=require("node:net");
const socket=net.connect({host:"127.0.0.1",port:9});
const timer=setTimeout(()=>{console.log("MCODE_OS_EGRESS=TIMEOUT");process.exit(18)},1000);
socket.on("connect",()=>{clearTimeout(timer);console.log("MCODE_OS_EGRESS=CONNECTED");process.exit(19)});
socket.on("error",e=>{
  clearTimeout(timer);
  console.log("MCODE_OS_EGRESS="+e.code);
  process.exitCode=["ENETUNREACH","EHOSTUNREACH","EPERM","EACCES"].includes(e.code)?0:20;
});
`;
async function egressLaunch(): Promise<EgressLaunch> {
  if (!cachedEgressLaunch) cachedEgressLaunch = (async () => {
    let launch: EgressLaunch;
    if (process.platform === "linux") {
      launch = {
        command: "/usr/bin/unshare",
        prefix: ["--user", "--map-root-user", "--net", "--", process.execPath],
      };
    } else if (process.platform === "darwin") {
      launch = {
        command: "/usr/bin/sandbox-exec",
        prefix: ["-p", "(version 1)\\n(allow default)\\n(deny network*)", process.execPath],
      };
    } else {
      throw Error("egress_isolation_unavailable: 当前系统没有可验证的独立进程 OS 网络沙箱(" + process.platform + ")，拒绝执行未授权网络的扩展");
    }
    const probe = await spawnRun({
      command: launch.command, args: [...launch.prefix, "-e", EGRESS_PROBE],
      env: permissionedEnv(), stdin: "", timeoutMs: 2500,
      signal: new AbortController().signal, limitBytes: 8192,
    });
    const verified = probe.code === 0 &&
      /^MCODE_OS_EGRESS=(ENETUNREACH|EHOSTUNREACH|EPERM|EACCES)$/m.test(probe.stdout) &&
      !probe.spawnError && !probe.killedBy.timeout && !probe.stdoutTruncated;
    if (!verified) {
      throw Error("egress_isolation_unavailable: OS 沙箱探针未证明网络被内核阻断(exit=" +
        String(probe.code) + "; " +
        (probe.spawnError?.message ?? probe.stdout.trim() ?? probe.stderr.trim()).slice(0, 200) + ")");
    }
    return launch;
  })();
  return cachedEgressLaunch;
}

/** Read-only, real OS capability probe (no extension code is evaluated). */
export async function diagnoseEgressIsolation(): Promise<{ supported: boolean; detail: string }> {
  try {
    const launch = await egressLaunch();
    return { supported: true, detail: "OS probe verified: " + launch.command };
  } catch (error) {
    return { supported: false, detail: String(error) };
  }
}

/**
 * 在受控进程里求值一次工厂源码,确认清单引用的每个短名都是函数。
 *
 * 这是 v1 的「签名/元数据不符」判据:**语句层**的元数据(清单说引用了什么)必须与
 * **执行层**的事实(工厂真的声明了什么)一致,不一致在安装**落盘之前**拒绝。
 * 不做密码学签名 —— 那是下一版扩展包格式的事,不在本函数里假装。
 */
export async function verifyPermissionedProgram(
  source: string,
  capabilities: readonly string[],
  timeoutMs = 10_000,
): Promise<ProgramVerification> {
  // 每次核验用独立随机关联值；阻断仅伪造一条 stdout 结果并 exit(0) 的旧反例。
  // 扩展与引导程序仍同进程，关联值不代表 OS 沙箱或强隔离认证。
  const proof = randomBytes(32).toString("hex");
  let launch: EgressLaunch;
  try { launch = await unapprovedNetworkLaunch(); }
  catch (e) { return { ok: false, reason: String(e) }; }
  const result = await spawnRun({
    command: launch.command,
    // 【MC-035】安装核验本身会求值不受信工厂；此时尚无逐次网络批准。
    // 与正式执行共用同一网络防护，不允许工厂借核验期先行外传。
    args: [...launch.prefix, "--permission", "-e", NETWORK_GUARD + VERIFY_BOOTSTRAP],
    env: permissionedEnv(),
    stdin: JSON.stringify({ source, capabilities, proof }),
    timeoutMs,
    signal: new AbortController().signal,
    limitBytes: 64 * 1024,
  });
  if (result.spawnError) return { ok: false, reason: "核验进程启动失败:" + result.spawnError.message };
  if (result.killedBy.timeout) return { ok: false, reason: "核验进程超时(可能不是可求值的工厂)" };
  // 【MC-035】安装期未受信代码也能打印协议行；失败退出或协议被截断不得判成功。
  if (result.code !== 0 || result.stdoutTruncated || result.stdoutLineTruncated) {
    return { ok: false, reason: "核验进程异常退出或输出截断(exit=" + String(result.code) + "): " + result.stderr.trim().slice(-400) };
  }
  // 不受信工厂也能打印 @@mcode 前缀；有多条结果行即协议污染，绝不选最后一条。
  const replyLines = result.stdout.split("\n").filter((line) => line.startsWith("@@mcode:ext-verify "));
  if (replyLines.length !== 1) {
    return { ok: false, reason: "核验结果协议数量异常(" + replyLines.length + ")，拒绝不可信输出" };
  }
  let reply: VerifyReply | null = null;
  try {
    const value = JSON.parse(replyLines[0]!.slice("@@mcode:ext-verify ".length)) as unknown;
    reply = value && typeof value === "object" ? (value as VerifyReply) : null;
  } catch { reply = null; }
  if (!reply) return { ok: false, reason: "核验进程没有返回可识别结果(退出码 " + String(result.code) + ")" };
  if (reply.proof !== proof) return { ok: false, reason: "核验协议关联值不匹配" };
  if (reply.ok !== true) {
    return { ok: false, reason: typeof reply.message === "string" ? reply.message : "程序核验失败" };
  }
  const declared = Array.isArray(reply.declared) ? reply.declared.filter((v): v is string => typeof v === "string") : [];
  return { ok: true, declared };
}

/** 扩展进程的环境:只带运行所需的最小集合,不继承宿主环境(见文件头)。 */
export function permissionedEnv(): NodeJS.ProcessEnv {
  const path = process.env.PATH ?? process.env.Path ?? "";
  return {
    ELECTRON_RUN_AS_NODE: "1",
    ...(path ? { PATH: path } : {}),
    // 关掉可能改变加载行为的宿主变量(没有它们时 NODE_OPTIONS 仍会生效)。
    NODE_OPTIONS: "",
  };
}

interface BootReply { ok?: unknown; result?: unknown; code?: unknown; message?: unknown; proof?: unknown }
interface VerifyReply { ok?: unknown; declared?: unknown; message?: unknown; proof?: unknown }

/** 隔离失败码全集(含 `isolated_denied`) —— 供 IPC/执行器的结果分类共用。 */
export const PERMISSIONED_FAILURE_CODES = [...ISOLATION_FAILURE_CODES, "isolated_denied"] as const;
export type PermissionedFailureCode = (typeof PERMISSIONED_FAILURE_CODES)[number];

function failure(code: PermissionedFailureCode, reason: string): Error {
  const error = new Error(reason);
  // 集合比 `IsolationFailure` 宽一档(`isolated_denied`),共用同一个标记 —— 调用端
  // 读不到本模块也能凭标记判类别。
  const payload: { code: PermissionedFailureCode; reason: string } = { code, reason };
  (error as unknown as Record<string, unknown>)[ISOLATION_FAILURE_MARKER] = payload;
  return error;
}

/** 从结果行解析回包;不是回包形状就返回 `null`(调用方按 crash 处理)。 */
function parseReply(line: string): BootReply | null {
  const prefix = "@@mcode:ext-result ";
  if (!line.startsWith(prefix)) return null;
  try {
    const value = JSON.parse(line.slice(prefix.length)) as unknown;
    return value && typeof value === "object" ? (value as BootReply) : null;
  } catch {
    return null;
  }
}

/**
 * 在受控子进程里执行一次扩展能力。**不做授权判定** —— 调用方(`ModuleHost.invoke`)
 * 已在派发前完成资源作用域与逐次审批;本函数只负责"按给定权限跑、按类别失败"。
 */
export async function runPermissionedProcess(
  options: PermissionedProcessOptions,
): Promise<ModuleResult> {
  const proof = randomBytes(32).toString("hex");
  const payload = JSON.stringify({
    proof,
    source: options.source,
    capability: options.capability,
    resource: options.resource,
  });
  // Explicit network approval retains its existing direct path. Unapproved
  // network on Linux/macOS still *requires* OS isolation; on Windows the guard
  // runs alone, and that reduced guarantee is reported in every success reply.
  const mode = egressMode(process.platform, options.allowNetwork === true);
  let launch: EgressLaunch = { command: process.execPath, prefix: [] };
  if (mode !== "explicitly-approved") {
    try { launch = await unapprovedNetworkLaunch(); }
    catch (e) { throw failure("isolated_denied", String(e)); }
  }
  const bootstrap = options.allowNetwork === true ? BOOTSTRAP : NETWORK_GUARD + BOOTSTRAP;
  if (options.onAppCall) {
    return runDuplexAppProcess(options, launch, mode, proof, payload);
  }
  // 单行协议在 `spawnRun` 里按字节切行;上限给足一个结果窗(32 个字段 × 4 KiB 余量)。
  const result = await spawnRun({
    command: launch.command,
    args: [...launch.prefix, ...permissionArgs(options.resource.path, options.allowWrite), "-e", bootstrap],
    env: permissionedEnv(),
    stdin: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    limitBytes: 256 * 1024,
  });
  if (result.spawnError) {
    throw failure("isolated_spawn_failed", "扩展执行进程启动失败:" + result.spawnError.message);
  }
  if (result.killedBy.abort) throw failure("isolated_cancelled", "扩展执行已取消。");
  if (result.killedBy.timeout) {
    throw failure("isolated_timeout", "扩展执行超时(" + options.timeoutMs + " 毫秒),已终止。");
  }
  // 【MC-035】扩展源码可直接向 stdout 伪造 @@mcode:ext-result 协议行。
  // 非零退出/被信号终止、输出截断时绝不能从那一行宣称执行成功。
  if (result.code !== 0 || result.stdoutTruncated || result.stdoutLineTruncated) {
    throw failure(
      "isolated_crash",
      "扩展执行进程异常退出或协议输出截断(exit=" + String(result.code) + ")。" + result.stderr.trim().slice(-400),
    );
  }
  // 【MC-035】多个协议前缀说明扩展自己伪造/重放了返回行。
  // 禁止「选最后一条」，必须恰好一条并由宿主按原始退出状态核验。
  const protocolLines = result.stdout.split("\n").filter((line) => line.startsWith("@@mcode:ext-result "));
  if (protocolLines.length !== 1) {
    throw failure("isolated_crash", "扩展执行结果协议数量异常(" + protocolLines.length + ")，拒绝不可信输出。");
  }
  const reply: BootReply | null = parseReply(protocolLines[0]!);
  if (!reply) {
    const tail = (result.stderr || result.stdout).trim().split("\n").slice(-4).join("\n");
    throw failure(
      "isolated_crash",
      "扩展执行进程在返回结果前退出(退出码 " + String(result.code) + ")。" + (tail ? "输出:" + tail : ""),
    );
  }
  if (reply.proof !== proof) {
    throw failure("isolated_crash", "执行协议关联值不匹配。");
  }
  if (reply.ok === true) {
    const validated = ResultSchema.safeParse(reply.result);
    if (!validated.success) {
      throw failure("isolated_crash", "扩展程序返回值不符合 ModuleResult 合同（字段类型/大小/数量）。");
    }
    if (mode === "js-guard-only") {
      // Added by the trusted parent, not supplied by the extension. This is part
      // of the ModuleResult returned through ModuleHost / IPC for diagnostics.
      const annotated = ResultSchema.safeParse({
        ...validated.data,
        _mcodeEgressIsolation: "js-guard-only; OS egress isolation unavailable",
      });
      if (!annotated.success) throw failure("isolated_crash", "扩展返回值没有空间携带必需的 Windows JS-only 网络隔离诊断");
      return annotated.data;
    }
    return validated.data;
  }
  const message = typeof reply.message === "string" ? reply.message : "扩展程序执行失败";
  if (reply.code === "denied") {
    throw failure("isolated_denied", "扩展试图访问未获授权的位置:" + message);
  }
  // 扩展自己的普通错误原样透传(与 worker 路径一致:调用端看到的是程序报的错)。
  throw Error(message);
}

/** 读回失败码:先按共享标记读,`isolated_denied` 也落在同一个标记上。 */
export function permissionedFailure(error: unknown): { code: PermissionedFailureCode; reason: string } | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[ISOLATION_FAILURE_MARKER];
  if (!value || typeof value !== "object") return null;
  const { code, reason } = value as { code?: unknown; reason?: unknown };
  if (typeof code !== "string" || typeof reason !== "string") return null;
  if (!(PERMISSIONED_FAILURE_CODES as readonly string[]).includes(code)) return null;
  return { code: code as PermissionedFailureCode, reason };
}


/** Duplex extension program bootstrap. The network/Node permission guards are installed
 * before this code; only the trusted host can answer RPC requests over stdin. */
const DUPLEX_BOOTSTRAP = String.raw`
"use strict";
const MAX=8*1024*1024;
let incoming="", initial=null, nextId=1, completed=false;
const waiting=new Map();
const write=process.stdout.write.bind(process.stdout);
const emit=(value, done)=>write("@@mcode:ext-result "+JSON.stringify(value)+"\n",done);
function dispatchLine(line) {
  if (initial===null) {
    if (line.length>MAX) throw Error("extension input too large");
    initial=JSON.parse(line);
    void execute(initial);
    return;
  }
  const reply=JSON.parse(line);
  if (!reply || reply.__mcode_reply!==1 || !Number.isInteger(reply.id)) throw Error("invalid RPC reply");
  const item=waiting.get(reply.id);
  if (!item) throw Error("unknown RPC reply id");
  waiting.delete(reply.id);
  if (reply.ok===true) item.resolve(reply.result);
  else item.reject(Error(typeof reply.error==="string"?reply.error:"extension RPC denied"));
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk=>{
  incoming+=chunk;
  if (incoming.length>MAX) {process.stderr.write("extension protocol input exceeded limit\n");process.exit(79);}
  let end;
  while((end=incoming.indexOf("\n"))!==-1) {
    const line=incoming.slice(0,end); incoming=incoming.slice(end+1);
    try {dispatchLine(line);} catch(e) {process.stderr.write("invalid extension RPC input: "+String(e)+"\n");process.exit(79);}
  }
});
async function execute(p) {
  try {
    if(typeof mcodeNetworkGuardSelfCheck==="function")mcodeNetworkGuardSelfCheck();
    const guardTimer=typeof mcodeNetworkGuardSelfCheck==="function"?setInterval(()=>{
      try{mcodeNetworkGuardSelfCheck()}catch(e){process.stderr.write("network_guard_integrity_failed\n");process.exit(78);}
    },50):null;
    if(guardTimer)guardTimer.unref();
    const api=Object.freeze({call:(method,input)=>{
      if(completed) return Promise.reject(Error("extension already finished"));
      if(typeof method!=="string"||method.length>128||!/^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/.test(method))
        return Promise.reject(Error("invalid RPC method"));
      if(nextId>128||waiting.size>=8) return Promise.reject(Error("extension RPC quota exceeded (128 calls, 8 concurrent)"));
      const id=nextId++;
      let encoded;
      try {encoded=JSON.stringify({__mcode_call:1,id,method,input});}
      catch(e){return Promise.reject(e);}
      if(encoded.length>65536) return Promise.reject(Error("extension RPC request exceeds 64 KiB"));
      return new Promise((resolve,reject)=>{
        waiting.set(id,{resolve,reject});
        write("@@mcode:ext-call "+encoded+"\n");
      });
    }});
    Object.defineProperty(globalThis,"mcode",{value:Object.freeze({api}),writable:false,configurable:false});
    const factory=(0,eval)("("+p.source+")");
    if(!factory||typeof factory!=="object")throw Error("扩展程序工厂没有求出对象");
    const fn=factory[p.capability];
    if(typeof fn!=="function")throw Error("扩展程序没有声明能力 "+p.capability);
    const result=await fn(p.resource);
    if(waiting.size>0)throw Error("extension ended with pending RPC calls");
    if(typeof mcodeNetworkGuardSelfCheck==="function")mcodeNetworkGuardSelfCheck();
    completed=true;
    emit({ok:true,result,proof:p.proof},()=>process.exit(0));
  }catch(e) {
    completed=true;
    const message=String(e&&e.message||e);
    const denied=/ERR_ACCESS_DENIED|Access to this API has been restricted|ERR_ACCESS_PERMISSION|permission/i.test(message);
    emit({ok:false,code:denied?"denied":"failed",message,proof:p.proof},()=>process.exit(0));
  }
}
`;

/** The legacy single-shot protocol remains untouched for existing callers. This
 * opt-in channel enforces process, output, request-count and concurrency bounds. */
async function runDuplexAppProcess(
  options: PermissionedProcessOptions, launch: EgressLaunch, mode: EgressMode,
  proof: string, payload: string,
): Promise<ModuleResult> {
  const bootstrap = options.allowNetwork === true ? DUPLEX_BOOTSTRAP : NETWORK_GUARD + DUPLEX_BOOTSTRAP;
  return new Promise<ModuleResult>((resolve, reject) => {
    const child = spawn(launch.command,
      [...launch.prefix, ...permissionArgs(options.resource.path, options.allowWrite), "-e", bootstrap],
      { env: permissionedEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", stderr = "", total = 0, calls = 0, inFlight = 0;
    let resultLine: BootReply | null = null, results = 0;
    let overflow = false, timedOut = false, aborted = false, spawnError: Error | null = null;
    let ended = false;
    const kill = (): void => { if (!child.killed) child.kill(); };
    const timer = setTimeout(() => {timedOut = true; kill();}, options.timeoutMs);
    const cancel = (): void => { aborted = true; kill(); };
    if (options.signal.aborted) cancel();
    else options.signal.addEventListener("abort", cancel, {once:true});
    const sendReply = (reply: Record<string, unknown>): void => {
      if (ended || !child.stdin.writable) return;
      const encoded = JSON.stringify(reply);
      if (encoded.length>256*1024) {overflow=true;kill();return;}
      child.stdin.write(encoded+"\n");
    };
    const acceptLine = (line: string): void => {
      if (line.startsWith("@@mcode:ext-result ")) {
        results++;
        if(results===1)resultLine=parseReply(line);
        else {overflow=true;kill();}
        return;
      }
      if (!line.startsWith("@@mcode:ext-call ")) return;
      let call: any;
      try {call=JSON.parse(line.slice("@@mcode:ext-call ".length));}
      catch {overflow=true;kill();return;}
      if (!call || call.__mcode_call!==1 || !Number.isSafeInteger(call.id) ||
          call.id<1 || call.id>128 || typeof call.method!=="string" || call.method.length>128 ||
          ++calls>128 || inFlight>=8 || Buffer.byteLength(line)>65536) {
        overflow=true; kill();return;
      }
      inFlight++;
      void Promise.resolve().then(()=>options.onAppCall!(call.method,call.input))
        .then(value=>sendReply({__mcode_reply:1,id:call.id,ok:true,result:value,proof}),
          error=>sendReply({__mcode_reply:1,id:call.id,ok:false,error:String(error instanceof Error?error.message:error).slice(0,2000),proof}))
        .finally(()=>{inFlight--;});
    };
    child.stdout.on("data", (chunk: Buffer) => {
      total+=chunk.length;
      if(total>256*1024) {overflow=true;kill();return;}
      out+=chunk.toString("utf8");
      let end: number;
      while((end=out.indexOf("\n"))!==-1) {
        const line=out.slice(0,end);out=out.slice(end+1);
        acceptLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {stderr=(stderr+chunk.toString("utf8")).slice(-4000);});
    child.on("error", (error: Error) => {spawnError=error;});
    child.on("close", (code: number|null) => {
      ended=true;clearTimeout(timer);options.signal.removeEventListener("abort",cancel);
      if (aborted) return reject(failure("isolated_cancelled","扩展执行已取消。"));
      if (timedOut) return reject(failure("isolated_timeout","扩展执行超时("+options.timeoutMs+" 毫秒),已终止。"));
      if (spawnError) return reject(failure("isolated_spawn_failed","扩展执行进程启动失败:"+spawnError.message));
      if (overflow || code!==0 || out.length>0 || results!==1 || !resultLine) {
        return reject(failure("isolated_crash","扩展双向协议异常或子进程崩溃(exit="+code+"). "+stderr.slice(-400)));
      }
      if(resultLine.proof!==proof) return reject(failure("isolated_crash","扩展结果关联值不匹配"));
      if(resultLine.ok!==true) {
        const message=typeof resultLine.message==="string"?resultLine.message:"扩展程序执行失败";
        if(resultLine.code==="denied") return reject(failure("isolated_denied",message));
        return reject(Error(message));
      }
      const validated=ResultSchema.safeParse(resultLine.result);
      if(!validated.success) return reject(failure("isolated_crash","扩展程序返回值不符合 ModuleResult 合同"));
      if(mode==="js-guard-only") {
        const diagnostic=ResultSchema.safeParse({
          ...validated.data, _mcodeEgressIsolation:"js-guard-only; OS egress isolation unavailable",
        });
        if(!diagnostic.success) return reject(failure("isolated_crash","扩展返回值没有空间携带隔离诊断"));
        return resolve(diagnostic.data);
      }
      resolve(validated.data);
    });
    child.stdin.on("error",()=>{});
    child.stdin.write(payload+"\n");
  });
}
