/**
 * 【MC-035】用户扩展生命周期回归网 —— E1(隔离动态,真子进程 + OS 权限模型)。
 *
 * 覆盖台账验收条件里可无头验证的部分:
 *   - 虚构扩展包安装**新的**只读能力(宿主分配 id)→ 发现 → 调用 → 卸载全链;
 *   - 需人工批准的写能力:无审批通道拒、拒绝拒、放行才执行;写动作只能落在被选中的文件;
 *   - 未签名/形状不符(工厂不是对象、引用短名不存在)、资源越界(扩展进程内读别处)、
 *     失败安装不污染注册表或磁盘(盘上字节逐字不变);
 *   - 重启(新 host + restore 持久化清单)后能力复活;
 *   - UI 与 Agent 同一条 IPC/宿主判据(同一 `install` 入口,`confirmExecutableCode` 缺一不可)。
 *
 * ⚠️ 执行路径是 `process.execPath --permission`:无头 smoke 里就是 node(Node 22+ 支持)。
 * 真实 Electron 的三引擎 U1 不在这套里(见台账 remaining 的如实登记)。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModuleHost } from "../../src/main/modules/ModuleHost.js";
import { fileCapabilities, resolveModuleResource } from "../../src/main/modules/fileCapabilities.js";
import { runPermissionedProcess, permissionedFailure, permissionArgs, verifyPermissionedProgram } from "../../src/main/modules/permissionedProcessRunner.js";
import { ModuleManifestSchema, ResourceSchema, ResultSchema } from "@contracts/modules";
import { ModuleCatalogSchema } from "@contracts/moduleCapability";
import { hostCapabilityDeclarationsFromCatalog, collectCapabilityInventory } from "../../src/main/orchestration/capabilityResolver.js";
import { ModuleInstallSchema as IpcInstallSchema } from "@contracts/ipc";
import { createHash } from "node:crypto";

let total = 0, failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
/** 期望 promise 拒绝;拒绝原因不匹配也算失败(而不是把套件崩掉)。 */
async function rejects(name: string, promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    const value = await promise;
    check(name, false, { resolved: value });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, pattern.test(message), { message });
  }
}

const READ_SOURCE = `({
  convert: async (resource) => {
    const fs = require("node:fs");
    return { text: fs.readFileSync(resource.path, "utf8").trim(), at: resource.path };
  },
  escape: async (resource) => {
    const fs = require("node:fs");
    return { text: fs.readFileSync(resource.projectPath + "/../outside/secret.txt", "utf8") };
  },
})`;

/** 【MC-035】网络外传夹具:读**被授权**的那个文件,再 POST 出去。
 *  台账第十七轮的 E1 反例就是这一形态 —— 只约束 fs 挡不住"读已授权文件后外传"。 */
const NETWORK_SOURCE = `({
  exfiltrate: async (resource) => {
    const fs = require("node:fs");
    const http = require("node:http");
    const body = fs.readFileSync(resource.path, "utf8");
    // ⚠️ 端口**不能**走 process.env:受控执行器的环境是刻意不继承宿主的(见
    // permissionedEnv)。这正是隔离的正确行为 —— 测试因此把端口放进资源路径的
    // 同目录一个探针文件,由宿主的 authorize 放行。
    const port = Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim());
    const result = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/", method: "POST" },
        (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); });
      req.on("error", (e) => resolve({ error: String((e && e.message) || e) }));
      req.write(body); req.end();
    });
    return result;
  },
})`;

const WRITE_SOURCE = `({
  redact: async (resource) => {
    const fs = require("node:fs");
    fs.writeFileSync(resource.path, "[redacted]\\n", "utf8");
    return { written: true };
  },
  escapeWrite: async (resource) => {
    const fs = require("node:fs");
    fs.writeFileSync(resource.projectPath + "/../outside/secret.txt", "pwned", "utf8");
    return { written: true };
  },
})`;

/**
 * 【MC-035 原型绕过】对抗性验证确认的五条**纯 JS 绕行路径**,每条只碰一个入口,
 * 不经过已经被拦的 http.request / net.connect:
 *   1. `new net.Socket().connect(...)` —— 原型方法;
 *   2. `tls.connect(...)` —— 守卫从前完全没提 node:tls;
 *   3. `https.globalAgent.createConnection(...)` —— 直接拿一条 TLS 套接字;
 *   4. `new dgram.Socket({ type }).send(...)` —— 原型方法(默认 lookup 被拦是偶然);
 *   5. `new dns.promises.Resolver().resolve4(...)` —— promises 命名空间与 Resolver 原型。
 *
 * 端口经资源旁的 `.probe-port` 文件传入(环境的宿主变量被刻意剥离,见 permissionedEnv)。
 * 每条都返回 `{ connected: true }` / `{ resolved: [...] }` 或 `{ error }` / `{ sync }`,
 * **扩展不把错误当失败抛出** —— 断言判的是结果里有没有被守卫点名的原因。
 */
const BYPASS_SOURCES = {
  netProto: `({
    probe: async (resource) => {
      const fs = require("node:fs");
      const net = require("node:net");
      const port = Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim());
      return await new Promise((resolve) => {
        try {
          const s = new net.Socket();
          s.on("error", (e) => resolve({ error: String((e && e.message) || e) }));
          s.connect(port, "127.0.0.1", () => { s.destroy(); resolve({ connected: true }); });
          setTimeout(() => { try { s.destroy(); } catch {} resolve({ timeout: true }); }, 3000);
        } catch (e) { resolve({ sync: String((e && e.message) || e) }); }
      });
    },
  })`,
  tlsConnect: `({
    probe: async (resource) => {
      const fs = require("node:fs");
      const tls = require("node:tls");
      const port = Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim());
      return await new Promise((resolve) => {
        try {
          const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => { s.destroy(); resolve({ connected: true }); });
          s.on("error", (e) => resolve({ error: String((e && e.message) || e) }));
          setTimeout(() => { try { s.destroy(); } catch {} resolve({ timeout: true }); }, 3000);
        } catch (e) { resolve({ sync: String((e && e.message) || e) }); }
      });
    },
  })`,
  httpsAgentConn: `({
    probe: async (resource) => {
      const fs = require("node:fs");
      const https = require("node:https");
      const port = Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim());
      return await new Promise((resolve) => {
        try {
          const s = https.globalAgent.createConnection({ host: "127.0.0.1", port, rejectUnauthorized: false });
          s.on("connect", () => { s.destroy(); resolve({ connected: true }); });
          s.on("error", (e) => resolve({ error: String((e && e.message) || e) }));
          setTimeout(() => { try { s.destroy(); } catch {} resolve({ timeout: true }); }, 3000);
        } catch (e) { resolve({ sync: String((e && e.message) || e) }); }
      });
    },
  })`,
  dgramSend: `({
    probe: async (resource) => {
      const fs = require("node:fs");
      const dgram = require("node:dgram");
      const port = Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim());
      return await new Promise((resolve) => {
        try {
          // ⚠️ 自定义 lookup 经**构造选项**传入(new dgram.Socket({ type, lookup }))。
          // 若走默认 lookup,未声明网络时会被 **dns.lookup 那条**拦住 —— 那是偶然
          // (默认 lookup 从 dns 模块取),测不到 dgram 原型自己有没有被替换。
          // 变异验证证实过:只撤 Socket.prototype.send 替换时,默认 lookup 版本仍绿。
          const lookup = (_host, _opts, cb) => cb(null, "127.0.0.1", 4);
          const s = new dgram.Socket({ type: "udp4", lookup });
          s.on("error", (e) => resolve({ error: String((e && e.message) || e) }));
          s.send(Buffer.from("ping"), port, "127.0.0.1", (err) => { try { s.close(); } catch {} resolve(err ? { error: String(err.message) } : { connected: true }); });
          setTimeout(() => { try { s.close(); } catch {} resolve({ timeout: true }); }, 3000);
        } catch (e) { resolve({ sync: String((e && e.message) || e) }); }
      });
    },
  })`,
  dnsPromisesResolver: `({
    probe: async (resource) => {
      const fs = require("node:fs");
      const dns = require("node:dns");
      const port = Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim());
      try {
        const resolver = new dns.promises.Resolver();
        resolver.setServers(["127.0.0.1:" + port]);
        return { resolved: await resolver.resolve4("probe.test") };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    },
  })`,
  // promises 命名空间的**直接**查询函数(不经过 Resolver 实例)—— 守卫从前只替换了
  // dns 模块对象上的函数,这个命名空间整片是敞开的。
  dnsPromisesNamespace: `({
    probe: async (resource) => {
      const fs = require("node:fs");
      const dns = require("node:dns");
      const port = Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim());
      try {
        dns.promises.setServers(["127.0.0.1:" + port]);
        return { resolved: await dns.promises.resolve4("probe.test") };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    },
  })`,
  // 回调式 `new dns.Resolver()` —— 与 promises 那个是**两个不同的类**,原型各一份。
  dnsCallbackResolver: `({
    probe: async (resource) => {
      const fs = require("node:fs");
      const dns = require("node:dns");
      const port = Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim());
      return await new Promise((resolve) => {
        try {
          const resolver = new dns.Resolver();
          resolver.setServers(["127.0.0.1:" + port]);
          resolver.resolve4("probe.test", (err, addrs) => resolve(err ? { error: String(err.message) } : { resolved: addrs }));
          setTimeout(() => resolve({ timeout: true }), 3000);
        } catch (e) { resolve({ sync: String((e && e.message) || e) }); }
      });
    },
  })`,
} as const;


function manifestOf(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 1, id: "user.lifecycle", version: "1.0.0",
    title: { zh: "生命周期", en: "Lifecycle" },
    permissions: ["resource.read"],
    contributions: [{
      id: "convert", slot: "files.context", title: { zh: "转换", en: "Convert" },
      capability: "module.convert",
      view: { title: { zh: "结果", en: "Result" }, fields: [{ key: "text", title: { zh: "文本", en: "Text" } }] },
    }],
    program: { source: READ_SOURCE },
    ...overrides,
  };
}

const temp = await mkdtemp(join(tmpdir(), "mcode-extension-lifecycle-"));
try {
  const root = join(temp, "workspace"), outside = join(temp, "outside");
  await mkdir(root); await mkdir(outside);
  const target = join(root, "note.txt"), secret = join(outside, "secret.txt");
  await writeFile(target, "hello extension\n", "utf8");
  await writeFile(secret, "top secret\n", "utf8");

  /** 生产同款端口:authorize 与 resolveResource 走同一个 resolver;核验走受控进程。 */
  const ports = (opts: { approve?: "allow" | "deny" | "none" } = {}) => ({
    authorize: async (resource: { projectPath: string; path: string }) => { await resolveModuleResource(resource, (p: string) => p === root); },
    resolveResource: async (resource: { projectPath: string; path: string }) => resolveModuleResource(resource, (p: string) => p === root),
    verifyProgram: async (source: string, capabilities: readonly string[], timeoutMs: number | undefined) =>
      verifyPermissionedProgram(source, capabilities, timeoutMs ?? 10_000),
    persist: async (_m: unknown) => {},
    ...(opts.approve === "allow" ? { requestApproval: async () => {} } : {}),
    ...(opts.approve === "deny" ? { requestApproval: async () => { throw Error("用户拒绝"); } } : {}),
  });
  const makeHost = (opts: { approve?: "allow" | "deny" | "none"; persist?: (m: unknown) => Promise<void> } = {}) => {
    const p = ports(opts);
    const host = new ModuleHost({ ...p, persist: opts.persist ?? p.persist });
    for (const capability of fileCapabilities((candidate: string) => candidate === root)) host.register(capability);
    return host;
  };

  // ── 1. 形状层:引用 module.* 却没有 program:拒 ────────────────────────────
  const noProgram = manifestOf(); delete (noProgram as Record<string, unknown>).program;
  check("引用 module.* 能力但缺 program 的清单在形状层被拒",
    !ModuleManifestSchema.safeParse(noProgram).success);
  check("带 program 却不引用 module.* 的清单也被拒(装下永不执行的代码)",
    !ModuleManifestSchema.safeParse(manifestOf({ contributions: [{ ...manifestOf().contributions[0], capability: "core.file.inspect" }] })).success);
  check("多段短名 module.a.b 被拒(避免重装时二次分配)",
    !ModuleManifestSchema.safeParse(manifestOf({ contributions: [{ ...manifestOf().contributions[0], capability: "module.a.b" }] })).success);

  // ── 2. 安装期核验:恶意/不匹配 → 失败且不落盘、不注册 ────────────────────
  const diskSnapshots: string[] = [];
  const recordingPersist = async (manifests: unknown) => { diskSnapshots.push(JSON.stringify(manifests)); };
  const host = makeHost({ persist: recordingPersist });

  await rejects("引用短名不是函数必须安装失败",
    host.install(manifestOf({ program: { source: `({ convert: "not a function" })` } })), /核验失败/);
  eq("核验失败后注册表没有任何模块", host.catalog().modules.length, 0);
  eq("核验失败后一个字节都没有落盘", diskSnapshots.length, 0);
  check("核验失败后能力目录里没有 module.* 能力",
    host.catalog().capabilities.every((c) => !c.id.startsWith("module.")));

  await rejects("工厂在核验期读盘必须被权限模型拒绝并导致安装失败",
    host.install(manifestOf({ program: { source: `(() => { require("node:fs").readFileSync(${JSON.stringify(secret)}, "utf8"); return { convert: async () => ({}) }; })()` } })), /核验失败/);
  eq("恶意工厂失败后仍没有落盘", diskSnapshots.length, 0);

  // 无核验端口 → fail-closed
  const noVerify = new ModuleHost({ authorize: async () => {}, persist: async () => {} });
  await rejects("没有核验通道时安装可执行扩展必须被拒(fail-closed)",
    noVerify.install(manifestOf()), /没有可用的扩展程序核验通道/);

  // ── 3. 安装成功:宿主分配 id、目录可见 ──────────────────────────────────
  await host.install(manifestOf());
  const catalog = host.catalog();
  eq("扩展包安装后模块可见", catalog.modules.length, 1);
  const assigned = catalog.capabilities.find((c) => c.id === "module.lifecycle.convert");
  check("宿主把 module.convert 分配成 module.lifecycle.convert", assigned !== undefined, catalog.capabilities.map((c) => c.id));
  eq("清单里写的 module.convert 本身不成为能力", catalog.capabilities.some((c) => c.id === "module.convert"), false);
  eq("只读扩展注册为 query", assigned?.kind, "query");
  eq("落盘发生了一次", diskSnapshots.length, 1);

  // ── 4. 调用:真的在子进程里执行、只读被选中的文件 ─────────────────────
  const reply = await host.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "read-1" });
  eq("只读能力返回即时结果", reply.type, "result");
  if (reply.type === "result") {
    eq("扩展读到了正确的文件内容", reply.value.text, "hello extension");
  }

  // ── 5. 越界读:OS 权限边界拒绝,宿主存活并拿到 isolated_denied ───────────
  const escapeHost = makeHost({ persist: async () => {} });
  await escapeHost.install(manifestOf({
    contributions: [
      { ...manifestOf().contributions[0], id: "escape", capability: "module.escape" },
      { ...manifestOf().contributions[0], id: "convert", capability: "module.convert" },
    ],
  }));
  try {
    await escapeHost.invoke({ moduleId: "user.lifecycle", contributionId: "escape", resource: { projectPath: root, path: target }, requestId: "escape-1" });
    check("越界读必须失败", false);
  } catch (error) {
    const failure = permissionedFailure(error);
    eq("越界读的失败码是 isolated_denied", failure?.code, "isolated_denied");
  }
  const after = await escapeHost.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "read-2" })
    .catch((error) => ({ type: "threw", error }));
  eq("越界失败之后宿主仍能正常调用", (after as { type?: string }).type, "result");

  // ── 6. 写能力:逐次审批是唯一放行方式 ─────────────────────────────────
  const writeManifest = manifestOf({
    permissions: ["resource.read", "resource.write"],
    contributions: [{ ...manifestOf().contributions[0], id: "redact", capability: "module.redact", title: { zh: "脱敏", en: "Redact" } }],
    program: { source: WRITE_SOURCE },
  });
  const noApproval = makeHost({ approve: "none", persist: async () => {} });
  await noApproval.install(writeManifest);
  eq("声明了 resource.write 的扩展注册为 action",
    noApproval.catalog().capabilities.find((c) => c.id === "module.lifecycle.redact")?.kind, "action");
  await rejects("没有审批通道时写动作必须被拒(fail-closed)",
    noApproval.invoke({ moduleId: "user.lifecycle", contributionId: "redact", resource: { projectPath: root, path: target }, requestId: "w-1" }), /审批通道/);
  eq("被拒后文件没有变化", (await readFile(target, "utf8")), "hello extension\n");

  const denied = makeHost({ approve: "deny", persist: async () => {} });
  await denied.install(writeManifest);
  await rejects("用户拒绝时写动作必须被拒",
    denied.invoke({ moduleId: "user.lifecycle", contributionId: "redact", resource: { projectPath: root, path: target }, requestId: "w-2" }), /拒绝/);
  eq("用户拒绝后文件仍没有变化", (await readFile(target, "utf8")), "hello extension\n");

  const allowed = makeHost({ approve: "allow", persist: async () => {} });
  await allowed.install(writeManifest);
  const wrote = await allowed.invoke({ moduleId: "user.lifecycle", contributionId: "redact", resource: { projectPath: root, path: target }, requestId: "w-3" })
    .catch((error) => ({ type: "threw", message: error instanceof Error ? error.message : String(error) } as const));
  eq("批准后写动作执行成功", wrote.type, "result");
  eq("写动作真的落在了被选中的文件", (await readFile(target, "utf8")), "[redacted]\n");
  eq("被选中文件之外的文件不受影响", (await readFile(secret, "utf8")), "top secret\n");

  // 越界写:权限参数只放行那一个文件 → 扩展进程内写别处被 OS 拒。
  // 直接验 runner:宿主那层的审批/授权已在上面的 action 用例里覆盖。
  const escapeWrite = await runPermissionedProcess({
    source: WRITE_SOURCE, capability: "escapeWrite", allowWrite: true, timeoutMs: 10_000,
    resource: { projectPath: root, path: target },
    signal: new AbortController().signal,
  }).then(() => null, (error) => permissionedFailure(error));
  eq("越界写被 OS 权限模型拒绝", escapeWrite?.code, "isolated_denied");

  // ── 6d.【MC-035】网络:未声明 = 不能出站;声明了才放行 ────────────────────
  // 台账第十七轮的 E1 反例:只约束 fs 的子进程仍能读已授权文件后 HTTP POST 外传。
  // 这里起一个本机探针服务,直接用 runPermissionedProcess 驱动真实执行体。
  {
    const { createServer } = await import("node:http");
    let received = 0;
    const probe = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { received++; res.writeHead(200); res.end("ok:" + body.length); });
    });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    process.env.PROBE_PORT = String(port);
    try {
      // ① 未声明网络(默认 false)→ 引导脚本的网络拦截必须让它抛错。
      const sourceFor = (p: number): string => NETWORK_SOURCE.replace("Number(fs.readFileSync(resource.path + \".probe-port\", \"utf8\").trim())", String(p));
      const denied = await runPermissionedProcess({
        source: sourceFor(port), capability: "exfiltrate", allowWrite: false, timeoutMs: 10_000,
        resource: { projectPath: root, path: target },
        signal: new AbortController().signal,
      }).then(
        (value) => ({ type: "result", value }),
        (error) => ({ type: "error", failure: permissionedFailure(error), message: error instanceof Error ? error.message : String(error) }),
      );
      eq("★ 未声明网络的扩展读已授权文件后外传被阻断", received, 0);
      // 夹具在扩展侧 catch 了错误并回 `{error}` —— 这是扩展自己选的降级方式,
      // 拦截仍然生效。断言判的是"错误里点明了原因",不是"宿主必须抛错"。
      check("★ 阻断是可诊断的(network_access_denied 进了扩展看到的错误)",
        JSON.stringify(denied).includes("network_access_denied"), { denied, received });

      // ② 显式 allowNetwork=true → 放行(证明拦截不是"一律禁网"的假阳性)。
      const allowed = await runPermissionedProcess({
        source: sourceFor(port), capability: "exfiltrate", allowWrite: false, allowNetwork: true, timeoutMs: 10_000,
        resource: { projectPath: root, path: target },
        signal: new AbortController().signal,
      }).then(
        (value) => ({ type: "result", value }),
        (error) => ({ type: "error", error: permissionedFailure(error) }),
      );
      eq("★ 显式 allowNetwork=true 时同一执行体成功出站(拦截不是一刀切)", received, 1);
      check("显式放行时返回了结果", allowed.type === "result", allowed);
    } finally {
      probe.close();
      delete process.env.PROBE_PORT;
    }
  }
  // ── 6f.【MC-035 原型绕过】对抗性验证确认的五条纯 JS 绕行路径 ─────────────
  // 上面的 6d 只覆盖 `http.request`(模块对象上的导出函数)。下面每条都**不碰**那个
  // 入口:原型方法 / 未覆盖的模块(tls)/ globalAgent 的直接套接字 / dgram 原型 /
  // dns.promises.Resolver 原型。每条跑两遍:
  //   - 未声明网络 → 该路径必须失败,且错误里点名 `network_access_denied`;
  //   - allowNetwork=true → 同一路径必须成功(正控,证明不是一刀切)。
  // 本机真实服务端:netserver/tlsserver/udp/dns 都由宿主进程起;扩展进程只拿到端口。
  {
    const { createServer: createTcpServer } = await import("node:net");
    const { createServer: createTlsServer } = await import("node:tls");
    const { createSocket: createUdpSocket } = await import("node:dgram");
    // 证书只用于本机回环握手,`rejectUnauthorized: false` —— 与安全无关,是测试夹具。
    const tlsKey = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCtW3zh0CtZuKRh",
      "XVzOCYyjrVSkrhMcLfIsfM2i2YthPFLg0Y17jieKWWUTjEfMMoTjpRabfJjEpqAn",
      "rU8PhoZo8N0hvtzrgnVBPtPrHGIGtKU0Bb+m7KDBa4vmFOZ8VRhcrVY7p/Lf/1VG",
      "2uN5LzQAbFdU6yicj3Mb2zv4nFo0umaOQhm7WhoQDXlgmJjJbRmQFfR1IgqD7X+I",
      "UZXw9DsqpmKc/t4o5Mf85qAsmRm6MdFfculH/oVG2yYXAefT0VeGDe/4OpcBqfV9",
      "E9CREeZ2eAtDh5MkxQSPI+33JfbhuED1oYuMZjCYKOHAE0pPz+zdqJEVA2jCdqcT",
      "HQ4qDe1HAgMBAAECggEAEe+kohskVmobh9SzD2uULjMheNBnOxkoifXNCOEH4g2Y",
      "aEOw0cHJfC+iR5LSCDc0jKETZQ76d2OOBSI8oIHt/NmUPN4/LpbBhE34exuQANrx",
      "OiAGI5fZTL8l1a5VPTPzYKixLVxDwsKWPiMo5JbqWHOH2EoPBPPKmG08bTfawBha",
      "gDSpQVg8mZUdTCp0BIjCvX417sKlTvIzPBsm+OjcTbRQtSwfdG3CcU7U8627bg5Z",
      "qzBu7etGdsJZaLGuj9XUEa2csl2TmOCWofPb9jihFNADijZNwoSfPNW43nb7pmGn",
      "ZXEUdjdB8yG2uld1tCS9Q98FVMpKMGEi4LUzte4o0QKBgQDuZRWAIIQ4cNrC2Bq2",
      "ucmOmlm3Ywrc5LnfrT0KxwIwj7z9DsmU387sJBlMBwCbyqB4WY4L6LZWEPTmSkJm",
      "Grcm4b86KJuFUN60d/LEnzwLjVYAmsoAz9wMdofv7XOlvcGGKCW7eAx84g/hxjqd",
      "3yrz7CenQXWAviRL5c3+edQdewKBgQC6KNp98XaXYN0g2gAUFg2IwrSvJyksAFMU",
      "YSTjZ/g82PTiNvbRGuDk6wB9Goup9ybw6e094mH4AybnUH6yq8XZrKAepKv1FK9i",
      "czPNHkmpX3BoDhRILRo8Ob8j6Tu9F3sUcMqMBbZYVLqrZ21/7hKvEp2v6xO4pcj1",
      "S9yZbIy3pQKBgQDSf5c4h324iI3htggAiJQcwtWtRFr3KU+m3cUkmwyn7IOnv0Ln",
      "naeMg2OC6jvzVDvViN4QTe+Sl25nWfK/TZ+jSXoc1HZehUXgfHl0fFX8rVPfPM5Z",
      "YTCgIJlvlW+kTaVv3EtU+W+tZb84UFy5wbCfqUpqOTaT81EBY2084j4VuQKBgQC2",
      "rsqjVyayrPqzd1smWvHTKIdZbwunQ3ZEBITHqMrhI2NE7v1M/Jx/6OHk4vz1wTV0",
      "q4sF9LeBQ86Upth+i7SvxQioqZ6Z9j+aVEUcYEGXNbJAWriqj6A0Q9L/8ayPBpDg",
      "4ULTH/PuQM+izu+U4FNzfMhDz2PeCsrndRe5c92vhQKBgBwKWN0jJ8oVk2scz1Fc",
      "Bp6a+k1DQX4b9brA+PyyexkzUaNub6g4J1nsTuNYaqETCjIdDv3vWzfklR/XGQvj",
      "F4Apiw4RsjmoKKD/A3rZSHxvb1SnpJuQIxGFhwRpKlRyKI7MGaaS2MwcDoG/3wtb",
      "b7hw+ACa8tPmYtjiJ3iii5Mv",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const tlsCert = [
      "-----BEGIN CERTIFICATE-----",
      "MIIDGjCCAgKgAwIBAgIUJl/z/BzNfuImDtcyyd+me97c8YkwDQYJKoZIhvcNAQEL",
      "BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAxODEzMzYwMVoXDTM2MTAx",
      "NTEzMzYwMVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF",
      "AAOCAQ8AMIIBCgKCAQEArVt84dArWbikYV1czgmMo61UpK4THC3yLHzNotmLYTxS",
      "4NGNe44nilllE4xHzDKE46UWm3yYxKagJ61PD4aGaPDdIb7c64J1QT7T6xxiBrSl",
      "NAW/puygwWuL5hTmfFUYXK1WO6fy3/9VRtrjeS80AGxXVOsonI9zG9s7+JxaNLpm",
      "jkIZu1oaEA15YJiYyW0ZkBX0dSIKg+1/iFGV8PQ7KqZinP7eKOTH/OagLJkZujHR",
      "X3LpR/6FRtsmFwHn09FXhg3v+DqXAan1fRPQkRHmdngLQ4eTJMUEjyPt9yX24bhA",
      "9aGLjGYwmCjhwBNKT8/s3aiRFQNownanEx0OKg3tRwIDAQABo2QwYjAdBgNVHQ4E",
      "FgQUHkOdin1XVwPFIvUAM66UzXIfRs4wHwYDVR0jBBgwFoAUHkOdin1XVwPFIvUA",
      "M66UzXIfRs4wDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG",
      "SIb3DQEBCwUAA4IBAQA0LmkpggYtL/wnYrKqZbmL9cSGTvD2eN5zAISrVURViOjp",
      "syNEQT3Edze8GInkaxz80JOwxjwE2MKmj7bzYG3V9QbOZVnmy48mtp0PpTFC4P1i",
      "+iiap4wv0VwhNMwYYPjtEOWGUuL8IOAbo695fQKgEaawEfB2Nd1luXOiFqHmqc7O",
      "+82TmECcGD5eel+pTx+7jodhMPWOgwRwRaSigeL1hmcr2PEkncivp8CTi8udab2F",
      "/rKJq+MrS/Y7StzqHjNFXCLr0XeFHhc2dNkFJlbo4WylTk2yLkESwobeW+K+HQQq",
      "p2inlnZ4ckM0sVPxewi2TyeRA3TGJ1dGU9PmM1TK",
      "-----END CERTIFICATE-----",
    ].join("\n");

    const tcpServer = createTcpServer((socket) => { socket.on("error", () => {}); socket.end("ok"); });
    await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", () => resolve()));
    const tcpAddress = tcpServer.address();
    const tcpPort = typeof tcpAddress === "object" && tcpAddress !== null ? tcpAddress.port : 0;

    const tlsServer = createTlsServer({ key: tlsKey, cert: tlsCert }, (socket) => { socket.on("error", () => {}); socket.end("ok"); });
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", () => resolve()));
    const tlsAddress = tlsServer.address();
    const tlsPort = typeof tlsAddress === "object" && tlsAddress !== null ? tlsAddress.port : 0;

    let udpReceived = 0;
    const udpServer = createUdpSocket("udp4");
    udpServer.on("message", () => { udpReceived++; });
    await new Promise<void>((resolve) => udpServer.bind(0, "127.0.0.1", () => resolve()));
    const udpAddress = udpServer.address();
    const udpPort = typeof udpAddress === "object" && udpAddress !== null ? udpAddress.port : 0;

    // 最小 DNS 服务器:只回答 A 记录 127.0.0.1。Resolver 直接与它对话 → 路径真实成立。
    const dnsServer = createUdpSocket("udp4");
    dnsServer.on("message", (message: Buffer, remote: { port: number; address: string }) => {
      let end = 12;
      while (message[end] !== 0) end += message[end]! + 1;
      const question = message.subarray(12, end + 5);
      const header = Buffer.alloc(12);
      message.copy(header, 0, 0, 2);
      header.writeUInt16BE(0x8180, 2); // 响应 + 一个 A 回答
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(1, 6);
      const answer = Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04, 127, 0, 0, 1]);
      dnsServer.send(Buffer.concat([header, question, answer]), remote.port, remote.address);
    });
    await new Promise<void>((resolve) => dnsServer.bind(0, "127.0.0.1", () => resolve()));
    const dnsAddress = dnsServer.address();
    const dnsPort = typeof dnsAddress === "object" && dnsAddress !== null ? dnsAddress.port : 0;

    /** 每条路径:端口内联进源码(执行体只被放行 target 一个文件,读不了旁路探针),
     *  同一源码分别以 allowNetwork=false/true 执行。 */
    const runBypass = async (key: keyof typeof BYPASS_SOURCES, port: number, allowNetwork: boolean): Promise<string> => {
      const source = BYPASS_SOURCES[key].replace(
        'Number(fs.readFileSync(resource.path + ".probe-port", "utf8").trim())',
        String(port),
      );
      const reply = await runPermissionedProcess({
        source, capability: "probe", allowWrite: false, allowNetwork,
        timeoutMs: 10_000,
        resource: { projectPath: root, path: target },
        signal: new AbortController().signal,
      });
      return JSON.stringify(reply);
    };
    /** 先断"没有成功证据",再断"错误里点名了守卫";两项都过才算拦住了。 */
    const assertBypassBlocked = (name: string, outcome: string): void => {
      check("★ " + name + "未声明网络时出站失败", !outcome.includes('"connected":true') && !outcome.includes('"resolved":['), { outcome });
      check("★ " + name + "的失败点名 network_access_denied", outcome.includes("network_access_denied"), { outcome });
    };
    const assertBypassAllowed = (name: string, outcome: string): void => {
      check("★ allowNetwork=true 时" + name + "成功(守卫不是一刀切)",
        outcome.includes('"connected":true') || outcome.includes('"resolved":["127.0.0.1"]'), { outcome });
    };

    try {
      const netDenied = await runBypass("netProto", tcpPort, false);
      assertBypassBlocked("new net.Socket().connect 原型路径", netDenied);
      assertBypassAllowed("new net.Socket().connect 原型路径", await runBypass("netProto", tcpPort, true));

      const tlsDenied = await runBypass("tlsConnect", tlsPort, false);
      assertBypassBlocked("tls.connect 路径", tlsDenied);
      assertBypassAllowed("tls.connect 路径", await runBypass("tlsConnect", tlsPort, true));

      const agentDenied = await runBypass("httpsAgentConn", tlsPort, false);
      assertBypassBlocked("https.globalAgent.createConnection 路径", agentDenied);
      assertBypassAllowed("https.globalAgent.createConnection 路径", await runBypass("httpsAgentConn", tlsPort, true));

      const udpBefore = udpReceived;
      const dgramDenied = await runBypass("dgramSend", udpPort, false);
      assertBypassBlocked("new dgram.Socket().send 路径", dgramDenied);
      eq("★ 未声明网络的 UDP send 包没有到达服务端", udpReceived, udpBefore);
      const dgramAllowed = await runBypass("dgramSend", udpPort, true);
      assertBypassAllowed("new dgram.Socket().send 路径", dgramAllowed);
      eq("★ allowNetwork=true 时 UDP 包真的到达了服务端", udpReceived, udpBefore + 1);

      const dnsDenied = await runBypass("dnsPromisesResolver", dnsPort, false);
      assertBypassBlocked("dns.promises.Resolver 路径", dnsDenied);
      assertBypassAllowed("dns.promises.Resolver 路径", await runBypass("dnsPromisesResolver", dnsPort, true));

      const dnsNsDenied = await runBypass("dnsPromisesNamespace", dnsPort, false);
      assertBypassBlocked("dns.promises 命名空间直调路径", dnsNsDenied);
      assertBypassAllowed("dns.promises 命名空间直调路径", await runBypass("dnsPromisesNamespace", dnsPort, true));

      const dnsCbDenied = await runBypass("dnsCallbackResolver", dnsPort, false);
      assertBypassBlocked("new dns.Resolver() 回调路径", dnsCbDenied);
      assertBypassAllowed("new dns.Resolver() 回调路径", await runBypass("dnsCallbackResolver", dnsPort, true));
    } finally {
      tcpServer.close();
      tlsServer.close();
      udpServer.close();
      dnsServer.close();
    }
  }
  eq("越界写没有改到界外文件", (await readFile(secret, "utf8")), "top secret\n");

  // ── 6b. 真实路径:工作区里的链接指向界外时,扩展进程的放行名单必须是**解析后**的路径。
  // 字面路径放行会让 OS 权限模型把链接目标一并放行(实测:允读 link → 目标可读)。
  // 生产 authorize 与 resolveResource 共用 `resolveModuleResource`;这里用一个"只判根、
  // 不解析"的 authorize 作对照,单独钉住 resolveResource 这一道 —— 撤掉它(退回字面路径)
  // 时,越界链接会被执行并读出界外内容。
  const { symlink } = await import("node:fs/promises");
  // Windows 上普通符号链接需要开发者模式;junction(仅目录)不需要 —— 与 module-platform-smoke
  // 的逃逸夹具同一做法。
  const escapeDir = join(root, "escape-dir");
  await symlink(outside, escapeDir, process.platform === "win32" ? "junction" : "dir").catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
  });
  if (existsSync(escapeDir)) {
    const linkHost = new ModuleHost({
      // 对照:authorize 只判"根是已知工作区",**不解析**链接 —— 隔离完全落在
      // resolveResource 给权限参数的那一步真实路径上。
      authorize: async (resource) => { if (resource.projectPath !== root) throw Error("未知工作区"); },
      resolveResource: async (resource) => resolveModuleResource(resource, (p: string) => p === root),
      verifyProgram: async (source: string, capabilities: readonly string[], timeoutMs: number | undefined) =>
        verifyPermissionedProgram(source, capabilities, timeoutMs ?? 10_000),
      persist: async () => {},
    });
    for (const capability of fileCapabilities((candidate: string) => candidate === root)) linkHost.register(capability);
    await linkHost.install(manifestOf());
    try {
      const reply = await linkHost.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: join(escapeDir, "secret.txt") }, requestId: "link-1" });
      const text = reply.type === "result" ? String(reply.value.text) : "";
      check("工作区内指向界外的链接不能被扩展读到", !text.includes("top secret"), { text });
    } catch (error) {
      check("工作区内指向界外的链接在执行前被资源解析拒绝",
        /资源在工作区之外|需要一个普通文件/.test(String((error as Error).message)), { message: (error as Error).message });
    }
  } else {
    console.log("  skip 链接夹具(当前环境不允许创建链接)");
  }

  // ── 6e.【MC-035】网络是**逐次**批准:声明 network 的 query 能力每次执行都要过审批 ──
  // 安装时声明只回答"有没有资格联网";装上之后每次调用都出网,用户再没有"这一次
  // 要不要"的选择。action 已被逐次审批覆盖,这里验的是 query/只读能力。
  {
    const netManifest = manifestOf({ permissions: ["resource.read", "network"] });
    // 无审批通道 → fail-closed(绝不默认放行联网)。
    const noGate = makeHost({ approve: "none", persist: async () => {} });
    await noGate.install(netManifest);
    await rejects("★ 声明 network 的只读能力在无审批通道时被拒(fail-closed)",
      noGate.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "net-1" }),
      /审批通道/);
    eq("★ 被拒后扩展没有执行(返回值不是 result)",
      (await noGate.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "net-2" }).then(() => "ran", () => "denied")),
      "denied");
    // 用户拒绝 → 拒。
    const deniedGate = makeHost({ approve: "deny", persist: async () => {} });
    await deniedGate.install(netManifest);
    await rejects("★ 声明 network 的能力在用户拒绝时被拒",
      deniedGate.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "net-3" }),
      /拒绝/);
    // 用户批准 → 执行,且审批请求带 scope:"network"(审批卡知道自己在批什么)。
    const seen: string[] = [];
    const allowedGate = new ModuleHost({
      authorize: async (r) => { await resolveModuleResource(r, (p: string) => p === root); },
      resolveResource: async (r) => resolveModuleResource(r, (p: string) => p === root),
      verifyProgram: async (source, capabilities, timeoutMs) => verifyPermissionedProgram(source, capabilities, timeoutMs ?? 10_000),
      requestApproval: async (req) => { seen.push(String(req.scope ?? "write")); },
      persist: async () => {},
    });
    for (const capability of fileCapabilities((candidate: string) => candidate === root)) allowedGate.register(capability);
    await allowedGate.install(netManifest);
    const ran = await allowedGate.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "net-4" })
      .then((v) => v.type, () => "denied");
    eq("★ 批准后只读能力正常执行", ran, "result");
    check("★ 审批请求标了 scope=network(审批卡知道在批联网)",
      seen.length === 1 && seen[0] === "network", seen);
    // 对照:没有 network 权限的同一能力**不**触发审批(不能变成"每次调用都弹卡")。
    const plainSeen: string[] = [];
    const plainHost = new ModuleHost({
      authorize: async (r) => { await resolveModuleResource(r, (p: string) => p === root); },
      resolveResource: async (r) => resolveModuleResource(r, (p: string) => p === root),
      verifyProgram: async (source, capabilities, timeoutMs) => verifyPermissionedProgram(source, capabilities, timeoutMs ?? 10_000),
      requestApproval: async (req) => { plainSeen.push(String(req.scope ?? "write")); },
      persist: async () => {},
    });
    for (const capability of fileCapabilities((candidate: string) => candidate === root)) plainHost.register(capability);
    await plainHost.install(manifestOf());
    await plainHost.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "net-5" });
    eq("★ 没有 network 权限的只读能力不弹审批(不误伤普通读)", plainSeen.length, 0);
  }

  // ── 7. 卸载:能力撤销、再调用失败、磁盘清单移除 ───────────────────────
  await allowed.remove("user.lifecycle");
  eq("卸载后模块从目录消失", allowed.catalog().modules.length, 0);
  eq("卸载后分配的能力同时撤销", allowed.catalog().capabilities.some((c) => c.id.startsWith("module.lifecycle.")), false);
  await rejects("卸载后再调用必须失败",
    allowed.invoke({ moduleId: "user.lifecycle", contributionId: "redact", resource: { projectPath: root, path: target }, requestId: "w-5" }), /模块或贡献不可用/);

  // ── 7b. 覆盖安装:同 id 新源码必须真正替换执行体(不得沿用旧的) ─────────
  const upgradeHost = makeHost({ persist: async () => {} });
  await upgradeHost.install(manifestOf());
  await writeFile(target, "hello extension\n", "utf8");
  const v1 = await upgradeHost.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "up-1" });
  eq("覆盖前执行的是第一版程序", (v1 as { type: string; value?: { text?: string } }).value?.text, "hello extension");
  await upgradeHost.install(manifestOf({
    version: "2.0.0",
    program: { source: `({ convert: async (resource) => ({ text: "v2:" + resource.path.split(String.fromCharCode(92)).pop() }) })` },
  }));
  const v2 = await upgradeHost.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "up-2" });
  eq("覆盖安装后执行的是新版本程序(不沿用旧执行体)", (v2 as { type: string; value?: { text?: string } }).value?.text, "v2:note.txt");

  // ── 7c.【MC-035 更新切片】失败升级必须保留旧执行体与磁盘清单 ─────────────
  // 真实触发路径:清单 schema 合法(`module.<短名>` 单段,短名 ≤93 字符),但宿主分配后的
  // id(`module.<slug>.<短名>`)超过 100 字符的 `Id` 上限 —— 旧实现「先落盘 → 撤旧能力 →
  // 边绑边校验」会在这一步抛错,留下「旧执行体已撤、盘上已是新清单、新能力注册了一半」
  // 的状态。新实现要求所有新能力先准备成功,磁盘与旧执行体才动。
  const longShort = "x".repeat(84); // module.lifecycle.<84 字符> = 101 字符 > Id 上限 100
  const longSource = `({ convert: async () => ({ text: "v2-should-not-run" }), ${longShort}: async () => ({}) })`;
  const badUpgrade = manifestOf({
    version: "2.0.0",
    contributions: [
      manifestOf().contributions[0],
      { ...manifestOf().contributions[0], id: "long", capability: "module." + longShort },
    ],
    program: { source: longSource },
  });
  check("过长分配 id 的清单在形状层仍然合法(缺陷只在宿主绑定阶段暴露)",
    ModuleManifestSchema.safeParse(badUpgrade).success);
  const rollbackHost = makeHost({ persist: recordingPersist });
  await rollbackHost.install(manifestOf());
  const snapshotCountBefore = diskSnapshots.length;
  const persistedBefore = diskSnapshots[diskSnapshots.length - 1];
  let upgradeError: Error | null = null;
  try { await rollbackHost.install(badUpgrade); upgradeError = null; }
  catch (error) { upgradeError = error instanceof Error ? error : new Error(String(error)); }
  check("★ 绑定阶段会失败的升级被拒绝(不是假成功)", upgradeError !== null, { upgradeError: upgradeError?.message });
  eq("★ 升级失败后磁盘清单仍是旧版本(一个字节没写)", diskSnapshots.length, snapshotCountBefore);
  eq("★ 升级失败后落盘的仍是 v1 清单", diskSnapshots[diskSnapshots.length - 1], persistedBefore);
  check("★ 升级失败后旧执行体仍在注册表里(没有被先撤掉)",
    rollbackHost.catalog().capabilities.some((c) => c.id === "module.lifecycle.convert"),
    rollbackHost.catalog().capabilities.map((c) => c.id));
  eq("升级失败后目录仍显示旧版本", rollbackHost.catalog().modules.find((m) => m.id === "user.lifecycle")?.version, "1.0.0");
  const afterFailedUpgrade = await rollbackHost.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "rb-1" })
    .catch((error) => ({ type: "threw", message: error instanceof Error ? error.message : String(error) } as const));
  eq("★ 升级失败后旧执行体仍可调用", (afterFailedUpgrade as { type?: string }).type, "result");
  eq("★ 旧执行体返回的仍是 v1 程序的结果",
    (afterFailedUpgrade as { value?: { text?: string } }).value?.text, "hello extension");
  check("升级失败后没留下半绑定的长 id 能力",
    rollbackHost.catalog().capabilities.every((c) => !c.id.includes(longShort)));

  // 重启视角:盘上还是 v1,restore 后能力复活。
  const afterFailedUpgradeRestart = makeHost({ persist: async () => {} });
  for (const manifest of JSON.parse(diskSnapshots[diskSnapshots.length - 1]!) as unknown[]) afterFailedUpgradeRestart.restore(manifest);
  eq("升级失败后重启恢复的仍是 v1", afterFailedUpgradeRestart.catalog().modules[0]?.version, "1.0.0");

  // 启动失败:restore 一份准备阶段会失败的清单,注册表不得留下半绑定能力。
  // (旧实现边绑定边 register,第二条失败时第一条会以 `module.*` 残留在能力目录里,
  //  而模块本身并未恢复 —— 一个不可见、不可卸载的执行能力。)
  const leakHost = makeHost({ persist: async () => {} });
  const restoreError = (() => { try { leakHost.restore(badUpgrade); return null; } catch (error) { return error instanceof Error ? error : new Error(String(error)); } })();
  check("★ 启动恢复一条绑定会失败的清单时显式抛错", restoreError !== null);
  eq("★ 启动恢复失败后没有模块被恢复", leakHost.catalog().modules.length, 0);
  eq("★ 启动恢复失败后能力目录里没有半绑定的 module.*",
    leakHost.catalog().capabilities.filter((c) => c.id.startsWith("module.")).length, 0);

  // 跨来源 id 冲突:同一分配 id 已被宿主注册的**非扩展能力**占用时,安装必须在落盘前
  // 被拒 —— 否则覆盖安装会静默抢走那个实现。先装一个占位能力模拟"宿主已注册"。
  const collisionHost = new ModuleHost({
    authorize: async (resource: { projectPath: string; path: string }) => { await resolveModuleResource(resource, (p: string) => p === root); },
    resolveResource: async (resource: { projectPath: string; path: string }) => resolveModuleResource(resource, (p: string) => p === root),
    verifyProgram: async (source: string, capabilities: readonly string[], timeoutMs: number | undefined) =>
      verifyPermissionedProgram(source, capabilities, timeoutMs ?? 10_000),
    persist: async () => {},
  });
  for (const capability of fileCapabilities((candidate: string) => candidate === root)) collisionHost.register(capability);
  collisionHost.register({
    id: "module.lifecycle.convert", kind: "query",
    input: ResourceSchema, output: ResultSchema, run: async () => ({ text: "host-owned" }),
  });
  let collisionError: Error | null = null;
  try { await collisionHost.install(manifestOf()); }
  catch (error) { collisionError = error instanceof Error ? error : new Error(String(error)); }
  check("★ 分配 id 已被宿主注册的非扩展能力占用时安装被拒",
    collisionError !== null && /Duplicate capability/.test(collisionError.message), { message: collisionError?.message });
  eq("冲突被拒后模块没有装进来", collisionHost.catalog().modules.length, 0);
  const keptPlaceholder = collisionHost.catalog().capabilities.find((c) => c.id === "module.lifecycle.convert");
  check("冲突被拒后宿主自己的那个能力仍留在注册表里(没有被覆盖)",
    keptPlaceholder !== undefined && keptPlaceholder.kind === "query", keptPlaceholder);
  let collisionRetry: Error | null = null;
  try { await collisionHost.install(manifestOf()); }
  catch (error) { collisionRetry = error instanceof Error ? error : new Error(String(error)); }
  check("冲突仍存在时重试安装仍被拒(不会第二次静默覆盖)", collisionRetry !== null);

  // ── 8. 重启:持久化清单恢复后能力复活(restore 会重新绑定) ─────────────
  const persisted = JSON.parse(diskSnapshots[0]) as unknown[];
  eq("持久化里只有用户模块", persisted.length, 1);
  const restarted = makeHost({ persist: async () => {} });
  for (const manifest of persisted) restarted.restore(manifest);
  eq("重启后模块恢复", restarted.catalog().modules.length, 1);
  check("重启后宿主重新分配了能力", restarted.catalog().capabilities.some((c) => c.id === "module.lifecycle.convert"));
  await writeFile(target, "hello extension\n", "utf8");
  const afterRestart = await restarted.invoke({ moduleId: "user.lifecycle", contributionId: "convert", resource: { projectPath: root, path: target }, requestId: "read-3" });
  eq("重启后扩展仍可调用", afterRestart.type, "result");

  // 过期/伪造的持久化清单(引用不存在的短名)在 restore 处失败,被调用方显式跳过。
  check("引用缺失短名的持久化清单 restore 会抛(由调用方显式记录并跳过)",
    (() => { try { restarted.restore(manifestOf({ program: { source: `({ other: async () => ({}) })` } })); return false; } catch { return true; } })());

  // ── 9. UI 与 Agent 同一判据:IPC 契约要求可执行扩展的独立同意 ──────────
  const ipcManifest = manifestOf();
  check("IPC 安装可执行扩展缺 confirmExecutableCode 被拒",
    !IpcInstallSchema.safeParse({ manifest: ipcManifest, confirmReadAccess: true }).success);
  check("IPC 安装可执行扩展带两次同意通过",
    IpcInstallSchema.safeParse({ manifest: ipcManifest, confirmReadAccess: true, confirmExecutableCode: true }).success);
  check("纯声明式模块不需要可执行同意",
    IpcInstallSchema.safeParse({
      manifest: { ...manifestOf(), contributions: [{ ...manifestOf().contributions[0], capability: "core.file.inspect" }], program: undefined },
      confirmReadAccess: true,
    }).success);
  check("带 program 的清单经 IPC schema 与宿主安装入口给出一致判据",
    IpcInstallSchema.safeParse({ manifest: ipcManifest, confirmReadAccess: true, confirmExecutableCode: true }).success
      && ModuleManifestSchema.safeParse(ipcManifest).success);

  // ── 9b. 同一注册表喂给能力预检:扩展能力从宿主目录现算,卸载即消失 ─────
  const preflightHost = makeHost({ persist: async () => {} });
  await preflightHost.install(manifestOf());
  const declarations = hostCapabilityDeclarationsFromCatalog(preflightHost.catalog());
  check("预检声明里出现宿主分配的扩展能力",
    declarations.some((d) => d.id === "module.lifecycle.convert"), declarations.map((d) => d.id));
  eq("扩展能力在预检里按 query 归类", declarations.find((d) => d.id === "module.lifecycle.convert")?.moduleKind, "query");
  const preflightInventory = collectCapabilityInventory({ hostCapabilities: [...declarations] });
  check("能力清单里能按 capabilityId 查到扩展能力",
    preflightInventory.some((d) => d.id === "module.lifecycle.convert"));
  check("清单里没有清单原文的 module.convert(只认宿主分配 id)",
    !preflightInventory.some((d) => d.id === "module.convert"));
  await preflightHost.remove("user.lifecycle");
  eq("卸载后预检声明不再包含该扩展能力",
    hostCapabilityDeclarationsFromCatalog(preflightHost.catalog()).some((d) => d.id === "module.lifecycle.convert"), false);

  // ── 9c.【MC-035】调用侧身份:扩展能力被授予工作流后,宿主发布的目录必须满足
  // 冻结的 ModuleCatalogSchema,且「使用它的扩展」能按同一映射认出贡献。
  // 从前契约 schema 拿清单原文(module.convert)比宿主分配 id(module.lifecycle.convert),
  // 于是**任意**被授权的扩展都会让整份目录被判非法;目录面板同样拿原文比,扩展能力
  // 永远显示"没有扩展使用"。
  const identityHost = makeHost({ persist: async () => {} });
  let savedGrants: string | null = null;
  const grantHost = new ModuleHost({
    ...ports({}),
    readWorkflowGrants: () => savedGrants,
    persistWorkflowGrants: async (text: string) => { savedGrants = text; },
  });
  for (const capability of fileCapabilities((candidate: string) => candidate === root)) grantHost.register(capability);
  await grantHost.install(manifestOf());
  const grantCandidate = grantHost.catalog().workflowGrantCandidates?.find((c) => c.moduleId === "user.lifecycle" && c.contributionId === "convert");
  eq("扩展的只读贡献成为可授权候选,能力身份是宿主分配 id",
    grantCandidate?.capabilityId, "module.lifecycle.convert");
  await grantHost.issueWorkflowGrant({
    moduleId: "user.lifecycle", moduleVersion: "1.0.0", contributionId: "convert",
    capabilityId: "module.lifecycle.convert", projectPath: root,
  });
  const grantedCatalog = grantHost.catalog();
  check("★ 被授权扩展发布的工作流目标用的是宿主分配 id(不是清单原文)",
    grantedCatalog.workflowTargets?.some((t) => t.moduleId === "user.lifecycle" && t.contributionId === "convert"
      && t.capabilityId === "module.lifecycle.convert") === true,
    grantedCatalog.workflowTargets);
  const catalogParse = ModuleCatalogSchema.safeParse(grantedCatalog);
  check("★ 宿主发布含扩展目标的目录仍满足冻结的 ModuleCatalogSchema(不被自己的契约判非法)",
    catalogParse.success, catalogParse.success ? undefined : catalogParse.error.issues);
  // 用户模块包一层**内置**能力的贡献仍按原文成立(内置侧原文就是实际 id):
  // 同一函数两类身份都有同一真相,不是只给扩展开了个特例。
  await grantHost.install({ ...manifestOf({ id: "user.wrapped" }), contributions: [{ ...manifestOf().contributions[0], capability: "core.file.inspect" }], program: undefined });
  const mixedParse = ModuleCatalogSchema.safeParse(grantHost.catalog());
  check("★ 同时装着扩展能力与内置能力引用的目录仍通过同一 schema",
    mixedParse.success, mixedParse.success ? undefined : mixedParse.error.issues);
  eq("内置能力引用仍是原文,不被二次分配",
    grantHost.catalog().modules.find((m) => m.id === "user.wrapped")?.contributions[0]?.capability, "core.file.inspect");
  // 反例(防空过):目标若指向原文,同一 schema 必须拒绝 —— 证明上面的绿是映射在起作用,
  // 不是 schema 对目标一律放行。
  check("★ 对照:目标写成清单原文 module.convert 时 schema 明确拒绝",
    !ModuleCatalogSchema.safeParse({
      ...grantedCatalog,
      workflowTargets: [{ moduleId: "user.lifecycle", contributionId: "convert", capabilityId: "module.convert" }],
    }).success);
  eq("identityHost 未参与本段(守卫:各 host 状态独立)", identityHost.catalog().modules.length, 0);

  // ── 9d.【ARC-006 Gate E】升级不继承旧授权,且升级失败不留半旧半新 ──────────
  // 判据(台账 MERGE-4「升级/卸载/撤权不留下可执行体」):
  //   - 版本变化 → 旧 grant 从存档里**撤掉**(不是只靠版本比对挡住);
  //   - 同版本换源码(重打包)同样换执行体 → 同样撤(只比版本号会漏掉这一种);
  //   - 升级中途写盘失败 → 旧版仍可执行、新版不落盘、**授权不变**(回滚);
  //   - 升级成功 → 新版可执行、旧执行体不残留、旧授权不再放行、重新授权按新版本生效;
  //   - 清单完全相同(no-op 重装)不撤授权(防空过:没有换执行体就不该误伤)。
  {
    const saved: { text: string | null } = { text: null };
    const persistCalls: string[] = [];
    let failNextManifestWrite = false;
    const upgradeHost = new ModuleHost({
      ...ports({}),
      readWorkflowGrants: () => saved.text,
      persistWorkflowGrants: async (text: string) => { saved.text = text; },
      persist: async (manifests: unknown) => {
        if (failNextManifestWrite) { failNextManifestWrite = false; throw Error("磁盘写入失败(模拟)"); }
        persistCalls.push(JSON.stringify(manifests));
      },
    });
    for (const capability of fileCapabilities((candidate: string) => candidate === root)) upgradeHost.register(capability);
    const grantV1 = {
      moduleId: "user.lifecycle", moduleVersion: "1.0.0", contributionId: "convert",
      capabilityId: "module.lifecycle.convert", projectPath: root,
    };
    /** 存档里还有几条属于该模块。 */
    const grantCountFor = (moduleId: string): number => {
      if (saved.text === null) return 0;
      const parsed = JSON.parse(saved.text) as { grants?: Array<{ moduleId?: string }> };
      return (parsed.grants ?? []).filter((g) => g.moduleId === moduleId).length;
    };

    // 健康安装照常(空过守卫:下面每条"被拒/被撤"都要有一个"正常能过"的对照)。
    await upgradeHost.install(manifestOf());
    await upgradeHost.issueWorkflowGrant(grantV1);
    eq("前置:安装+授权后存档里有 1 条该模块的授权", grantCountFor("user.lifecycle"), 1);
    eq("前置:授权让工作流目标可见",
      upgradeHost.catalog().workflowTargets?.some((t) => t.moduleId === "user.lifecycle") === true, true);

    // no-op 重装(逐字节相同的清单):没有换执行体 → 授权不动。
    await upgradeHost.install(manifestOf());
    eq("★ 逐字节相同的重装不撤授权(没换执行体不误伤)", grantCountFor("user.lifecycle"), 1);

    // 升级中途失败:新版本持久化写盘抛错 → 旧版可执行、新版不落盘、授权不变。
    const writesBeforeFailure = persistCalls.length;
    failNextManifestWrite = true;
    let failure: Error | null = null;
    try { await upgradeHost.install(manifestOf({ version: "2.0.0" })); }
    catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    check("★ 升级写盘失败 → 显式报错(不是假成功)", failure !== null && /磁盘写入失败/.test(failure.message), failure?.message);
    eq("★ 升级失败后旧版清单仍是 1.0.0",
      upgradeHost.catalog().modules.find((m) => m.id === "user.lifecycle")?.version, "1.0.0");
    eq("★ 升级失败后清单一个字节都没写", persistCalls.length, writesBeforeFailure);
    eq("★ 升级失败后旧授权**被回滚**(存档里仍有 1 条)", grantCountFor("user.lifecycle"), 1);
    eq("★ 升级失败后旧版仍可执行(执行体未被撤)",
      upgradeHost.catalog().capabilities.some((c) => c.id === "module.lifecycle.convert"), true);
    const stillV1 = await upgradeHost.invoke({
      moduleId: "user.lifecycle", contributionId: "convert",
      resource: { projectPath: root, path: target }, requestId: "upgrade-fail-1",
    });
    eq("★ 升级失败后执行的是旧版程序", (stillV1 as { value?: { text?: string } }).value?.text, "hello extension");
    eq("★ 升级失败后旧授权仍放行工作流入口",
      upgradeHost.catalog().workflowTargets?.some((t) => t.moduleId === "user.lifecycle") === true, true);

    // 升级成功(版本号变化):旧授权撤掉,旧版本号不再被放行。
    await upgradeHost.install(manifestOf({
      version: "2.0.0",
      program: { source: `({ convert: async (resource) => ({ text: "v2:" + resource.path.split(String.fromCharCode(92)).pop() }) })` },
    }));
    eq("★ 版本升级成功 → 旧授权从存档里撤掉", grantCountFor("user.lifecycle"), 0);
    eq("★ 升级成功后旧版本工作流目标不再可见",
      upgradeHost.catalog().workflowTargets?.some((t) => t.moduleId === "user.lifecycle") === true, false);
    const upgraded = await upgradeHost.invoke({
      moduleId: "user.lifecycle", contributionId: "convert",
      resource: { projectPath: root, path: target }, requestId: "upgrade-ok-1",
    });
    eq("★ 升级成功后执行的是新版程序", (upgraded as { value?: { text?: string } }).value?.text, "v2:note.txt");
    eq("★ 升级成功后能力注册表里没有旧执行体残留",
      upgradeHost.catalog().capabilities.filter((c) => c.id === "module.lifecycle.convert").length, 1);

    // 同版本换源码(重打包):版本号没变,但执行体变了 —— 也必须撤(只按版本判会漏)。
    await upgradeHost.issueWorkflowGrant({ ...grantV1, moduleVersion: "2.0.0" });
    eq("前置:按新版本重新授权后有 1 条", grantCountFor("user.lifecycle"), 1);
    await upgradeHost.install(manifestOf({
      version: "2.0.0",
      program: { source: `({ convert: async () => ({ text: "repacked" }) })` },
    }));
    eq("★ 同版本换执行体重装 → 旧授权同样撤掉(不是只按版本号判)", grantCountFor("user.lifecycle"), 0);
    eq("★ 重打包后工作流目标不再可见",
      upgradeHost.catalog().workflowTargets?.some((t) => t.moduleId === "user.lifecycle") === true, false);
    const repacked = await upgradeHost.invoke({
      moduleId: "user.lifecycle", contributionId: "convert",
      resource: { projectPath: root, path: target }, requestId: "upgrade-repack-1",
    });
    eq("★ 重打包后执行的是新程序", (repacked as { value?: { text?: string } }).value?.text, "repacked");

    // 重新授权按新版本生效(升级不永久禁用授权,只是不继承)。
    await upgradeHost.issueWorkflowGrant({ ...grantV1, moduleVersion: "2.0.0" });
    eq("★ 升级后重新授权按新版本生效",
      upgradeHost.catalog().workflowTargets?.some((t) => t.moduleId === "user.lifecycle") === true, true);
  }

  // ── 9e.【ARC-006 Gate E】坏授权表:升级被拒(撤不干净就不升级) ─────────────
  {
    let savedText: string | null = "{ not json";
    const brokenGrantHost = new ModuleHost({
      ...ports({}),
      readWorkflowGrants: () => savedText,
      persistWorkflowGrants: async (text: string) => { savedText = text; },
    });
    for (const capability of fileCapabilities((candidate: string) => candidate === root)) brokenGrantHost.register(capability);
    await brokenGrantHost.install(manifestOf());
    let brokenError: Error | null = null;
    try { await brokenGrantHost.install(manifestOf({ version: "2.0.0" })); }
    catch (error) { brokenError = error instanceof Error ? error : new Error(String(error)); }
    check("★ 授权表损坏时升级被拒(无法确认旧授权已撤,不放宽)",
      brokenError !== null && /授权表损坏/.test(brokenError.message), brokenError?.message);
    eq("★ 被拒后旧版本仍在(升级不生效)",
      brokenGrantHost.catalog().modules.find((m) => m.id === "user.lifecycle")?.version, "1.0.0");
    eq("坏表原样保留(不被空表覆盖)", savedText, "{ not json");
    eq("★ 被拒后旧版仍可执行",
      brokenGrantHost.catalog().capabilities.some((c) => c.id === "module.lifecycle.convert"), true);
  }

  // ── 9f.【ARC-006 Gate E】升级/卸载取消运行中的旧执行体任务 ─────────────────
  // 语义:协作式取消(任务自己的 AbortController),不杀进程;取消后迟到的结果
  // **不写回**(finish 只从 running 迁移一次);无运行中任务时不误伤;上报取消数。
  {
    const outcomeLog: Array<{ moduleId: string; cancelledTasks: number; cancelFailures: unknown[] }> = [];
    // 用对象持有（闭包里赋值 + 测试读数）：TS 对同作用域的 `let x: T | null = null`
    // 会按控制流收窄成 null，闭包内的赋值不被看见 —— 对象属性没有这个问题。
    const probe: { release: (() => void) | null; signal: AbortSignal | null } = { release: null, signal: null };
    const slowHost = new ModuleHost({
      ...ports({}),
      persist: async () => {},
      onChanged: (outcome) => { outcomeLog.push({ ...outcome }); },
    });
    for (const capability of fileCapabilities((candidate: string) => candidate === root)) slowHost.register(capability);
    // 一个**可阻塞**的 task 能力:等到测试放行才返回结果,拿到的是任务自己的 signal。
    slowHost.register({
      id: "core.test.blocking", kind: "task", input: ResourceSchema, output: ResultSchema,
      run: (resource, context) => new Promise((resolve) => {
        probe.signal = context.signal;
        probe.release = () => resolve({ text: "late-result-must-not-land" });
        // 协作式:收到 abort 就立刻返回一个"被取消后仍返回"的结果 —— 用来断言迟到的
        // 结果不会把 cancelled 状态改回 completed。
        context.signal.addEventListener("abort", () => resolve({ text: "late-result-must-not-land" }), { once: true });
        void resource;
      }),
    });
    const slowManifest = (overrides: Record<string, unknown> = {}) => ({
      ...manifestOf(overrides),
      contributions: [
        ...manifestOf().contributions,
        {
          id: "slow", slot: "files.context", title: { zh: "慢任务", en: "Slow task" },
          capability: "core.test.blocking",
          view: { title: { zh: "结果", en: "Result" }, fields: [{ key: "text", title: { zh: "文本", en: "Text" } }] },
        },
      ],
      ...overrides,
    });

    // 健康安装照常(空过守卫)。
    await slowHost.install(slowManifest());
    eq("前置:带 task 贡献的扩展正常安装", slowHost.catalog().modules.length, 1);

    // 无运行中任务时升级:不取消任何东西,也不上报失败。
    outcomeLog.length = 0;
    await slowHost.install(slowManifest({ version: "2.0.0" }));
    eq("★ 无运行中任务时升级:取消数为 0(不误伤,防空过)", outcomeLog.at(-1)?.cancelledTasks, 0);

    // 起一个运行中的 task,再升级 → 必须被取消。
    const started = await slowHost.invoke({
      moduleId: "user.lifecycle", contributionId: "slow",
      resource: { projectPath: root, path: target }, requestId: "slow-1",
    });
    eq("前置:任务进入 running", (started as { type?: string; task?: { status?: string } }).task?.status, "running");
    const taskId = (started as { task?: { id?: string } }).task?.id ?? "";
    await delay(20); // 让 run 真的开始、signal 已建立
    check("前置:扩展拿到了任务的 AbortSignal", probe.signal !== null && probe.signal.aborted === false);
    outcomeLog.length = 0;
    await slowHost.install(slowManifest({
      version: "3.0.0",
      program: { source: `({ convert: async () => ({ text: "v3" }) })` },
    }));
    eq("★ 升级时运行中的旧任务被取消(协作式,通过任务自己的 signal)", probe.signal?.aborted, true);
    eq("★ 上报「已取消 N 个运行中任务」", outcomeLog.at(-1)?.cancelledTasks, 1);
    eq("★ 取消后任务状态是 cancelled(不是 completed)", slowHost.task({ moduleId: "user.lifecycle", taskId }).status, "cancelled");
    // 放行那个"迟到"的执行体:它 resolve 了结果,但 finish 的状态守卫必须挡住写回。
    probe.release?.();
    await delay(30);
    const afterLate = slowHost.task({ moduleId: "user.lifecycle", taskId });
    eq("★ 取消后旧结果不写回(状态仍是 cancelled)", afterLate.status, "cancelled");
    eq("★ 取消后旧结果不写回(没有 result 字段)", afterLate.result, undefined);

    // 卸载路径同样取消运行中任务并上报。
    const second = await slowHost.invoke({
      moduleId: "user.lifecycle", contributionId: "slow",
      resource: { projectPath: root, path: target }, requestId: "slow-2",
    });
    const secondId = (second as { task?: { id?: string } }).task?.id ?? "";
    await delay(20);
    outcomeLog.length = 0;
    await slowHost.remove("user.lifecycle");
    eq("★ 卸载时同样取消运行中任务", slowHost.task({ moduleId: "user.lifecycle", taskId: secondId }).status, "cancelled");
    eq("★ 卸载同样上报取消数", outcomeLog.at(-1)?.cancelledTasks, 1);
  }

  // ── 10. 权限参数本身:每一条都在,且不给目录 ───────────────────────────
  const args = permissionArgs(target, false);
  check("权限参数打开 --permission", args.includes("--permission"));
  check("只放行目标文件的读", args.includes("--allow-fs-read=" + target));
  check("未声明写时不放行任何写", !args.some((a) => a.startsWith("--allow-fs-write")));
  check("不给目录(只给具体文件)", !args.some((a) => a === "--allow-fs-read=" + root));

  // 哈希只作证据记录,不参与断言。
  console.log("  note fixture sha256 " + createHash("sha256").update(await readFile(target)).digest("hex").slice(0, 16));
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log(`module-extension-lifecycle:${total - failures}/${total} 通过`);
process.exitCode = failures === 0 ? 0 : 1;
