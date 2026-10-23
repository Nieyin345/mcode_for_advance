/**
 * 【T19】**扩展委托面的 danger 档收窄** —— `policy.ts` 判为 `danger` 的高风险 RPC
 * 不能再靠「安装时授予了权限」一次性放行；扩展每调用一次都要用户本人点头。
 *
 * ## 盯的缺陷（卡面原文）
 *
 * `assertAppMethodPermission` 只做权限包含判定：366 条可委托方法里落在 `danger`
 * 档的 91 条（`git.push` / `project.delete` / `modules.install` …）只要扩展在安装时
 * 拿到对应权限，`core.app.call` 就直接放行，**从不逐次审批**。
 *
 * ## 修复落点（本套逐条钉住）
 *
 * `ModuleHost.callAppFromExtension`（扩展 RPC 的唯一派发口）在权限判定之后调用
 * `approveDangerAppCall`：`policyFor(method).level === "danger"` 时，**每次调用**
 * 都经 `requestApproval` 端口向用户要一次新鲜批准。
 *
 * ## 断言（对应卡面验收 1–8）
 *
 * 1. 持有 `git.write` 的扩展调用 `git.push` → 触发审批；端到端走真子进程 NDJSON 桥。
 * 2. `BLOCKED` 表方法与 `null` 映射（`workflowEngine.load`）→ 直接拒，不弹审批。
 * 3. `read` / `write` 档 → 不触发本闸（保持现状）。
 * 4. 系统性地：**91 条可委托 danger 方法逐一**触发且只触发一次审批（与 policyFor 现算的
 *    集合逐名相等；数量钉死 91，policy.ts 变化会强迫重新审视本卡）。
 * 5. 不存在「始终允许」：同一方法连续两次 → 两次审批；期间不写任何授权存档。
 * 6. 无审批端口 → fail-closed（`approval_unavailable`），绝不静默放行。
 * 7. 伪造身份：扩展身份由宿主在安装时绑定，B 的授权不能替 A 放行；未知模块 id 直接拒。
 * 8. 审批挂起期间模块被卸载 → 批准不落到旧执行体（不派发）。
 * 9. 迁移：每一类拒绝都有可读理由与 `moduleRefusal` 标记码（上层据此报 REJECTED，
 *    不误报 UNCERTAIN）。
 * 10. T26 移交的文案：失效的「本次运行允许」记录，其抛错文本不再出现「允许一次」。
 *
 * 91 条的系统性枚举走宿主内部的 `callAppFromExtension`（与子进程桥调用的是**同一段**
 * 闸门逻辑）；其中 `git.push` / blocked 两条另走**真子进程**，证明 NDJSON 桥接线没有
 * 绕开这道闸。所有数据都在临时目录/内存桩里，不碰用户数据根。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleHost, type ActionApprovalRequest } from "@main/modules/ModuleHost.js";
import { fileCapabilities } from "@main/modules/fileCapabilities.js";
import { configureJsOnlyEgressConsentReader } from "@main/modules/permissionedProcessRunner.js";
import { policyFor } from "@main/appControl/policy.js";
import { APP_METHOD_PERMISSIONS, MODULE_PERMISSION_NAMES, assertAppMethodPermission, permissionsForAppMethod, type ModulePermission } from "@contracts/appPermission";
import { EXAMPLE_MODULE, ModuleManifestSchema, moduleRefusal, type ModuleManifest, type ModuleResource } from "@contracts/modules";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error); }
}
const eq = (name: string, actual: unknown, expected: unknown): void => {
  check(name, () => assert.deepEqual(actual, expected));
};
const rejects = async (name: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<unknown> => {
  let seen: unknown;
  await check(name, async () => {
    try { await fn(); } catch (error) { seen = error; assert.match(String((error as Error).message), pattern); return; }
    assert.fail("expected rejection, call resolved");
  });
  return seen;
};

// Windows 上可执行扩展需要显式 JS-only 降级（与 module-app-call-smoke 同一做法，
// 只影响本进程，套件结束复原）。本套不声明 network，开启它只为让 program 能起子进程。
configureJsOnlyEgressConsentReader(() => true);

/** 【T19】卡面钉死的数量：366 条可委托方法中落在 danger 档的条数。
 *  policy.ts 增删 danger 条目时这里会红 —— 那正是要重新审视本卡的信号。 */
const DANGER_DELEGABLE_COUNT = 91;

/** 与 `policy.ts` 现算的「danger 且可委托」方法集合 —— 断言对象是**同一份判据**。 */
const dangerDelegableMethods = Object.keys(APP_METHOD_PERMISSIONS)
  .filter((method) => APP_METHOD_PERMISSIONS[method] !== null && policyFor(method).level === "danger")
  .sort();
/** 映射为 null（不可委托）但 policy 判 danger 的方法（目前只有 workflowEngine.load）。 */
const dangerNonDelegableMethods = Object.keys(APP_METHOD_PERMISSIONS)
  .filter((method) => APP_METHOD_PERMISSIONS[method] === null && policyFor(method).level === "danger")
  .sort();
/** policy 判 blocked 的方法（映射应全部为 null —— BLOCKED 档从不可委托）。 */
const blockedMethods = Object.keys(APP_METHOD_PERMISSIONS)
  .filter((method) => policyFor(method).level === "blocked")
  .sort();

const temp = mkdtempSync(join(tmpdir(), "mcode-t19-"));
try {
  const file = join(temp, "sample.txt");
  writeFileSync(file, "t19 fixture", "utf8");
  const resource: ModuleResource = { projectPath: temp, path: file };

  /** 一次调用的记录（审批 / 派发）。 */
  interface Calls { approvals: ActionApprovalRequest[]; dispatched: Array<{ moduleId: string; method: string }>; }
  interface Fixture extends Calls {
    host: ModuleHost;
    archive: string | null;
    persistCalls: number;
    approvalWrites: number;
  }
  /** 可复用的宿主桩：审批端口与派发口都记录下来，权限存档在内存里。 */
  function makeHost(options: {
    bootId?: string;
    approve?: (request: ActionApprovalRequest) => Promise<void>;
    invokeAppCall?: (moduleId: string, method: string, input: unknown) => Promise<unknown>;
    seedArchive?: string | null;
  } = {}): Fixture {
    const fx: Fixture = { host: null as unknown as ModuleHost, archive: options.seedArchive ?? null, persistCalls: 0, approvalWrites: 0, approvals: [], dispatched: [] };
    fx.host = new ModuleHost({
      authorize: async () => {},
      resolveResource: async (r) => r.path,
      verifyProgram: async () => ({ ok: true }),
      persist: async () => {},
      readModulePermissions: () => fx.archive,
      persistModulePermissions: async (text) => { fx.archive = text; fx.approvalWrites += 1; },
      requestApproval: async (request) => {
        fx.approvals.push(request);
        if (options.approve) return options.approve(request);
      },
      invokeAppCall: async (moduleId, method, input) => {
        fx.dispatched.push({ moduleId, method });
        return options.invokeAppCall ? options.invokeAppCall(moduleId, method, input) : { ok: true };
      },
      ...(options.bootId === undefined ? {} : { bootId: options.bootId }),
    });
    for (const capability of fileCapabilities(() => true)) fx.host.register(capability);
    return fx;
  }
  /** 不走审批端口的宿主（fail-closed 对照）。 */
  function makeHostWithoutApproval(): Fixture {
    const fx: Fixture = { host: null as unknown as ModuleHost, archive: null, persistCalls: 0, approvalWrites: 0, approvals: [], dispatched: [] };
    fx.host = new ModuleHost({
      authorize: async () => {},
      resolveResource: async (r) => r.path,
      verifyProgram: async () => ({ ok: true }),
      persist: async () => {},
      readModulePermissions: () => fx.archive,
      persistModulePermissions: async (text) => { fx.archive = text; },
      invokeAppCall: async (moduleId, method) => { fx.dispatched.push({ moduleId, method }); return { ok: true }; },
    });
    for (const capability of fileCapabilities(() => true)) fx.host.register(capability);
    return fx;
  }
  /** 取宿主**内部**持有的清单对象（`callAppFromExtension` 以对象身份核对"还是不是这一版"；
   *  `catalog()` 返回深拷贝，身份对不上，故测试直接读私有 Map —— 只读，不改）。 */
  const storedManifest = (host: ModuleHost, id: string): ModuleManifest => {
    const modules = (host as unknown as { modules: Map<string, ModuleManifest> }).modules;
    const manifest = modules.get(id);
    assert.ok(manifest, "stored manifest missing: " + id);
    return manifest;
  };
  /** 直接驱动扩展 RPC 闸门（与子进程桥 `onAppCall` 调的是同一个私有方法）。 */
  const callFromExtension = (host: ModuleHost, manifest: ModuleManifest, method: string, input: unknown = {}) =>
    (host as unknown as {
      callAppFromExtension(manifest: ModuleManifest, method: string, input: unknown, resource: ModuleResource, signal: AbortSignal): Promise<unknown>;
    }).callAppFromExtension(manifest, method, input, resource, new AbortController().signal);

  const ALL_PERMISSIONS = [...MODULE_PERMISSION_NAMES] as ModulePermission[];
  /** 全权限**声明式**清单（无 program）：能装、能调闸门，且不受 Windows network 限制。 */
  const omniManifest: ModuleManifest = ModuleManifestSchema.parse({
    ...EXAMPLE_MODULE,
    id: "user.t19-omni", version: "1.0.0",
    title: { zh: "T19 全权限夹具", en: "T19 omnipotent fixture" },
    permissions: ALL_PERMISSIONS,
  });
  const omniHost = makeHost();
  await omniHost.host.install(omniManifest, ALL_PERMISSIONS);
  const omniStored = storedManifest(omniHost.host, omniManifest.id);

  /* ── ① 卡面验收 1：持有 git.write 的扩展调用 git.push → 触发审批 ── */
  await eq("① 集合钉死：danger 且可委托的方法恰好 " + DANGER_DELEGABLE_COUNT + " 条",
    dangerDelegableMethods.length, DANGER_DELEGABLE_COUNT);
  await check("① 91 条里包含卡面点名的 git.push / project.delete / modules.install",
    () => { assert.ok(["git.push", "project.delete", "modules.install", "setting.set"].every((m) => dangerDelegableMethods.includes(m)), JSON.stringify(dangerDelegableMethods.slice(0, 5))); });
  await check("①「绑定 git.write 权限」仍只是权限判定 —— git.push 权限够、但必须另外弹审批", async () => {
    assert.equal(policyFor("git.push").level, "danger");
    assert.doesNotThrow(() => assertAppMethodPermission("git.push", ["git.write"]));
    await callFromExtension(omniHost.host, omniStored, "git.push", { branch: "main" });
    assert.equal(omniHost.approvals.length, 1, "git.push 必须触发一次审批");
    const request = omniHost.approvals[0]!;
    assert.equal(request.scope, "danger");
    assert.equal(request.method, "git.push");
    assert.equal(request.moduleId, omniManifest.id);
    assert.equal(request.resource.path, file);
    assert.equal(omniHost.dispatched.length, 1, "批准之后才派发");
    assert.deepEqual(omniHost.dispatched[0], { moduleId: omniManifest.id, method: "git.push" });
  });

  /* ── ② 系统性：91 条可委托 danger 逐一触发且只触发一次 ── */
  {
    const host = makeHost();
    await host.host.install(omniManifest, ALL_PERMISSIONS);
    const stored = storedManifest(host.host, omniManifest.id);
    await check("★ 91 条可委托 danger 方法逐一要求用户批准（每次一条、方法名原样交给审批端口）", async () => {
      for (const method of dangerDelegableMethods) await callFromExtension(host.host, stored, method);
      const approvedMethods = host.approvals.map((r) => r.method);
      assert.deepEqual([...approvedMethods].sort(), dangerDelegableMethods, "每一条 danger 都必须且只出现一次审批");
      assert.ok(host.approvals.every((r) => r.scope === "danger" && r.moduleId === omniManifest.id));
      assert.equal(host.dispatched.length, dangerDelegableMethods.length);
    });
    await eq("★ 91 条 danger 全部拒绝时：一次都没有派发（审批是执行前的闸）", await (async () => {
      const refusing = makeHost({ approve: async () => { throw Error("用户拒绝"); } });
      await refusing.host.install(omniManifest, ALL_PERMISSIONS);
      const storedRef = storedManifest(refusing.host, omniManifest.id);
      let refused = 0;
      for (const method of dangerDelegableMethods) {
        try { await callFromExtension(refusing.host, storedRef, method); } catch { refused++; }
      }
      return { refused, dispatched: refusing.dispatched.length };
    })(), { refused: dangerDelegableMethods.length, dispatched: 0 });
  }

  /* ── ③ 卡面验收 2：BLOCKED / 不可委托 → 直接拒，不弹审批 ── */
  await check("★ BLOCKED 表里的方法直接拒绝且不弹审批（即便扩展被授予全部权限）", async () => {
    const before = omniHost.approvals.length;
    const dispatchedBefore = omniHost.dispatched.length;
    for (const method of ["claude.approve", "claude.respondQuestion", "customModel.getToken", "modules.setPermissions", "publicMcp.status"]) {
      assert.equal(policyFor(method).level, "blocked", method);
      const error = await rejects("blocked 拒绝: " + method, () => callFromExtension(omniHost.host, omniStored, method), /不可委托/);
      assert.equal(moduleRefusal(error)?.code, "scope_denied");
    }
    assert.equal(omniHost.approvals.length, before, "blocked 不得触发审批卡");
    assert.equal(omniHost.dispatched.length, dispatchedBefore, "blocked 不得派发");
  });
  await eq("★ BLOCKED 档方法在权限映射里全部是 null（没有一条可被 grant 绕过）",
    blockedMethods.filter((m) => APP_METHOD_PERMISSIONS[m] !== null), []);
  await check("★ 不可委托的 danger 直接拒、不弹审批 —— blocked 是「谁都够不到」而不是「够得到但要问」", async () => {
    // 【T34】这份名单从 1 条变成 3 条：`document.toolCall` / `document.markdownEdit`
    // 被 T33 提到 danger（理由：扩展拿到 document.edit 后改调它们就绕开逐次审批），
    // 而本卡把它们同时设为**不可委托** —— 否则那条绕开会原样回来。
    //
    // 名单仍是**逐一钉死**而不是「大于等于」：新增不可委托项必须是有意识的决定，
    // 让这条断言红一次、逼人来看。这正是它存在的意义。
    assert.deepEqual(dangerNonDelegableMethods,
      ["document.markdownEdit", "document.toolCall", "workflowEngine.load"]);
    for (const method of dangerNonDelegableMethods) {
      const before = omniHost.approvals.length;
      const error = await rejects(`${method} 直接拒`, () => callFromExtension(omniHost.host, omniStored, method), /不可委托/);
      assert.equal(moduleRefusal(error)?.code, "scope_denied");
      assert.equal(omniHost.approvals.length, before, `${method} 拒绝时不该弹审批`);
    }
  });

  /* ── ④ 卡面验收 3：read / write 档不触发本闸 ── */
  await check("★ read 档方法不触发审批（保持现状）", async () => {
    const host = makeHost();
    await host.host.install(omniManifest, ALL_PERMISSIONS);
    const stored = storedManifest(host.host, omniManifest.id);
    for (const method of ["file.readFile", "session.listAll", "git.status", "library.get"]) {
      assert.notEqual(policyFor(method).level, "danger", method);
      await callFromExtension(host.host, stored, method);
    }
    assert.equal(host.approvals.length, 0, "read 档不得弹审批");
    assert.equal(host.dispatched.length, 4);
  });
  await check("★ write 档方法在后端桥这一层不逐次弹卡（安装授权已覆盖；审批在前端 app_api_call 层）", async () => {
    const host = makeHost();
    await host.host.install(omniManifest, ALL_PERMISSIONS);
    const stored = storedManifest(host.host, omniManifest.id);
    for (const method of ["claude.sendTurn", "file.writeFile", "setting.set"]) {
      // setting.set 是 danger；前两条是 write —— 分开断言。
      if (policyFor(method).level !== "danger") await callFromExtension(host.host, stored, method);
    }
    assert.equal(host.approvals.length, 0);
    assert.equal(host.dispatched.length, 2);
  });

  /* ── ⑤ 不存在「始终允许」：同一方法每次都问，且不写授权存档 ── */
  await check("★ 同一个 danger 方法每次调用都重新询问（不存在始终允许）", async () => {
    const host = makeHost();
    await host.host.install(omniManifest, ALL_PERMISSIONS);
    const stored = storedManifest(host.host, omniManifest.id);
    const writesAfterInstall = host.approvalWrites;
    const archiveAfterInstall = host.archive;
    for (let i = 0; i < 3; i++) await callFromExtension(host.host, stored, "git.push");
    assert.equal(host.approvals.filter((r) => r.method === "git.push").length, 3, "三次调用 = 三次审批");
    assert.equal(host.dispatched.length, 3);
    assert.equal(host.approvalWrites, writesAfterInstall, "danger 审批不得写任何授权存档");
    assert.equal(host.archive, archiveAfterInstall, "权限授权表在调用期间保持原样");
  });

  /* ── ⑥ 无审批端口 = fail-closed ── */
  await check("★ 没有审批端口时 danger 调用被拒（approval_unavailable），绝不静默放行", async () => {
    const host = makeHostWithoutApproval();
    await host.host.install(omniManifest, ALL_PERMISSIONS);
    const stored = storedManifest(host.host, omniManifest.id);
    const error = await rejects("无审批端口", () => callFromExtension(host.host, stored, "project.delete"), /没有审批通道/);
    assert.match(String((error as Error).message), /project\.delete/);
    assert.equal(moduleRefusal(error)?.code, "approval_unavailable");
    assert.equal(host.dispatched.length, 0);
  });

  /* ── ⑦ 伪造身份：宿主绑定，A 的授权不能替 B 放行 ── */
  await check("★ 伪造模块身份：只读扩展不能借用另一扩展的 git.write 授权", async () => {
    const host = makeHost();
    const reader: ModuleManifest = ModuleManifestSchema.parse({
      ...EXAMPLE_MODULE, id: "user.t19-reader", version: "1.0.0",
      title: { zh: "只读夹具", en: "Reader fixture" }, permissions: ["files.read"],
    });
    await host.host.install(omniManifest, ALL_PERMISSIONS);
    await host.host.install(reader, ["files.read"]);
    const readerStored = storedManifest(host.host, reader.id);
    const error = await rejects("只读扩展调 git.push", () => callFromExtension(host.host, readerStored, "git.push"), /git\.write/);
    assert.equal(moduleRefusal(error)?.code, "scope_denied");
    assert.equal(host.approvals.length, 0, "权限不够时连审批都不弹（先权限、后档位）");
    assert.equal(host.dispatched.length, 0);
    // 未知模块 id（渲染端/子进程自报的 ID）一律拒。
    const ghost = await rejects("未知模块 id", async () => host.host.authorizeAppMethod("user.ghost", "git.push"), /找不到已安装的用户扩展/);
    assert.equal(moduleRefusal(ghost)?.code, "scope_denied");
  });

  /* ── ⑧ 审批挂起期间模块被卸载 → 批准不落到旧执行体 ── */
  await check("★ 审批挂起期间模块被卸载：批准不再生效，且不派发", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let asked = 0;
    const host = makeHost({ approve: async () => { asked += 1; await pending; } });
    const victim: ModuleManifest = ModuleManifestSchema.parse({
      ...EXAMPLE_MODULE, id: "user.t19-victim", version: "1.0.0",
      title: { zh: "卸载夹具", en: "Uninstall fixture" }, permissions: ["files.read", "git.write"],
    });
    await host.host.install(victim, ["files.read", "git.write"]);
    const stored = storedManifest(host.host, victim.id);
    const call = callFromExtension(host.host, stored, "git.push").then(() => ({ ok: true as const, error: null }), (error: unknown) => ({ ok: false as const, error }));
    // 有界等待：门在时审批会挂起；门被撤掉时这里**不许死等** —— 直接判红，
    // 让后面的端到端断言还能跑（批量变异验证要在一次运行里看到全部证据）。
    let waited = 0;
    while (asked === 0 && waited < 2000) { await new Promise((resolve) => setTimeout(resolve, 10)); waited += 10; }
    assert.ok(asked > 0, "审批端口没有被调用（danger 闸门缺失）");
    await host.host.remove(victim.id);
    release();
    const outcome = await call;
    assert.equal(outcome.ok, false);
    assert.match(String((outcome.error as Error).message), /模块已变化/);
    assert.equal(host.dispatched.length, 0, "批准挂起期间模块已被卸载，绝不派发");
  });

  /* ── ⑨ 端到端：真子进程 NDJSON 桥也不能绕开这道闸 ── */
  {
    const program = '({run:async(resource)=>{const r=await mcode.api.call("git.push",{projectPath:resource.projectPath,path:resource.path}).then(()=>({ok:true,msg:""}),e=>({ok:false,msg:String(e.message)}));return {ok:String(r.ok),msg:String(r.msg).slice(0,200)};}})';
    const blockedProgram = '({run:async()=>{const r=await mcode.api.call("claude.approve",{}).then(()=>({ok:true,msg:""}),e=>({ok:false,msg:String(e.message)}));return {ok:String(r.ok),msg:String(r.msg).slice(0,200)};}})';
    const childManifest = (source: string, version: string): ModuleManifest => ModuleManifestSchema.parse({
      ...EXAMPLE_MODULE, id: "user.t19-bridge", version,
      title: { zh: "T19 子进程夹具", en: "T19 child fixture" },
      permissions: ["files.read", "git.write"],
      contributions: [{ ...EXAMPLE_MODULE.contributions[0]!, capability: "module.run" }],
      program: { source, timeoutMs: 20_000 },
    });
    let allow = true;
    const host = makeHost({ approve: async () => { if (!allow) throw Error("用户拒绝了这次高风险调用,未执行。"); } });
    await host.host.install(childManifest(program, "1.0.0"), ["files.read", "git.write"]);
    const invoke = (requestId: string) => host.host.invoke({ moduleId: "user.t19-bridge", contributionId: "inspect", requestId, resource });
    await check("★ 端到端：持有 git.write 的扩展经真子进程调 git.push → 先弹审批，批准后才派发", async () => {
      const reply = await invoke("child-allow");
      assert.equal(reply.type, "result");
      if (reply.type !== "result") throw Error("missing result");
      assert.equal(reply.value.ok, "true");
      assert.equal(host.approvals.length, 1);
      assert.equal(host.approvals[0]!.scope, "danger");
      assert.equal(host.approvals[0]!.method, "git.push");
      assert.equal(host.dispatched.length, 1);
      // 派发身份是宿主绑定的清单 id —— 子进程只能给方法名，给不了 moduleId。
      assert.deepEqual(host.dispatched[0], { moduleId: "user.t19-bridge", method: "git.push" });
    });
    await check("★ 端到端：用户拒绝时子进程拿到可读错误，且没有派发", async () => {
      allow = false;
      const reply = await invoke("child-deny");
      assert.equal(reply.type, "result");
      if (reply.type !== "result") throw Error("missing result");
      assert.equal(reply.value.ok, "false");
      assert.match(String(reply.value.msg), /用户拒绝/);
      assert.equal(host.approvals.length, 2, "第二次调用又弹了一次（没有始终允许）");
      assert.equal(host.dispatched.length, 1, "拒绝后没有新的派发");
      allow = true;
    });
    await check("★ 端到端：子进程调 BLOCKED 方法 → 直接拒，不弹审批", async () => {
      await host.host.install(childManifest(blockedProgram, "1.0.1"), ["files.read", "git.write"]);
      const approvalsBefore = host.approvals.length;
      const reply = await host.host.invoke({ moduleId: "user.t19-bridge", contributionId: "inspect", requestId: "child-blocked", resource });
      assert.equal(reply.type, "result");
      if (reply.type !== "result") throw Error("missing result");
      assert.equal(reply.value.ok, "false");
      assert.match(String(reply.value.msg), /不可委托/);
      assert.equal(host.approvals.length, approvalsBefore, "blocked 不弹审批");
      assert.equal(host.dispatched.length, 1);
    });
  }

  /* ── ⑩ 迁移：每一类拒绝都有可读理由与稳定码 ── */
  await check("★ 迁移：四类拒绝各有可读理由与 moduleRefusal 码（上层据此报 REJECTED 而非 UNCERTAIN）", async () => {
    // (a) 权限不足
    const host = makeHost();
    const reader: ModuleManifest = ModuleManifestSchema.parse({
      ...EXAMPLE_MODULE, id: "user.t19-migration", version: "1.0.0",
      title: { zh: "迁移夹具", en: "Migration fixture" }, permissions: ["files.read", "git.write"],
    });
    await host.host.install(reader, ["files.read"]);
    const stored = storedManifest(host.host, reader.id);
    const missingGrant = await rejects("(a) 缺权限", () => callFromExtension(host.host, stored, "git.push"), /没有 git\.write 权限/);
    assert.equal(moduleRefusal(missingGrant)?.code, "scope_denied");
    // (b) blocked
    const blocked = await rejects("(b) blocked", () => callFromExtension(host.host, stored, "modules.setPermissions"), /不可委托/);
    assert.equal(moduleRefusal(blocked)?.code, "scope_denied");
    // (c) danger 被用户拒绝
    const denying = makeHost({ approve: async () => { throw Error("用户拒绝了这次高风险调用,未执行。"); } });
    await denying.host.install(reader, ["files.read", "git.write"]);
    const denyingStored = storedManifest(denying.host, reader.id);
    const denied = await rejects("(c) danger 被拒", () => callFromExtension(denying.host, denyingStored, "git.push"), /用户拒绝/);
    assert.equal(moduleRefusal(denied)?.code, "approval_denied");
    // (d) 没有审批通道
    const channelLess = makeHostWithoutApproval();
    await channelLess.host.install(reader, ["files.read", "git.write"]);
    const channelStored = storedManifest(channelLess.host, reader.id);
    const noChannel = await rejects("(d) 无通道", () => callFromExtension(channelLess.host, channelStored, "git.push"), /没有审批通道/);
    assert.equal(moduleRefusal(noChannel)?.code, "approval_unavailable");
  });

  /* ── ⑪ T26 移交的文案：「允许一次」→「本次运行允许」 ── */
  await check("★ 失效的会话授权抛错文本用「本次运行允许」，且不再出现「允许一次」", async () => {
    // 用**旧权限模型**的清单（只有 resource.read）：这样第一条守卫
    // （「新权限模型必须逐项确认授权」）不会先接住，才走得到「会话授权已失效」那条。
    const legacy: ModuleManifest = ModuleManifestSchema.parse({
      ...EXAMPLE_MODULE, id: "user.t19-session-copy", version: "1.0.0",
      title: { zh: "会话文案夹具", en: "Session copy fixture" }, permissions: ["resource.read"],
    });
    const first = makeHost({ bootId: "boot-old-0001" });
    await first.host.install(legacy, ["resource.read"], "allow-once");
    const archived = first.archive!;
    assert.match(archived, /"duration": "session"/);
    // 模拟重启：新宿主 + 同一份存档 + restore（生产是 service.ts 启动时 restore）。
    const rebooted = makeHost({ bootId: "boot-new-0002", seedArchive: archived });
    rebooted.host.restore(JSON.parse(JSON.stringify(legacy)));
    const error = await rejects("重启后重装", () => rebooted.host.install(legacy), /本次运行允许/);
    assert.ok(!String((error as Error).message).includes("允许一次"), "旧词「允许一次」不得再出现在用户可见抛错里: " + String((error as Error).message));
    assert.match(String((error as Error).message), /重新确认授权/);
  });

  /* ── ⑫ 档位判定的唯一来源：宿主 import 的就是 policy.ts（不复制第二份表） ── */
  await check("★ 宿主侧档位判定与 policyFor 一致（不存在第二份 danger 名单）", () => {
    assert.equal(policyFor("git.push").level, "danger");
    assert.equal(policyFor("claude.sendTurn").level, "write");
    assert.equal(policyFor("file.readFile").level, "read");
    assert.equal(policyFor("claude.approve").level, "blocked");
    // 契约层的权限函数仍只回答权限问题（不因 danger 而拒绝），damage 由宿主这一层补。
    assert.doesNotThrow(() => assertAppMethodPermission("git.push", ["git.write"]));
    assert.equal(permissionsForAppMethod("git.push")?.join(","), "git.write");
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
  configureJsOnlyEgressConsentReader(null);
}

console.log(`extension-danger-delegation-smoke: ${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
