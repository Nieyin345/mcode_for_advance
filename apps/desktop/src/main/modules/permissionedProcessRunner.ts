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
import type { ModuleResult } from "@contracts/modules";
import { ISOLATION_FAILURE_CODES, ISOLATION_FAILURE_MARKER } from "./isolatedActionRunner.js";

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
 *   - `http` / `https` / `http2` 的 `request` / `get` / `connect`;
 *   - `net` 的 `connect` / `createConnection`;
 *   - `dns` 的查询函数(否则可先解析到 IP 再走其它路径);
 *   - 全局 `fetch` / `WebSocket` / `EventSource`。
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
(function installNetworkGuard(){
  try {
    const deny = (what) => function(){ throw new Error("network_access_denied: 扩展未声明网络权限(" + what + ")"); };
    for (const name of ["http","https","http2"]) {
      try {
        const mod = require("node:" + name);
        for (const key of ["request","get","connect"]) {
          if (typeof mod[key] === "function") mod[key] = deny(name + "." + key);
        }
      } catch (e) { /* 模块不在(老版本) — 忽略 */ }
    }
    try {
      const net = require("node:net");
      for (const key of ["connect","createConnection"]) {
        if (typeof net[key] === "function") net[key] = deny("net." + key);
      }
    } catch (e) {}
    try {
      const dns = require("node:dns");
      for (const key of ["lookup","resolve","resolve4","resolve6","resolveAny"]) {
        if (typeof dns[key] === "function") dns[key] = deny("dns." + key);
      }
    } catch (e) {}
    for (const key of ["fetch","WebSocket","EventSource"]) {
      if (typeof globalThis[key] === "function") globalThis[key] = deny(key);
    }
  } catch (e) { /* 拦截本身失败不应让扩展崩溃 — 调用方仍会得到结果 */ }
})();
`;

const BOOTSTRAP = [
  '"use strict";',
  'const MAX=8*1024*1024;',
  'let raw="";process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",c=>{raw+=c;if(raw.length>MAX){process.stdout.write("@@mcode:ext-result "+JSON.stringify({ok:false,code:"input",message:"payload too large"})+"\\n");process.exit(0);}});',
  'process.stdin.on("end",()=>{ let p; try{p=JSON.parse(raw);}catch(e){process.stdout.write("@@mcode:ext-result "+JSON.stringify({ok:false,code:"input",message:String(e&&e.message||e)})+"\\n");return;}',
  '  (async()=>{ try{',
  '    const factory=eval("("+p.source+")");',
  '    if(!factory||typeof factory!=="object")throw Error("扩展程序工厂没有求出对象");',
  '    const fn=factory[p.capability];',
  '    if(typeof fn!=="function")throw Error("扩展程序没有声明能力 "+p.capability);',
  '    const result=await fn(p.resource);',
  '    process.stdout.write("@@mcode:ext-result "+JSON.stringify({ok:true,result})+"\\n");',
  '  }catch(e){',
  '    const message=String(e&&e.message||e);',
  '    const denied=/ERR_ACCESS_DENIED|Access to this API has been restricted|ERR_ACCESS_PERMISSION|permission/i.test(message);',
  '    process.stdout.write("@@mcode:ext-result "+JSON.stringify({ok:false,code:denied?"denied":"failed",message})+"\\n");',
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
  'process.stdin.on("end",()=>{ let p; try{p=JSON.parse(raw);}catch(e){process.stdout.write("@@mcode:ext-verify "+JSON.stringify({ok:false,message:String(e&&e.message||e)})+"\\n");return;}',
  '  (async()=>{ try{',
  '    const factory=eval("("+p.source+")");',
  '    if(!factory||typeof factory!=="object"||Array.isArray(factory))throw Error("扩展程序工厂没有求出对象");',
  '    const declared=Object.keys(factory);',
  '    if(declared.length>12)throw Error("扩展程序声明的能力过多");',
  '    for(const name of p.capabilities) if(typeof factory[name]!=="function")throw Error("扩展程序没有声明能力 "+name);',
  '    process.stdout.write("@@mcode:ext-verify "+JSON.stringify({ok:true,declared})+"\\n");',
  '  }catch(e){ process.stdout.write("@@mcode:ext-verify "+JSON.stringify({ok:false,message:String(e&&e.message||e)})+"\\n"); }})();',
  '});',
].join("\n");

/** 核验结果:成功时给工厂声明的短名(诊断用),失败时给人能读懂的原因。 */
export type ProgramVerification = { ok: true; declared: string[] } | { ok: false; reason: string };

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
  const result = await spawnRun({
    command: process.execPath,
    args: ["--permission", "-e", VERIFY_BOOTSTRAP],
    env: permissionedEnv(),
    stdin: JSON.stringify({ source, capabilities }),
    timeoutMs,
    signal: new AbortController().signal,
    limitBytes: 64 * 1024,
  });
  if (result.spawnError) return { ok: false, reason: "核验进程启动失败:" + result.spawnError.message };
  if (result.killedBy.timeout) return { ok: false, reason: "核验进程超时(可能不是可求值的工厂)" };
  const lines = result.stdout.split("\n");
  let reply: VerifyReply | null = null;
  for (let index = lines.length - 1; index >= 0 && reply === null; index--) {
    const line = lines[index]!;
    if (!line.startsWith("@@mcode:ext-verify ")) continue;
    try {
      const value = JSON.parse(line.slice("@@mcode:ext-verify ".length)) as unknown;
      reply = value && typeof value === "object" ? (value as VerifyReply) : null;
    } catch { reply = null; }
  }
  if (!reply) return { ok: false, reason: "核验进程没有返回可识别结果(退出码 " + String(result.code) + ")" };
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

interface BootReply { ok?: unknown; result?: unknown; code?: unknown; message?: unknown }
interface VerifyReply { ok?: unknown; declared?: unknown; message?: unknown }

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
  const payload = JSON.stringify({
    source: options.source,
    capability: options.capability,
    resource: options.resource,
  });
  // 【MC-035】网络拦截**先于**工厂求值:未声明网络的扩展拿到的 http/net/fetch 已被
  // 替换成抛错函数。声明并批准了就是原样(见 NETWORK_GUARD 的注释)。
  const bootstrap = options.allowNetwork === true ? BOOTSTRAP : NETWORK_GUARD + BOOTSTRAP;
  // 单行协议在 `spawnRun` 里按字节切行;上限给足一个结果窗(32 个字段 × 4 KiB 余量)。
  const result = await spawnRun({
    command: process.execPath,
    args: [...permissionArgs(options.resource.path, options.allowWrite), "-e", bootstrap],
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
  // 协议行优先从 stdout 尾部往回找(扩展自己的日志可能在前);一次调用只应有一条。
  const lines = result.stdout.split("\n");
  let reply: BootReply | null = null;
  for (let index = lines.length - 1; index >= 0 && reply === null; index--) {
    reply = parseReply(lines[index]!);
  }
  if (!reply) {
    const tail = (result.stderr || result.stdout).trim().split("\n").slice(-4).join("\n");
    throw failure(
      "isolated_crash",
      "扩展执行进程在返回结果前退出(退出码 " + String(result.code) + ")。" + (tail ? "输出:" + tail : ""),
    );
  }
  if (reply.ok === true) {
    if (reply.result === null || typeof reply.result !== "object" || Array.isArray(reply.result)) {
      throw failure("isolated_crash", "扩展程序返回的不是结果对象。");
    }
    return reply.result as ModuleResult;
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
