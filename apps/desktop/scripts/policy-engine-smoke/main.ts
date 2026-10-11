/**
 * Headless smoke for the **PolicyEngine 判定核**(ARC-004 实施步 ①)。
 *
 * 计划级授权的判定提成了纯函数 `evaluate(intent, grant|null, context)`。本套钉住它的
 * **失效矩阵**:
 *   - 正常:只读不问;写档在有效授权内放行;无授权先批准。
 *   - ★ **红例(旧行为)**:核心意图(项目路径 / MCP 命令+env / Git 远端 / SSH 主机键 /
 *     删除范围扩大)被改动后,现有**按方法**的政策本会放行(方法仍是 write),新引擎必须
 *     重新要求批准。
 *   - 越界(动作不在授权表内)、过期、撤销、配置摘要变、超次数、超预算 → 不放行。
 *   - 自批自:批准主体不是用户本人 → 拒;授权由 agent 铸造 → 拒。
 *   - TOCTOU:批准之后 intent 被换掉 → 批准失效。
 *   - danger 每次要本人批;blocked 从不放行 —— 即便手上有授权。
 *   - 没有 `allowAll` 逃生口(源码断言,剥注释后看)。
 *
 * Run: scripts/policy-engine-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionIntent,
  ActorRef,
  CoreIntent,
  Grant,
  PolicyContext,
} from "@contracts/policyEngine";
import { policyFor } from "@main/appControl/policy.js";
import { evaluate, isDeleteScopeWidened, invalidationsFor } from "@main/appControl/policyEngine.js";

const failures: string[] = [];
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
const eq = (name: string, actual: unknown, expected: unknown): void =>
  check(name, Object.is(actual, expected), { actual, expected });

/* ── 夹具 ── */
const USER: ActorRef = { kind: "user", id: "u1" };
const AGENT: ActorRef = { kind: "agent", id: "a1" };

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({ now: 1_000, requester: AGENT, approver: USER, ...over });

const intent = (method: string, core: CoreIntent = {}, over: Partial<ActionIntent> = {}): ActionIntent => ({ method, core, ...over });

const grant = (over: Partial<Grant> = {}): Grant => ({
  grantId: "g1",
  sceneId: "scene-1",
  allowedActions: ["project.create", "file.write", "file.rename"],
  scopedCore: { projectPath: "/repo/a" },
  configHash: "cfg-1",
  expiresAt: 2_000,
  approvalSource: USER,
  ...over,
});

/* ── 1. 正常路径 ── */
{
  const d = evaluate(intent("project.list"), null, ctx());
  eq("只读动作:直接放行(不问)", d.verdict, "allow");
  eq("只读动作:兼容档是 read", d.compatibilityLevel, "read");
}
{
  const d = evaluate(intent("notification.focusSession"), null, ctx());
  eq("界面动作:直接放行", d.verdict, "allow");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant(), ctx());
  eq("写档·在有效授权范围内:放行", d.verdict, "allow");
  eq("写档·放行时点名命中的授权", d.grantId, "g1");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), null, ctx());
  eq("写档·没有授权:要求批准", d.verdict, "require-approval");
}

/* ── 2. ★ 红例:核心意图改变 —— 旧政策会放行,新引擎必须重新批准 ── */
{
  const method = "project.create";
  // 旧行为:按方法分类就是 write;权限模式为 bypass、或用户勾过「始终允许」时,
  // 现有 gateAppAction 会**直接放行**。核心意图此刻已经换了项目路径 —— 旧模型看不见,
  // 新引擎必须拦住。
  eq("红例前提:该方法在现有按方法政策里是 write(旧模型会放行)", policyFor(method).level, "write");
  const d = evaluate(intent(method, { projectPath: "/repo/B" }), grant({ scopedCore: { projectPath: "/repo/A" } }), ctx());
  eq("★ 红例:换了 projectPath → 重新批准(旧模型会静默放行)", d.verdict, "require-approval");
  check("★ 红例:点名被改动的核心字段 projectPath", d.invalidatedBy?.includes("projectPath") === true, d.invalidatedBy);
}
{
  // 同一个 projectPath 照旧放行(别把"没变"也当成变)。
  const d = evaluate(intent("project.create", { projectPath: "/repo/A" }), grant({ scopedCore: { projectPath: "/repo/A" } }), ctx());
  eq("项目路径未变:仍放行(不误伤)", d.verdict, "allow");
}
// 其余四个核心字段的**判定**在 invalidationsFor 里(纯);下面 §2b 再证明引擎确实接了它。
{
  const inv = (w: CoreIntent, g: CoreIntent) => invalidationsFor(w, g);
  check("invalidationsFor:MCP 命令变了 → 点名 mcp", inv({ mcp: { command: "npx @evil/x", envDigest: "e" } }, { mcp: { command: "npx @good/x", envDigest: "e" } }).includes("mcp"));
  check("invalidationsFor:仅 MCP env 摘要变了 → 点名 mcp", inv({ mcp: { command: "c", envDigest: "NEW" } }, { mcp: { command: "c", envDigest: "OLD" } }).includes("mcp"));
  check("invalidationsFor:Git 远端变了 → 点名 gitRemote", inv({ gitRemote: "git@evil:repo.git" }, { gitRemote: "git@github:repo.git" }).includes("gitRemote"));
  check("invalidationsFor:SSH 主机键变了 → 点名 sshHostKey", inv({ sshHostKey: "SHA256:evil" }, { sshHostKey: "SHA256:good" }).includes("sshHostKey"));
  check("invalidationsFor:扩大删除范围 → 点名 deleteScope", inv({ deleteScope: { root: "/x", recursive: true } }, { deleteScope: { root: "/x", recursive: false } }).includes("deleteScope"));
}

/* ── 2b. 引擎确实把非 projectPath 的核心变动也接上(write 档) ── */
{
  // `file.rename` 现有政策里是 write(动词 rename 不在只读词表)。它的核心意图不含
  // projectPath,只动 gitRemote —— 证明引擎不是把 projectPath 写死,而是通用比较 core。
  eq("前提:file.rename 是 write 档(旧模型会放行)", policyFor("file.rename").level, "write");
  const d = evaluate(
    intent("file.rename", { gitRemote: "git@evil:repo.git" }),
    grant({ allowedActions: ["file.rename"], scopedCore: { gitRemote: "git@github:repo.git" } }),
    ctx(),
  );
  eq("★ 换了 Git 远端 → 重新批准", d.verdict, "require-approval");
  check("★ 引擎确实点名 gitRemote(不是写死 projectPath)", d.invalidatedBy?.includes("gitRemote") === true, d.invalidatedBy);
}

/* ── 3. 删除范围:只允许不扩大 ── */
{
  eq("删除范围:批准时没授权删除、现在要删 → 判为扩大", isDeleteScopeWidened(undefined, { root: "/x", recursive: false }), true);
  eq("删除范围:换根 → 扩大", isDeleteScopeWidened({ root: "/x", recursive: false }, { root: "/y", recursive: false }), true);
  eq("删除范围:非递归→递归 → 扩大", isDeleteScopeWidened({ root: "/x", recursive: false }, { root: "/x", recursive: true }), true);
  eq("删除范围:递归→非递归 → 不算扩大(收窄)", isDeleteScopeWidened({ root: "/x", recursive: true }, { root: "/x", recursive: false }), false);
  eq("删除范围:现在不删 → 不算扩大", isDeleteScopeWidened({ root: "/x", recursive: true }, undefined), false);

  const widened = evaluate(
    intent("file.write", { deleteScope: { root: "/lib", recursive: true } }),
    grant({ allowedActions: ["file.write"], scopedCore: { deleteScope: { root: "/lib", recursive: false } } }),
    ctx(),
  );
  eq("★ 扩大删除范围(非递归→递归) → 重新批准", widened.verdict, "require-approval");
  check("★ 引擎点名 deleteScope", widened.invalidatedBy?.includes("deleteScope") === true, widened.invalidatedBy);

  const narrowed = evaluate(
    intent("file.write", { deleteScope: { root: "/lib", recursive: false } }),
    grant({ allowedActions: ["file.write"], scopedCore: { deleteScope: { root: "/lib", recursive: true } } }),
    ctx(),
  );
  eq("收窄删除范围:仍放行", narrowed.verdict, "allow");
}

/* ── 4. 越界 / 过期 / 撤销 / 摘要变 / 超限 ── */
{
  const d = evaluate(intent("session.delete", { projectPath: "/repo/a" }), grant(), ctx());
  eq("越界:动作不在授权表内 → 重新批准", d.verdict, "require-approval");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant({ expiresAt: 999 }), ctx({ now: 1_000 }));
  eq("过期:now 已超过 expiresAt → deny", d.verdict, "deny");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant({ expiresAt: 1_000 }), ctx({ now: 1_000 }));
  eq("过期边界:now === expiresAt 即过期 → deny", d.verdict, "deny");
  const ok = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant({ expiresAt: 1_000 }), ctx({ now: 999 }));
  eq("过期边界:now < expiresAt 仍有效 → allow", ok.verdict, "allow");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant({ revoked: true }), ctx());
  eq("撤销:所有入口一律 deny", d.verdict, "deny");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }, { configHash: "cfg-2" }), grant({ configHash: "cfg-1" }), ctx());
  eq("配置摘要与批准时不一致 → 重新批准", d.verdict, "require-approval");
  const d2 = evaluate(intent("project.create", { projectPath: "/repo/a" }, { configHash: "cfg-1" }), grant({ configHash: "cfg-1" }), ctx());
  eq("配置摘要一致 → 放行", d2.verdict, "allow");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant({ maxCount: 3, usedCount: 3 }), ctx());
  eq("超次数上限 → 重新批准", d.verdict, "require-approval");
  const ok = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant({ maxCount: 3, usedCount: 2 }), ctx());
  eq("未到次数上限 → 放行", ok.verdict, "allow");
}
{
  const d = evaluate(
    intent("project.create", { projectPath: "/repo/a" }, { estimatedCost: 5 }),
    grant({ maxBudget: 10, budgetUsed: 8 }),
    ctx(),
  );
  eq("超费用上限 → 重新批准", d.verdict, "require-approval");
  const ok = evaluate(
    intent("project.create", { projectPath: "/repo/a" }, { estimatedCost: 1 }),
    grant({ maxBudget: 10, budgetUsed: 8 }),
    ctx(),
  );
  eq("未超费用上限 → 放行", ok.verdict, "allow");
}

/* ── 5. 自批自:谁都不能替用户点头 ── */
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant(), ctx({ approver: AGENT }));
  eq("★ 批准主体是 agent → deny(不能自批自)", d.verdict, "deny");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant(), ctx({ approver: { kind: "system", id: "s" } }));
  eq("★ 批准主体是 system → deny", d.verdict, "deny");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), grant({ approvalSource: AGENT }), ctx());
  eq("★ 授权来源是 agent → deny(不能给自己发授权)", d.verdict, "deny");
}
{
  const d = evaluate(intent("project.create", { projectPath: "/repo/a" }), null, ctx({ approver: undefined }));
  eq("缺省批准主体(等用户批):无授权 → 要求批准", d.verdict, "require-approval");
}

/* ── 6. TOCTOU:批准之后 intent 被换掉 ── */
{
  const g = grant({ allowedActions: ["project.create"], scopedCore: { projectPath: "/repo/a", gitRemote: "git@github:repo.git" } });
  const before = evaluate(intent("project.create", { projectPath: "/repo/a", gitRemote: "git@github:repo.git" }), g, ctx());
  eq("TOCTOU 前置:批准时放行", before.verdict, "allow");
  const after = evaluate(intent("project.create", { projectPath: "/repo/a", gitRemote: "git@evil:repo.git" }), g, ctx());
  eq("★ TOCTOU:intent 被换成别的 git remote → 批准失效", after.verdict, "require-approval");
}

/* ── 7. danger / blocked:授权也替代不了 ── */
{
  const d = evaluate(intent("project.delete", { projectPath: "/repo/a" }), grant({ allowedActions: ["project.delete"], scopedCore: { projectPath: "/repo/a" } }), ctx());
  eq("★ danger(删项目):即便有覆盖它的授权也要重新批准", d.verdict, "require-approval");
}
{
  const d = evaluate(intent("plugins.installGit", {}), grant({ allowedActions: ["plugins.installGit"] }), ctx());
  eq("★ danger(装插件):重新批准", d.verdict, "require-approval");
}
{
  const d = evaluate(intent("customModel.getToken", {}), grant({ allowedActions: ["customModel.getToken"] }), ctx());
  eq("★ blocked(读密钥):即便有授权也 deny", d.verdict, "deny");
}

/* ── 8. 失效清单的纯函数 ── */
{
  eq("invalidationsFor:无变化 → 空", invalidationsFor({ projectPath: "/a" }, { projectPath: "/a" }).length, 0);
  const inv = invalidationsFor({ projectPath: "/b", gitRemote: "r2" }, { projectPath: "/a", gitRemote: "r1" });
  eq("invalidationsFor:两个字段各点一次", inv.length, 2);
  check("invalidationsFor:顺序稳定(projectPath 在 gitRemote 前)", inv[0] === "projectPath" && inv[1] === "gitRemote", inv);
}

/* ── 9. 没有 allowAll 逃生口(源码断言,剥注释后看) ── */
{
  const raw = readFileSync(join(process.cwd(), "src/main/appControl/policyEngine.ts"), "utf8");
  // 注释里可以提"没有 allowAll",判据要落在**真的代码标识符**上 —— 先剥掉块注释与行注释。
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("★ policyEngine 里没有 allowAll 逃生口", !/allowAll|allow_all|bypassAll/.test(code));
  check("★ policyEngine 不 import 存储/setting(保持纯函数)", !/from\s+"@main\/store|settingsStore|SettingRepo/.test(code));
  check("★ 判定核里没有直接读系统时钟(Date.now / new Date)", !/Date\.now|new Date\(/.test(code));
}

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
