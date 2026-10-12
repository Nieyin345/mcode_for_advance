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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import {
  GrantStore,
  GrantStoreError,
  isGrantActive,
  type GrantDecision,
  type GrantStorePersist,
} from "@main/appControl/grantStore.js";
import {
  atomicFileBlob,
  fileGrantPersist,
  grantStorePath,
  parseGrants,
  serializeGrants,
  type BlobIO,
} from "@main/appControl/grantStoreFile.js";
import {
  assembleGrantStore,
  getGrantStore,
  setGrantStore,
} from "@main/appControl/grantStoreRuntime.js";

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

/* ══ 10. GrantStore:签发口是唯一的 grant 产地 ══ */
const decision = (over: Partial<GrantDecision> = {}): GrantDecision => ({
  verdict: "allow",
  reason: "用户批准了这个计划。",
  compatibilityLevel: "write",
  sceneId: "scene-1",
  allowedActions: ["file.write", "project.create"],
  scopedCore: { projectPath: "/repo/a" },
  configHash: "cfg-1",
  ttlMs: 1_000,
  ...over,
});
{
  const store = new GrantStore({ newId: () => "g-issued" });
  const g = store.issueGrant(decision(), USER, 1_000);
  eq("签发口:产出的 grant 带 id", g.grantId, "g-issued");
  eq("签发口:过期时刻 = now + ttl", g.expiresAt, 2_000);
  eq("签发口:approvalSource = 签发主体(用户)", g.approvalSource.kind, "user");
  eq("签发口:usedCount 归零", g.usedCount, 0);
}
{
  // **只有用户能签发** —— agent / system 自铸 = 拒。
  const store = new GrantStore();
  let threw = false;
  try {
    store.issueGrant(decision(), AGENT, 1_000);
  } catch (e) {
    threw = e instanceof GrantStoreError;
  }
  eq("★ 签发口:agent 不能给自己发授权(抛 GrantStoreError)", threw, true);
  let threw2 = false;
  try {
    store.issueGrant(decision(), { kind: "system", id: "s" }, 1_000);
  } catch {
    threw2 = true;
  }
  eq("★ 签发口:system 不能签发", threw2, true);
}
{
  // deny 的判定签不出;空动作表 / 非正有效期一律拒 —— 显式报错,不静默产半成品。
  const store = new GrantStore();
  const denies: Array<[string, () => void]> = [
    ["verdict=deny 的动作签不出", () => store.issueGrant(decision({ verdict: "deny" }), USER, 1_000)],
    ["空 allowedActions 签不出", () => store.issueGrant(decision({ allowedActions: [] }), USER, 1_000)],
    ["非正有效期签不出", () => store.issueGrant(decision({ ttlMs: 0 }), USER, 1_000)],
  ];
  for (const [name, fn] of denies) {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = e instanceof GrantStoreError;
    }
    eq(`签发口:${name}`, threw, true);
  }
}

/* ══ 11. GrantStore:存取 / 撤销 / 过期 —— 无效一律查不出 ══ */
{
  const store = new GrantStore({ newId: (n) => `g${n}` });
  const g = store.issueGrant(decision(), USER, 1_000); // expiresAt=2000
  eq("取:有效期内拿得到", store.get(g.grantId, 1_500)?.grantId, "g1");
  eq("取:不存在的 id → null", store.get("nope", 1_500), null);
  eq("取:过期后查不出(null)", store.get(g.grantId, 2_000), null);
  eq("取:过期边界(now==expiresAt)即查不出", store.get(g.grantId, 2_000), null);
  eq("取:过期前一刻还在", store.get(g.grantId, 1_999)?.grantId, "g1");
}
{
  const store = new GrantStore({ newId: () => "gr" });
  const g = store.issueGrant(decision(), USER, 1_000);
  eq("撤销:第一次真翻状态", store.revoke(g.grantId), true);
  eq("撤销:幂等 —— 第二次 no-op", store.revoke(g.grantId), false);
  eq("撤销:不存在的 id 也是安全 no-op", store.revoke("ghost"), false);
  eq("撤销后:查不出(null)", store.get(g.grantId, 1_500), null);
}
{
  // isGrantActive 是 evaluate 的过期判据同源(now < expiresAt 且未撤销)。
  const base: Grant = {
    grantId: "x",
    sceneId: "s",
    allowedActions: ["file.write"],
    scopedCore: {},
    configHash: "c",
    expiresAt: 2_000,
    approvalSource: USER,
  };
  eq("isGrantActive:有效", isGrantActive(base, 1_500), true);
  eq("isGrantActive:过期", isGrantActive(base, 2_000), false);
  eq("isGrantActive:已撤销", isGrantActive({ ...base, revoked: true }, 1_500), false);
}

/* ══ 12. GrantStore:按资源身份查 ══ */
{
  const store = new GrantStore();
  store.issueGrant(decision({ allowedActions: ["file.write"], scopedCore: { sshHostKey: "SHA256:good" } }), USER, 1_000);
  eq(
    "按身份查:动作 + 主机键都匹配 → 命中",
    store.findFor(intent("file.write", { sshHostKey: "SHA256:good" }), 1_500)?.grantId != null,
    true,
  );
  eq(
    "按身份查:主机键被换 → 查不出",
    store.findFor(intent("file.write", { sshHostKey: "SHA256:evil" }), 1_500),
    null,
  );
  eq(
    "按身份查:动作不在表内 → 查不出",
    store.findFor(intent("session.delete", { sshHostKey: "SHA256:good" }), 1_500),
    null,
  );
  eq(
    "按身份查:过期后 → 查不出",
    store.findFor(intent("file.write", { sshHostKey: "SHA256:good" }), 9_999),
    null,
  );
}

/* ══ 13. ★ 串起来:GrantStore × evaluate —— 拿到 grant 放行;revoke 后不放行 ══ */
{
  const store = new GrantStore({ newId: () => "g-chain" });
  const g = store.issueGrant(
    decision({ allowedActions: ["file.write"], scopedCore: { projectPath: "/repo/a" } }),
    USER,
    1_000,
  );
  // ① 从 store 取回有效 grant → evaluate 放行。
  const live = evaluate(intent("file.write", { projectPath: "/repo/a" }), store.get(g.grantId, 1_200), ctx({ now: 1_200 }));
  eq("★ 串起来:拿到有效 grant → evaluate 放行", live.verdict, "allow");
  eq("★ 串起来:放行时点名命中的授权 id", live.grantId, "g-chain");
  // ② revoke → store 查不出 → evaluate 收到 null → 不再放行。
  store.revoke(g.grantId);
  const after = evaluate(intent("file.write", { projectPath: "/repo/a" }), store.get(g.grantId, 1_200), ctx({ now: 1_200 }));
  eq("★ 串起来:revoke 后 store 查不出 → evaluate 不再放行", after.verdict === "allow", false);
  // ③ 过期 → store 查不出 → evaluate 不再放行。
  const store2 = new GrantStore({ newId: () => "g-exp" });
  const g2 = store2.issueGrant(decision({ allowedActions: ["file.write"], scopedCore: {} }), USER, 1_000); // expiresAt 2000
  const expired = evaluate(intent("file.write", {}), store2.get(g2.grantId, 2_500), ctx({ now: 2_500 }));
  eq("★ 串起来:过期后 store 查不出 → evaluate 不再放行", expired.verdict === "allow", false);
  // ④ 反向对照:直接把**已撤销**的 grant 塞给 evaluate(绕过 store)→ 同样 deny(双保险)。
  const direct = evaluate(intent("file.write", { projectPath: "/repo/a" }), { ...g, revoked: true }, ctx({ now: 1_200 }));
  eq("★ 串起来:即便绕过 store 把撤销的 grant 塞进 evaluate → deny", direct.verdict, "deny");
}

/* ══ 13b. ★ recordUse:次数 / 预算真的被记账(否则 maxCount/maxBudget 是死字段) ══ */
{
  // 承重红例:批了 3 次,记够 3 次后 evaluate 就不再放行;没有记账口时 usedCount 恒 0,
  // 授权可无限次执行 —— 这正是「计划级授权」最核心的那条约束。
  const store = new GrantStore({ newId: () => "g-used" });
  const g = store.issueGrant(decision({ allowedActions: ["project.create"], scopedCore: { projectPath: "/repo/a" }, maxCount: 3 }), USER, 1_000);
  const probe = (now: number) => evaluate(intent("project.create", { projectPath: "/repo/a" }), store.get(g.grantId, now), ctx({ now }));
  eq("记账前:第 1 次仍放行", probe(1_100).verdict, "allow");
  store.recordUse(g.grantId, 0, 1_100);
  eq("记账口:usedCount +1", store.get(g.grantId, 1_100)?.usedCount, 1);
  store.recordUse(g.grantId, 0, 1_200);
  store.recordUse(g.grantId, 0, 1_300);
  eq("记满 3 次:usedCount = 3", store.get(g.grantId, 1_300)?.usedCount, 3);
  // ★ 承重:evaluate 现在读到 3 → 达上限,不再放行(旧行为恒 0 → 永远放行)。
  check("★ 记满次数后 evaluate 不再放行(旧行为恒 0 → 无限次)", probe(1_400).verdict !== "allow", probe(1_400));
  // 预算:cost 累加进 budgetUsed,超上限后不放行。
  const s2 = new GrantStore({ newId: () => "g-bud" });
  const g2 = s2.issueGrant(decision({ allowedActions: ["project.create"], scopedCore: { projectPath: "/repo/a" }, maxBudget: 10 }), USER, 1_000);
  s2.recordUse(g2.grantId, 8, 1_100);
  eq("记账口:cost 累加进 budgetUsed", s2.get(g2.grantId, 1_100)?.budgetUsed, 8);
  check("预算内仍放行(8 + 1 ≤ 10)", evaluate({ ...intent("project.create", { projectPath: "/repo/a" }), estimatedCost: 1 }, s2.get(g2.grantId, 1_100), ctx({ now: 1_100 })).verdict === "allow");
  check("★ 记满预算后 evaluate 不再放行", evaluate({ ...intent("project.create", { projectPath: "/repo/a" }), estimatedCost: 5 }, s2.get(g2.grantId, 1_100), ctx({ now: 1_100 })).verdict !== "allow");
  // 没有 maxBudget 的授权不记费用(不养恒增的死字段),但次数照记。
  const s3 = new GrantStore({ newId: () => "g-nobud" });
  const g3 = s3.issueGrant(decision(), USER, 1_000);
  s3.recordUse(g3.grantId, 99, 1_100);
  eq("无 maxBudget:不记费用(cost 不累加进 budgetUsed)", s3.get(g3.grantId, 1_100)?.budgetUsed, 0);
  eq("无 maxBudget:次数照记", s3.get(g3.grantId, 1_100)?.usedCount, 1);
  // 撤销 / 过期 / 不存在 → 拒绝记账(执行点不该在无效授权下记一笔)。
  const s4 = new GrantStore({ newId: () => "g-bad" });
  const g4 = s4.issueGrant(decision(), USER, 1_000);
  s4.revoke(g4.grantId);
  let revokeThrew = false;
  try { s4.recordUse(g4.grantId, 0, 1_100); } catch (e) { revokeThrew = e instanceof GrantStoreError; }
  eq("★ 撤销后记账被拒(抛 GrantStoreError)", revokeThrew, true);
  let missingThrew = false;
  try { s4.recordUse("g-nope", 0, 1_100); } catch (e) { missingThrew = e instanceof GrantStoreError; }
  eq("不存在的授权记账被拒", missingThrew, true);
  const s5 = new GrantStore({ newId: () => "g-exp" });
  const g5 = s5.issueGrant(decision(), USER, 1_000); // expiresAt 2000
  let expThrew = false;
  try { s5.recordUse(g5.grantId, 0, 2_500); } catch (e) { expThrew = e instanceof GrantStoreError; }
  eq("★ 过期后记账被拒", expThrew, true);
  // 记账要落盘(经持久化接口)—— 重启后 usedCount 不归零。
  const box2: { grants: Grant[] | null } = { grants: null };
  const s6 = new GrantStore({ newId: () => "g-persist", persist: { load: () => box2.grants, save: (gs) => { box2.grants = gs; } } });
  const g6 = s6.issueGrant(decision({ maxCount: 3 }), USER, 1_000);
  s6.recordUse(g6.grantId, 0, 1_100);
  const re = new GrantStore({ persist: { load: () => box2.grants, save: () => {} } });
  eq("★ 记账随持久化落盘(重启后 usedCount 不归零)", re.get(g6.grantId, 1_200)?.usedCount, 1);
}

/* ══ 14. 可注入持久化:只认窄接口,不拉 sql.js ══ */
{
  const box: { grants: Grant[] | null } = { grants: null };
  const persist: GrantStorePersist = {
    load: () => box.grants,
    save: (grants) => {
      box.grants = grants;
    },
  };
  const store = new GrantStore({ persist, newId: () => "persisted" });
  const g = store.issueGrant(decision(), USER, 1_000);
  check("持久化:签发即落盘(经窄接口)", box.grants?.length === 1, box.grants?.length);
  // 新 store 从同一持久层载入 → 拿得到同一份 grant。
  const reopened = new GrantStore({ persist });
  eq("持久化:重开后仍取得到", reopened.get(g.grantId, 1_500)?.grantId, "persisted");
}

/* ══ 15. 源码断言:GrantStore 不 import electron/sql;没有把假授权当 Grant ══ */
{
  const raw = readFileSync(join(process.cwd(), "src/main/appControl/grantStore.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("★ GrantStore 不 import electron", !/from\s+"electron/.test(code));
  check("★ GrantStore 不 import sql.js / 存储层", !/from\s+"[^"]*sql|require\("sql\.js|@main\/store|settingsStore/.test(code));
  // 判据落在**代码标识符**上:不许出现 allowAll / 也不许把 ApprovalBridge 的按名 Set 冒充 grant。
  check("★ GrantStore 里没有 allowAll 逃生口", !/allowAll|allow_all|bypassAll/.test(code));
  // 唯一签发口:`Grant` 对象字面量只在 issueGrant 内构造 —— 用只在构造点出现的
  // `approvalSource:`(参数 `grantId: string` 之类不会命中)当探针,别处不许手搓。
  const buildSites = [...code.matchAll(/approvalSource:\s*\{/g)].length;
  check("★ Grant 对象只在签发口构造(唯一 approvalSource 字面量点在 issueGrant)", buildSites === 1);
}

/* ══ 16. ★ 持久化落盘:重启后撤销 / 过期仍生效 ══ */
// 真落盘边界:`grantStoreFile.ts` 把 `GrantStorePersist` 落在**独立 JSON 文件**上
// (不是 SettingRepo —— 那张表整体进出「导入设置」,ARC-004 明令授权状态不得放可导入 setting)。
// 这里用**可注入的 get/set 桩**(`BlobIO`,内存对象)测不变量,绝不去碰用户数据根。
const memBlob = (): BlobIO & { peek: () => string | null } => {
  let text: string | null = null;
  return { read: () => text, write: (t) => { text = t; }, peek: () => text };
};
{
  // 签发 → 落盘 → 用同一份 blob 重开(模拟重启)→ 仍取得到。
  const blob = memBlob();
  const store = new GrantStore({ persist: fileGrantPersist(blob), newId: () => "g-persist" });
  const g = store.issueGrant(decision(), USER, 1_000); // expiresAt=2000
  check("落盘:签发即写真文件(blob 非空)", blob.peek() !== null && blob.peek()!.length > 0, blob.peek()?.slice(0, 5));
  const reopened = new GrantStore({ persist: fileGrantPersist(blob) });
  eq("落盘:重启后仍取得到(过期前)", reopened.get(g.grantId, 1_500)?.grantId, "g-persist");
  eq("★ 落盘:重启后过期时刻仍带回来(get@2500 → null)", reopened.get(g.grantId, 2_500), null);
}
{
  // ★ 承重:revoke 后 save → 重启 load 回来**仍不活跃**。
  const blob = memBlob();
  const store = new GrantStore({ persist: fileGrantPersist(blob), newId: () => "g-rev" });
  const g = store.issueGrant(decision(), USER, 1_000);
  eq("撤销前:有效", store.get(g.grantId, 1_500)?.grantId, "g-rev");
  store.revoke(g.grantId); // 触发 flush → 写盘
  const reopened = new GrantStore({ persist: fileGrantPersist(blob) });
  eq("★ 落盘:revoke 后重启查不出(null)", reopened.get(g.grantId, 1_500), null);
  eq("★ 落盘:revoke 后重启按资源身份也查不出", reopened.findFor(intent("file.write", { projectPath: "/repo/a" }), 1_500), null);
}
{
  // 坏 JSON / 形状不对 → 当空 store,**不崩**(fail-safe:查不出 → 回到重新批准)。
  eq("坏数据:非 JSON → 空", parseGrants("{ not json").length, 0);
  eq("坏数据:null(文件不存在)→ 空", parseGrants(null).length, 0);
  eq("坏数据:版本不符 → 空", parseGrants(JSON.stringify({ version: 999, grants: [grant()] })).length, 0);
  eq("坏数据:grants 不是数组 → 空", parseGrants(JSON.stringify({ version: 1, grants: "nope" })).length, 0);
  // 逐条:形状对的那条留下,形状不对的丢掉(丢一条授权只会收紧)。
  const mixed = JSON.stringify({ version: 1, grants: [grant({ grantId: "ok" }), { grantId: 42 }, null] });
  const kept = parseGrants(mixed);
  eq("坏数据:混入坏条目 → 只留合法那条", kept.length, 1);
  eq("坏数据:留下的是合法 id", kept[0]?.grantId, "ok");
  // 一个坏文件重开出来的 store 是空的、且不抛。
  const badBlob: BlobIO = { read: () => "{ broken", write: () => {} };
  const s = new GrantStore({ persist: fileGrantPersist(badBlob) });
  eq("坏数据:重开后 store 为空(不崩)", s.get("anything", 1_500), null);
}
{
  // **真落盘**:走 `atomicFileBlob` + 临时目录(不是用户数据根),证明它真的写到了磁盘。
  const dir = mkdtempSync(join(tmpdir(), "mcode-grants-"));
  const file = grantStorePath(dir);
  const store = new GrantStore({ persist: fileGrantPersist(atomicFileBlob(file)), newId: () => "g-disk" });
  const g = store.issueGrant(decision(), USER, 1_000);
  check("真落盘:文件真的在磁盘上", existsSync(file), file);
  check("真落盘:路径在 <数据根>/appControl/grants.json 下", file.endsWith(join("appControl", "grants.json")), file);
  const reopened = new GrantStore({ persist: fileGrantPersist(atomicFileBlob(file)) });
  eq("真落盘:真重启后仍取得到", reopened.get(g.grantId, 1_500)?.grantId, "g-disk");
  // 序列化是纯函数:不含注释、只留数据,且原样带出 expiresAt / revoked。
  const env = JSON.parse(serializeGrants([g]));
  eq("序列化:带 version 信封", env.version, 1);
  eq("序列化:原样带出 expiresAt", env.grants[0].expiresAt, g.expiresAt);
}

/* ══ 17. 源码断言:落盘层不 import electron / sql;授权不落可导入 setting ══ */
{
  const raw = readFileSync(join(process.cwd(), "src/main/appControl/grantStoreFile.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("★ 落盘层不 import electron", !/from\s+"electron/.test(code));
  check("★ 落盘层不 import sql.js / 存储层", !/from\s+"[^"]*sql|require\("sql\.js|@main\/store|settingsStore|SettingRepo/.test(code));
  // 授权**不**放进可导入的普通 setting —— 复用共享的 atomicWrite(落盘实现只有一份)。
  check("★ 授权不落 SettingRepo(用 atomicWrite 写独立文件)", /atomicWrite\(/.test(code));
}

/* ══ 18. ★ 装配点:GrantStore 装到启动路径上(单例口 + 真读数据根下的 grants.json) ══ */
// 题面要求:装配后 `getGrantStore()` 拿到的是**同一个实例**(wiring 真的接上了);
// 且它读的是**数据根下的 grants.json**(不是别处)。装配点是**可注入 dataRoot 的纯函数**
// (像 grantStoreFile.ts 那样窄),无头 smoke 传临时目录即可,绝不碰用户数据根。
{
  // 复位:未装配时读取口给到的是一个内存版单例(能签发,只是不落盘)。
  setGrantStore(null);
  const before = getGrantStore();
  check("装配前:getGrantStore() 已给到一个可用单例(内存版)", before instanceof GrantStore, typeof before);

  // 真装配到一个临时数据根。
  const dir = mkdtempSync(join(tmpdir(), "mcode-grants-wire-"));
  const store = assembleGrantStore(dir);
  eq("★ 装配后:getGrantStore() 拿到的是同一个实例(接线真的接上了)", getGrantStore() === store, true);

  // 通过单例口签发 → 必须**真落到数据根下的 appControl/grants.json**。
  const g = getGrantStore().issueGrant(decision({ allowedActions: ["file.write"], scopedCore: { projectPath: "/repo/a" } }), USER, 1_000);
  const file = grantStorePath(dir);
  check("★ 装配后:授权真落到 <数据根>/appControl/grants.json", existsSync(file), file);
  check("★ 装配后:落点就是数据根下那一份(不是别处)", file === join(dir, "appControl", "grants.json"), file);

  // 再从**同一数据根**装配一次(模拟重启)→ 单例换成新实例,但读得到先前落盘的那份。
  const store2 = assembleGrantStore(dir);
  check("★ 重启装配:单例换成新实例", getGrantStore() === store2 && store2 !== store, true);
  eq("★ 重启装配:从数据根读回先前落盘的授权", store2.get(g.grantId, 1_500)?.grantId, g.grantId);

  // 复位口:传 null 回到全新的内存版(用例间隔离,不留前一份的状态)。
  setGrantStore(null);
  const fresh = getGrantStore();
  eq("复位:setGrantStore(null) 后是新内存版(读不回旧的)", fresh.get(g.grantId, 1_500), null);
}

/* ══ 19. 源码断言:装配点不 import electron;单例只有一个读取口 ══ */
{
  const raw = readFileSync(join(process.cwd(), "src/main/appControl/grantStoreRuntime.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("★ 装配点不 import electron", !/from\s+"electron/.test(code));
  check("★ 装配点不 import sql.js / 存储层", !/from\s+"[^"]*sql|require\("sql\.js|@main\/store|settingsStore|SettingRepo/.test(code));
  // 落点由 grantStoreFile 的 grantStorePath 决定(数据根下 appControl/grants.json)。
  check("★ 装配点复用 grantStorePath(落点单一事实源)", /grantStorePath\(/.test(code));
  // 唯一 `new GrantStore(` 出现在装配 / 复位路径上(读取口 getGrantStore 不另造实例)。
  const ctorSites = [...code.matchAll(/new GrantStore\(/g)].length;
  check("★ 装配点里 new GrantStore 只出现在装配/复位默认上", ctorSites === 3, ctorSites);
}

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
