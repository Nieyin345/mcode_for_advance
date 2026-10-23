/**
 * 【T20】**扩展工坊**的回归网 —— AI 写扩展的六步闭环。
 *
 * ## 本套逐条钉住的卡面验收（编号对应 `tasks/T20-ai-writes-extensions.md`）
 *
 * 1. **需求理解 → 清单草案 → 停下来等确认**：`buildExtension` 成功只返回交接材料
 *    （`requiresUserApproval: true`），从不安装；`installConsent` 恒为 `allow-once`。
 *    `invokeAppTool("extension_build")` 在写盘**之前**弹 write 档审批卡（不经确认不写盘）。
 * 2. **AI 声明 blocked 档能力 → 静态拒绝**：清单权限闭集 + 程序字面量调用的 blocked /
 *    不可委托方法，逐条给出可读错误；危险档只在运行期逐次问，不在静态拒。
 * 3. **沙箱冒烟失败 → 不装机、回滚干净、无残留**：真子进程（`runPermissionedProcess`）
 *    跑一次最小调用；失败时草稿目录删除、状态 attempts+1；沙箱里 write/danger 一律拒。
 * 4. **用户拒绝权限 → 不装机**：交接材料走 `modules.install` 的 T18 卡；这里用真
 *    `ModuleHost` 证明 `deny` 在写盘前抛，且工坊不自己调 install。
 * 5. **装机成功后扩展能被调用；卸载后无残留**：`reconcileWorkshopStates` 以宿主目录为准
 *    记录可回滚点 / 标 `rolledBack` 并清草稿。
 * 6. **修复循环超过上限 → 停下并报告**：`WORKSHOP_MAX_REPAIR_ATTEMPTS`（3）+ 全局草稿数上限。
 * 7. **变异**：`build.mjs` 两条（self-approve / no-sandbox），各自把对应断言打红。
 *
 * ## 安全硬要求里的两条"额外的"
 *
 * - **danger 档经工坊装出来的扩展仍逐次审批**：本套用真 `ModuleHost` 装一个工坊产物，
 *   经 `callAppFromExtension`（T19 的唯一派发口）调 `git.push`，断言每次一条审批。
 * - **不新增 RPC**：源码级断言 —— 工坊的出口只有 `appMcpTools()` 里的工具与既有
 *   `modules.*` 通道；`RpcMap` / `apiCatalog.generated.ts` / `appPermission.ts` 未改。
 *
 * 全部只碰临时目录与内存桩；宿主用真 `ModuleHost`（沙箱走真子进程）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleHost, type ActionApprovalRequest } from "@main/modules/ModuleHost.js";
import { fileCapabilities, resolveModuleResource } from "@main/modules/fileCapabilities.js";
import { configureJsOnlyEgressConsentReader } from "@main/modules/permissionedProcessRunner.js";
import {
  buildExtension, diagnoseExtensionDraft, extensionWorkshopInstallHandoff, projectWorkshopStatus,
  readWorkshopState, reconcileWorkshopStates, runWorkshopSandbox, summarizeWorkshopReport,
  workshopDraftDir, MAX_REPAIR_ATTEMPTS, type WorkshopSandbox, type WorkshopSandboxInput,
} from "@main/modules/extensionWorkshop.js";
import {
  WORKSHOP_DRAFT_FILE, WORKSHOP_ENTRY_FILE, WORKSHOP_MAX_DRAFTS,
} from "@contracts/extensionWorkshop";
import { ModuleInstallSchema } from "@contracts/ipc/modules";
import { resolveInstallDecision } from "@main/modules/installConsentPolicy.js";
import { ModuleManifestSchema, moduleRefusal, type ModuleManifest, type ModuleResource } from "@contracts/modules";
import { policyFor } from "@main/appControl/policy.js";
import { invokeAppTool, appMcpTools, APP_READONLY_TOOLS, extensionInstallApprovalSummary } from "@main/appControl/tools.js";
import { isAppToolName } from "@main/appControl/engineTools.js";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import type { ProviderContext } from "@contracts/provider";

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

// Windows 上可执行扩展需要显式 JS-only 降级（与 module-install-consent-smoke 同一做法，
// 只影响本进程与它拉起的沙箱子进程）。本套所有扩展都不声明 network。
configureJsOnlyEgressConsentReader(() => true);

const temp = mkdtempSync(join(tmpdir(), "mcode-t20-"));
const workshopRoot = join(temp, "extension-workshop");
const workspace = join(temp, "workspace");
const sample = join(workspace, "sample.md");
mkdirSync(workspace, { recursive: true });

/** 一份合法的最小扩展草稿（read 档：读文件、统计行数）。 */
function draftOf(overrides: {
  id?: string; version?: string; permissions?: string[]; source?: string; notes?: string;
  capability?: string; extensions?: string[];
} = {}): unknown {
  return {
    manifest: {
      apiVersion: 1,
      id: overrides.id ?? "user.t20-line-counter",
      version: overrides.version ?? "1.0.0",
      title: { zh: "统计行数", en: "line counter" },
      permissions: overrides.permissions ?? ["files.read"],
      contributions: [{
        id: "count", slot: "files.context",
        title: { zh: "统计行数", en: "count lines" },
        extensions: overrides.extensions ?? [".md"],
        capability: overrides.capability ?? "module.count",
        view: { title: { zh: "行数", en: "lines" }, fields: [{ key: "lines", title: { zh: "行数", en: "lines" } }] },
      }],
      program: {
        source: overrides.source
          ?? '({ count: async (resource) => ({ lines: require("node:fs").readFileSync(resource.path, "utf8").split("\\n").length }) })',
        timeoutMs: 10_000,
      },
    },
    ...(overrides.notes !== undefined ? { notes: overrides.notes } : {}),
  };
}

const options = () => ({
  workshopRoot,
  sandboxWorkspace: () => ({ projectPath: workspace, path: sample }),
  sandboxTimeoutMs: 15_000,
  // 沙箱里的 read 档 RPC 派发桩 —— 正控用（证明桥**真的**能把 read 档调通，
  // 而不是"什么都拒"的假绿）；生产中这一项是 `tools.ts` 的 `callRpc`。
  sandboxAppCall: async (method: string) => {
    if (method === "project.list") return { projects: [{ id: "p1", path: workspace }] };
    throw Error("sandbox stub 没登记这个方法：" + method);
  },
});

/* ══════════════════════════════════════════════════════════════════════════
 * ①—④：buildExtension 的完整成功路径（真子进程沙箱）
 * ══════════════════════════════════════════════════════════════════════════ */
writeFileSync(sample, "alpha\nbeta\ngamma\n", "utf8");

await check("★ 成功路径：静态校验 + 真子进程沙箱都过 → 返回交接材料，且**不安装**", async () => {
  const report = await buildExtension(draftOf(), options());
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.stage, "sandbox");
  assert.ok(report.draft);
  // 真子进程沙箱真的跑出了结果（3 行）。
  assert.equal(report.draft!.sandboxCapability, "count");
  const dir = workshopDraftDir(workshopRoot, "user.t20-line-counter");
  assert.ok(existsSync(join(dir, WORKSHOP_ENTRY_FILE)), "入口文件必须真的写出来");
  assert.ok(existsSync(join(dir, WORKSHOP_DRAFT_FILE)), "草稿文件必须真的写出来");
  const entry = JSON.parse(readFileSync(join(dir, WORKSHOP_ENTRY_FILE), "utf8"));
  assert.equal(entry.id, "user.t20-line-counter");
  // 回执里的权限说明来自清单（用户卡片上的同一条事实）。
  assert.equal(report.permissions.length, 1);
  assert.match(report.permissions[0]!, /files\.read/);
});

await check("★ 交接材料：requiresUserApproval 恒 true、installConsent 恒 allow-once（AI 拿不到跨重启授权）", async () => {
  const report = await buildExtension(draftOf(), options());
  assert.equal(report.ok, true);
  const handoff = extensionWorkshopInstallHandoff(report.draft!.manifest, "每次保存时备份一份");
  assert.equal(handoff.method, "modules.install");
  assert.equal(handoff.requiresUserApproval, true);
  const input = handoff.input as Record<string, unknown>;
  assert.equal(input.installConsent, "allow-once", "AI 的交接材料绝不能携带 allow-always");
  assert.equal(input.confirmReadAccess, true);
  assert.equal(input.confirmExecutableCode, true);
  assert.deepEqual(input.grantedPermissions, ["files.read"]);
  // 交接材料必须能直接通过 `ModuleInstallSchema`（它就是下一步 app_api_call 的入参）。
  ModuleInstallSchema.parse(input);
  // 第二道闸：就算这段材料被篡改成 allow-always，Agent 通道（无桌面发送方）也只能拿到 allow-once。
  assert.equal(resolveInstallDecision({ installConsent: "allow-always" }, {}), "allow-once");
  // 交接材料里**没有任何**"已批准"字段 —— 拿不到的东西伪造不出来。
  assert.equal("approved" in input, false);
  assert.equal("installConsentDecision" in input, false);
  assert.ok(handoff.instructions.some((line) => line.includes("本人确认")));
});

/* ══════════════════════════════════════════════════════════════════════════
 * ② 恶意生成负控：blocked 档声明 / 未知权限 / 语法错 / 动态方法名
 * ══════════════════════════════════════════════════════════════════════════ */
await check("★ 负控：清单权限不在 36 个内 → 静态拒绝（点名那个权限）", async () => {
  const report = await buildExtension(draftOf({ id: "user.t20-bad-perm", permissions: ["files.read", "unsafe.exploit"] }), options());
  assert.equal(report.ok, false);
  assert.equal(report.stage, "static");
  assert.ok(report.issues.some((issue) => issue.includes("unsafe.exploit")), JSON.stringify(report.issues));
  // 静态失败不落盘：草稿目录不存在。
  assert.equal(existsSync(workshopDraftDir(workshopRoot, "user.t20-bad-perm")), false);
});

await check("★ 负控：程序字面量调用 blocked 档方法 → 静态拒绝（不进沙箱、不落盘）", async () => {
  const source = '({ count: async () => { await mcode.api.call("claude.approve", {}); return { lines: 0 }; } })';
  const report = await buildExtension(draftOf({ id: "user.t20-blocked", source }), options());
  assert.equal(report.ok, false);
  assert.equal(report.stage, "static");
  assert.ok(report.issues.some((issue) => issue.includes("claude.approve") && issue.includes("blocked")), JSON.stringify(report.issues));
  assert.equal(existsSync(workshopDraftDir(workshopRoot, "user.t20-blocked")), false);
});

await check("★ 负控：程序字面量调用不可委托方法（workflowEngine.load）→ 静态拒绝", async () => {
  // `workflowEngine.load` 是 `APP_METHOD_PERMISSIONS` 里映射为 null 的那一条（T19 核实），
  // 也是"够得到但不是权限不足"的唯一 danger 例子。它必须走「不可委托」分支，而不是
  // blocked 分支（后者是 policy.ts 的 BLOCKED 表）。
  assert.equal(policyFor("workflowEngine.load").level, "danger");
  const source = '({ count: async () => { await mcode.api.call("workflowEngine.load", {}); return { lines: 0 }; } })';
  const diagnosis = diagnoseExtensionDraft((draftOf({ source }) as { manifest: unknown }).manifest);
  assert.equal(diagnosis.ok, false);
  assert.ok(diagnosis.forbidden.some((entry) => entry.method === "workflowEngine.load" && entry.reason.includes("不可委托")), JSON.stringify(diagnosis.forbidden));
  // blocked 表里的方法走 blocked 分支（措辞不同，但同样是硬拒）。
  const blockedSource = '({ count: async () => { await mcode.api.call("modules.setPermissions", {}); return { lines: 0 }; } })';
  const blocked = diagnoseExtensionDraft((draftOf({ source: blockedSource }) as { manifest: unknown }).manifest);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.forbidden.some((entry) => entry.method === "modules.setPermissions" && entry.reason.includes("blocked")), JSON.stringify(blocked.forbidden));
});

await check("★ 负控：程序源码语法错 → 静态拒绝（编译期就拦，不浪费沙箱）", async () => {
  const report = await buildExtension(draftOf({ id: "user.t20-syntax", source: "({ count: async ( => ({}) })" }), options());
  assert.equal(report.ok, false);
  assert.equal(report.stage, "static");
  assert.ok(report.issues.some((issue) => issue.includes("无法编译")), JSON.stringify(report.issues));
});

await check("★ 已知边界：动态拼接的方法名静态看不出来 —— 回执**如实说明**，不假装拦住", async () => {
  const source = '({ count: async () => { const m = "claude." + "approve"; await mcode.api.call(m, {}); return { lines: 0 }; } })';
  const diagnosis = diagnoseExtensionDraft((draftOf({ source }) as { manifest: unknown }).manifest);
  assert.equal(diagnosis.ok, true, "动态方法名不应在静态被误拒（运行期 T19 闸门兜底）");
  assert.ok(diagnosis.warnings.some((warning) => warning.includes("无法静态识别")), JSON.stringify(diagnosis.warnings));
});

await check("★ danger 档字面量调用**不**在静态拒，但回执明确写「每次都要用户本人批准」", async () => {
  const source = '({ count: async () => { await mcode.api.call("git.push", {}); return { lines: 0 }; } })';
  const diagnosis = diagnoseExtensionDraft((draftOf({ source, permissions: ["files.read", "git.write"] }) as { manifest: unknown }).manifest);
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.issues));
  assert.ok(diagnosis.warnings.some((warning) => warning.includes("git.push") && warning.includes("每次")), JSON.stringify(diagnosis.warnings));
});

await check("★ 负控：未声明所需权限的只读 RPC 只在静态警告；沙箱里真调会被桥拒", async () => {
  const source = '({ count: async () => { const p = await mcode.api.call("project.list", {}); return { lines: Array.isArray(p.projects) ? p.projects.length : 0 }; } })';
  const diagnosis = diagnoseExtensionDraft((draftOf({ source }) as { manifest: unknown }).manifest);
  assert.equal(diagnosis.ok, true);
  assert.ok(diagnosis.warnings.some((warning) => warning.includes("project.read")), JSON.stringify(diagnosis.warnings));
  // 真沙箱：清单没声明 project.read → 桥拒 → 冒烟失败（沙箱不会比清单更宽）。
  const report = await buildExtension(draftOf({ id: "user.t20-missing-perm", source }), options());
  assert.equal(report.ok, false);
  assert.equal(report.stage, "sandbox");
  assert.ok(report.issues.some((issue) => issue.includes("project.read")), JSON.stringify(report.issues));
});

await check("★ 正控：声明了所需权限的 read 档 RPC 在真沙箱里**真的调通**（桥不是「什么都拒」的假绿）", async () => {
  // 清单声明 project.read；程序在子进程里 mcode.api.call("project.list") → 宿主的沙箱
  // 桥校验（read 档 + 权限已声明）→ 派发桩返回一个项目 → 结果真的回到 ModuleResult。
  const source = '({ count: async () => { const p = await mcode.api.call("project.list", {}); return { lines: Array.isArray(p.projects) ? p.projects.length : -1 }; } })';
  const report = await buildExtension(draftOf({ id: "user.t20-read-rpc", source, permissions: ["files.read", "project.read"] }), options());
  assert.equal(report.ok, true, JSON.stringify(report));
  // 再证明桥拒绝面仍然存在：同一条程序但清单少了 project.read → 沙箱失败。
  const missing = await buildExtension(draftOf({ id: "user.t20-read-rpc-missing", source, permissions: ["files.read"] }), options());
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.includes("project.read")), JSON.stringify(missing.issues));
});

await check("★ 沙箱桥：write / danger 档在安装前的试跑里一律拒（不能预支用户批准）", async () => {  const source = '({ count: async () => { await mcode.api.call("file.writeFile", { path: "x", content: "y" }); return { lines: 0 }; } })';
  const report = await buildExtension(draftOf({ id: "user.t20-write-in-sandbox", source, permissions: ["files.read", "files.write"] }), options());
  assert.equal(report.ok, false);
  assert.equal(report.stage, "sandbox");
  assert.ok(report.issues.some((issue) => issue.includes("read 档")), JSON.stringify(report.issues));
  const danger = '({ count: async () => { await mcode.api.call("git.push", {}); return { lines: 0 }; } })';
  const dangerReport = await buildExtension(draftOf({ id: "user.t20-danger-in-sandbox", source: danger, permissions: ["files.read", "git.write"] }), options());
  assert.equal(dangerReport.ok, false);
  assert.ok(dangerReport.issues.some((issue) => issue.includes("git.push") && issue.includes("danger")), JSON.stringify(dangerReport.issues));
});

/* ══════════════════════════════════════════════════════════════════════════
 * ③ 沙箱失败 → 不装机、回滚干净、无残留
 * ══════════════════════════════════════════════════════════════════════════ */
await check("★ 沙箱冒烟失败 → 草稿清空、状态记一次失败（不装机、无残留目录）", async () => {
  const failing: WorkshopSandbox = async () => { throw Error("子进程崩了（测试注入）"); };
  const id = "user.t20-sandbox-fail";
  const report = await buildExtension(draftOf({ id, source: "({ count: async () => ({ lines: 1 }) })" }), options(), failing);
  assert.equal(report.ok, false);
  assert.equal(report.stage, "sandbox");
  assert.ok(report.issues.some((issue) => issue.includes("子进程崩了")), JSON.stringify(report.issues));
  // 不留半个扩展：草稿目录没了，但**状态文件在**（修复计数必须留得住）。
  assert.equal(existsSync(workshopDraftDir(workshopRoot, id)), false);
  const state = await readWorkshopState(workshopRoot, id);
  assert.equal(state?.attempts, 1);
  assert.equal(state?.status, "drafting");
});

await check("★ 沙箱超时/越界也是失败：真子进程读未授权路径 → ERR_ACCESS_DENIED → 不装机", async () => {
  // 程序试图读一个不在授权资源里的文件（绝对路径直接写死）—— 子进程的 --permission
  // 只放行本次资源，这条读会拿到 ERR_ACCESS_DENIED。
  const source = '({ count: async () => { const c = require("node:fs").readFileSync("C:\\\\Windows\\\\win.ini", "utf8"); return { lines: c.length }; } })';
  const id = "user.t20-sandbox-denied";
  const report = await buildExtension(draftOf({ id, source }), options());
  assert.equal(report.ok, false);
  assert.equal(report.stage, "sandbox");
  assert.match(JSON.stringify(report.issues), /ERR_ACCESS_DENIED|denied|未获授权|Access to this API/i);
  assert.equal(existsSync(workshopDraftDir(workshopRoot, id)), false);
});

/* ══════════════════════════════════════════════════════════════════════════
 * ⑥ 修复上限：连续失败到上限 → repair_exhausted，交还用户
 * ══════════════════════════════════════════════════════════════════════════ */
await check("★ 修复循环超过上限（" + MAX_REPAIR_ATTEMPTS + " 次）→ 停下并报告，不再消耗沙箱", async () => {
  const id = "user.t20-exhaust";
  let sandboxRuns = 0;
  const failing: WorkshopSandbox = async () => { sandboxRuns += 1; throw Error("仍然失败"); };
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const report = await buildExtension(draftOf({ id, source: "({ count: async () => ({ lines: 1 }) })" }), options(), failing);
    assert.equal(report.ok, false);
    assert.equal((await readWorkshopState(workshopRoot, id))?.attempts, attempt);
  }
  const runsAtLimit = sandboxRuns;
  const exhausted = await buildExtension(draftOf({ id, source: "({ count: async () => ({ lines: 1 }) })" }), options(), failing);
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.stage, "budget");
  assert.ok(exhausted.issues.some((issue) => issue.includes("修复次数已用完")), JSON.stringify(exhausted.issues));
  assert.equal(sandboxRuns, runsAtLimit, "超限之后不得再跑沙箱（不再花用户的钱与时间）");
  assert.equal((await readWorkshopState(workshopRoot, id))?.status, "repair_exhausted");
});

await check("★ 全局草稿数上限（" + WORKSHOP_MAX_DRAFTS + "）：换模块 id 也绕不过去", async () => {
  const otherRoot = join(temp, "workshop-budget");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(otherRoot, { recursive: true });
  for (let index = 0; index < WORKSHOP_MAX_DRAFTS; index++) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(otherRoot, `user.t20-filler-${index}`), { recursive: true });
  }
  let ran = false;
  const sandbox: WorkshopSandbox = async () => { ran = true; return { lines: 1 }; };
  const report = await buildExtension(draftOf({ id: "user.t20-one-more" }), { workshopRoot: otherRoot, sandboxWorkspace: () => ({ projectPath: workspace, path: sample }) }, sandbox);
  assert.equal(report.ok, false);
  assert.equal(report.stage, "budget");
  assert.ok(report.issues.some((issue) => issue.includes("达到上限")), JSON.stringify(report.issues));
  assert.equal(ran, false, "预算不足时不得跑沙箱");
});

await check("★ 一次成功生成把 attempts 归零（修复预算不跨成功会话累积）", async () => {
  const id = "user.t20-reset";
  const failing: WorkshopSandbox = async () => { throw Error("先失败一次"); };
  await buildExtension(draftOf({ id }), options(), failing);
  assert.equal((await readWorkshopState(workshopRoot, id))?.attempts, 1);
  const report = await buildExtension(draftOf({ id }), options());
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal((await readWorkshopState(workshopRoot, id))?.attempts, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
 * ④⑤⑥ 真 ModuleHost：拒绝不装机 / 装上可调 / 卸载对账回滚 / danger 逐次审批
 * ══════════════════════════════════════════════════════════════════════════ */
interface HostFixture {
  host: ModuleHost;
  approvals: ActionApprovalRequest[];
  dispatched: Array<{ moduleId: string; method: string }>;
  modules: ModuleManifest[];
  archive: string | null;
  persistCalls: number;
}
function makeHost(approve?: (request: ActionApprovalRequest) => Promise<void>): HostFixture {
  const fixture: HostFixture = { host: null as unknown as ModuleHost, approvals: [], dispatched: [], modules: [], archive: null, persistCalls: 0 };
  fixture.host = new ModuleHost({
    authorize: async (resource) => { await resolveModuleResource(resource, (path) => path === workspace); },
    resolveResource: (resource) => resolveModuleResource(resource, (path) => path === workspace),
    verifyProgram: async () => ({ ok: true }),
    persist: async (manifests) => { fixture.modules = [...manifests]; fixture.persistCalls += 1; },
    readModulePermissions: () => fixture.archive,
    persistModulePermissions: async (text) => { fixture.archive = text; },
    invokeAppCall: async (moduleId, method) => { fixture.dispatched.push({ moduleId, method }); return { ok: true }; },
    requestApproval: async (request) => {
      fixture.approvals.push(request);
      if (approve) return approve(request);
    },
    bootId: "boot-t20-0001",
  });
  for (const capability of fileCapabilities((path) => path === workspace)) fixture.host.register(capability);
  return fixture;
}
const storedManifest = (host: ModuleHost, id: string): ModuleManifest => {
  const modules = (host as unknown as { modules: Map<string, ModuleManifest> }).modules;
  const manifest = modules.get(id);
  assert.ok(manifest, "stored manifest missing: " + id);
  return manifest;
};
const callFromExtension = (host: ModuleHost, manifest: ModuleManifest, method: string, resource: ModuleResource) =>
  (host as unknown as {
    callAppFromExtension(manifest: ModuleManifest, method: string, input: unknown, resource: ModuleResource, signal: AbortSignal): Promise<unknown>;
  }).callAppFromExtension(manifest, method, {}, resource, new AbortController().signal);

await check("★ 用户拒绝 → 不装机（deny 在任何写盘之前；工坊从不自己调 install）", async () => {
  const built = await buildExtension(draftOf({ id: "user.t20-consent" }), options());
  assert.equal(built.ok, true);
  const handoff = extensionWorkshopInstallHandoff(built.draft!.manifest);
  const input = ModuleInstallSchema.parse(handoff.input);
  const fixture = makeHost();
  const before = { modules: fixture.modules.length, persist: fixture.persistCalls, archive: fixture.archive };
  await rejects("deny 安装", () => fixture.host.install(input.manifest, input.grantedPermissions, "deny"), /拒绝/);
  assert.equal(fixture.persistCalls, before.persist);
  assert.equal(fixture.archive, before.archive);
  assert.equal(fixture.host.catalog().modules.some((module) => module.id === "user.t20-consent"), false);
});

await check("★ 装上后可经宿主调用（query 能力真子进程返回 ModuleResult）；卸载后无残留", async () => {
  const built = await buildExtension(draftOf({ id: "user.t20-installed" }), options());
  assert.equal(built.ok, true);
  const handoff = extensionWorkshopInstallHandoff(built.draft!.manifest);
  const input = ModuleInstallSchema.parse(handoff.input);
  const fixture = makeHost();
  await fixture.host.install(input.manifest, input.grantedPermissions, "allow-once");
  const reply = await fixture.host.invoke({
    moduleId: "user.t20-installed", contributionId: "count", requestId: "run-1",
    resource: { projectPath: workspace, path: sample },
  });
  assert.equal(reply.type, "result");
  if (reply.type === "result") assert.equal(reply.value.lines, 4, "sample 文件 4 行（3 行内容 + 末尾换行）");
  // ⑥ 对账：宿主里有这个模块 → 工坊记成 installed（可回滚点 = 当前版本）。
  const reconciled = await reconcileWorkshopStates(workshopRoot, [{ id: "user.t20-installed", version: "1.0.0" }]);
  assert.deepEqual(reconciled.errors, []);
  const state = await readWorkshopState(workshopRoot, "user.t20-installed");
  assert.equal(state?.status, "installed");
  assert.equal(state?.installed?.version, "1.0.0");
  // 卸载（既有 remove 事务）+ 对账 → rolledBack，草稿目录清掉（无残留）。
  await fixture.host.remove("user.t20-installed");
  const after = await reconcileWorkshopStates(workshopRoot, []);
  assert.deepEqual(after.errors, []);
  assert.equal((await readWorkshopState(workshopRoot, "user.t20-installed"))?.status, "rolledBack");
  assert.equal(existsSync(workshopDraftDir(workshopRoot, "user.t20-installed")), false, "卸载后草稿目录不得残留");
  // 幂等：再对账一次不报错。
  assert.deepEqual((await reconcileWorkshopStates(workshopRoot, [])).errors, []);
});

await check("★ danger 档断言：工坊装出来的扩展触发的危险操作仍然逐次审批（T19 的闸没有被绕开）", async () => {
  // 扩展声明 files.read + git.write；程序里调 git.push（danger 档）。
  const source = '({ count: async () => { await mcode.api.call("git.push", {}); return { lines: 1 }; } })';
  // 沙箱里 danger 被桥拒 → 为了让扩展能装上，这里直接用清单（不经 buildExtension）。
  const manifest: ModuleManifest = ModuleManifestSchema.parse({
    ...(draftOf({ id: "user.t20-danger", source, permissions: ["files.read", "git.write"] }) as { manifest: object }).manifest,
  });
  const fixture = makeHost();
  await fixture.host.install(manifest, ["files.read", "git.write"], "allow-once");
  const stored = storedManifest(fixture.host, manifest.id);
  const resource: ModuleResource = { projectPath: workspace, path: sample };
  for (let index = 0; index < 3; index++) await callFromExtension(fixture.host, stored, "git.push", resource);
  assert.equal(fixture.approvals.length, 3, "每一次 git.push 都要一条审批（没有始终允许）");
  assert.ok(fixture.approvals.every((request) => request.scope === "danger" && request.method === "git.push"));
  assert.equal(fixture.dispatched.length, 3);
  // 拒绝时零派发。
  const denying = makeHost(async () => { throw Error("用户拒绝"); });
  await denying.host.install(manifest, ["files.read", "git.write"], "allow-once");
  const denyingStored = storedManifest(denying.host, manifest.id);
  const error = await rejects("用户拒绝 danger", () => callFromExtension(denying.host, denyingStored, "git.push", resource), /用户拒绝/);
  assert.equal(moduleRefusal(error)?.code, "approval_denied");
  assert.equal(denying.dispatched.length, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
 * ⑧ 生产装配：invokeAppTool 的 extension_build 在写盘之前弹审批卡
 * ══════════════════════════════════════════════════════════════════════════ */
await check("★ 不经确认不写盘：extension_build 在用户拒绝时**没有**写任何草稿", async () => {
  // 让工坊根指到临时目录：MCODE_SMOKE_DATA_ROOT 由 build.mjs 注入。
  const denied: ProviderContext = {
    requestApproval: async () => ({ allow: false }),
    getPermissionMode: () => "default",
  } as unknown as ProviderContext;
  const before = existsSync(workshopRoot) ? readdirSync(workshopRoot).length : 0;
  const result = await invokeAppTool("extension_build", { draft: draftOf({ id: "user.t20-denied-write" }) }, "t20", denied);
  assert.ok(result.isError, "审批被拒 → 工具返回错误");
  const text = JSON.stringify(result.content);
  assert.match(text, /拒绝/);
  const after = existsSync(workshopRoot) ? readdirSync(workshopRoot).length : 0;
  assert.equal(after, before, "用户拒绝时工坊根下不得多出任何目录");
  assert.equal(existsSync(workshopDraftDir(workshopRoot, "user.t20-denied-write")), false);
});

await check("★ extension_build 是 write 档工具（不在只读集合里），extension_workshop_status 是只读", async () => {
  assert.equal(APP_READONLY_TOOLS.has("extension_build"), false);
  assert.equal(APP_READONLY_TOOLS.has("extension_workshop_status"), true);
  assert.ok(appMcpTools().some((tool) => tool.name === "extension_build"));
  assert.ok(appMcpTools().some((tool) => tool.name === "extension_workshop_status"));
  // Codex / Pi 的工具发现走 isAppToolName（按表成员资格）；两个新工具都必须被发现。
  assert.ok(isAppToolName("extension_build"));
  assert.ok(isAppToolName("extension_workshop_status"));
  // 审批说明能看懂"要干什么、要什么权限"（不是源码 diff）。
  const summary = extensionInstallApprovalSummary({ manifest: (draftOf() as { manifest: unknown }).manifest });
  assert.match(summary, /files\.read/);
  assert.match(summary, /扩展 ID/);
});

await check("★ 只读状态投影：不写盘、不建目录，宿主目录为准", async () => {
  const projection = projectWorkshopStatus(workshopRoot, [{ id: "user.t20-line-counter", version: "1.0.0" }]);
  const entry = projection.entries.find((item) => item.moduleId === "user.t20-line-counter");
  assert.ok(entry, JSON.stringify(projection.entries));
  assert.equal(entry!.status, "installed");
  assert.equal(entry!.installedVersion, "1.0.0");
  // 状态说装过、宿主里没有 → 投影成 rolledBack（并在待清理列表里点名）。
  const hostless = projectWorkshopStatus(workshopRoot, []);
  const dropped = hostless.entries.find((item) => item.moduleId === "user.t20-sandbox-fail");
  assert.ok(dropped);
  assert.equal(dropped!.status, "drafting", "drafting 状态的模块不受宿主目录影响");
});

/* ══════════════════════════════════════════════════════════════════════════
 * ⑨ 不新增 RPC：源码级判据（RpcMap / 生成物 / 权限表都不该为工坊改动）
 * ══════════════════════════════════════════════════════════════════════════ */
await check("★ 不新增 RPC：工坊的出口只有 appMcpTools() 的既有工具面 + 既有 modules.* 通道", async () => {
  const contract = readFileSync(join(process.cwd(), "../../packages/contracts/src/extensionWorkshop.ts"), "utf8");
  const module = readFileSync(join(process.cwd(), "src/main/modules/extensionWorkshop.ts"), "utf8");
  // 工坊模块不 import electron / 不碰 RpcMap / 不自己调 ModuleHost.install。
  assert.equal(/from\s+["']electron["']/.test(module), false, "工坊模块必须保持纯 Node（不进 electron 图）");
  assert.equal(/rpcMap|RpcMap/.test(module), false, "工坊不应触碰 RpcMap");
  assert.equal(/\.install\s*\(/.test(module), false, "工坊模块绝不能调用 ModuleHost.install");
  assert.match(contract, /不新增 RpcMap/);
  // 交接材料指向的是**既有** RPC 名。
  assert.ok(/modules\.install/.test(contract));
});

/* ══════════════════════════════════════════════════════════════════════════
 * ⑩ 回执可读性（AI 拿到的是能照抄的东西）
 * ══════════════════════════════════════════════════════════════════════════ */
await check("★ 回执摘要包含阶段 / 问题 / 权限（AI 能照抄给用户）", async () => {
  const report = await buildExtension(draftOf({ id: "user.t20-copy", permissions: ["files.read", "unsafe.nope"] }), options());
  const summary = summarizeWorkshopReport(report);
  assert.match(summary, /未通过（阶段：static）/);
  assert.match(summary, /unsafe\.nope/);
  const okReport = await buildExtension(draftOf({ id: "user.t20-copy-ok" }), options());
  assert.match(summarizeWorkshopReport(okReport), /可以安装（还差用户确认）/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 收尾
 * ══════════════════════════════════════════════════════════════════════════ */
clearRpcHandlers();
try { rmSync(temp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不改变结果 */ }
console.log("extension-workshop-smoke:" + String(passed) + "/" + String(passed + failed) + " 通过");
if (failed > 0) process.exitCode = 1;
