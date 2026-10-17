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
import { countBudgetExhausted } from "@contracts/policyEngine";
import { policyFor } from "@main/appControl/policy.js";
import { evaluate, isDeleteScopeWidened, invalidationsFor, scenePlanCoreIntent } from "@main/appControl/policyEngine.js";
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
  isGrantShape,
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

/* ── 2c. ★ 计划级授权绑定(ARC-004 × ARC-002 / MC-058):批准的是**计划**,不是 spec ── */
{
  // 「用户点头」之后 spec 被偷改 —— 批准覆盖的是批准那一刻编译出的 plan.digest。
  // 重编译得到的 digest 不同 → 核心意图 scenePlan 与之不符 → 批准立即失效。
  const planA = "sceneplan:fnv1a:aaaa1111";
  const planB = "sceneplan:fnv1a:bbbb2222";
  const boundCore = scenePlanCoreIntent({ digest: planA });
  eq("scenePlanCoreIntent 钉住的正是计划 digest", boundCore.scenePlan, planA);

  // 同一个计划 → 放行(不误伤)。
  const same = evaluate(
    intent("workflow.save", { scenePlan: planA }),
    grant({ allowedActions: ["workflow.save"], scopedCore: { scenePlan: planA } }),
    ctx(),
  );
  eq("★ 计划未变(同一 digest)→ 放行", same.verdict, "allow");

  // ★ 承重红例:spec 偷改 → 重编译得到 planB → 用旧批准跑新计划必须被拦。
  const tampered = evaluate(
    intent("workflow.save", { scenePlan: planB }),
    grant({ allowedActions: ["workflow.save"], scopedCore: { scenePlan: planA } }),
    ctx(),
  );
  eq("★ 计划被偷改(digest 变)→ 重新批准(旧批准不能跑新计划)", tampered.verdict, "require-approval");
  check("★ 点名被改动的核心字段 scenePlan", tampered.invalidatedBy?.includes("scenePlan") === true, tampered.invalidatedBy);

  // 无场景绑定(普通单动作授权)不受这条约束 —— 别把没声明 scenePlan 的也误判。
  const plain = evaluate(
    intent("file.write", { projectPath: "/repo/a" }),
    grant({ allowedActions: ["file.write"] }),
    ctx(),
  );
  eq("普通单动作授权(未绑计划)→ 不受 scenePlan 判据约束", plain.verdict, "allow");

  // invalidationsFor 层:两处都缺 = 相等(不误报);一处有 = 变更。
  eq("invalidationsFor:两边都没 scenePlan → 不算变更", invalidationsFor({}, {}).includes("scenePlan"), false);
  eq("invalidationsFor:批准有绑定、请求没带 → 算变更", invalidationsFor({}, { scenePlan: planA }).includes("scenePlan"), true);
  eq("invalidationsFor:digest 不同 → 算变更", invalidationsFor({ scenePlan: planB }, { scenePlan: planA }).includes("scenePlan"), true);
  // 顺序稳定:scenePlan 排在既有字段之后(不动既有断言的顺序判据)。
  const inv = invalidationsFor({ projectPath: "/b", scenePlan: planB }, { projectPath: "/a", scenePlan: planA });
  check("invalidationsFor:scenePlan 排在 projectPath 之后(顺序稳定)", inv[0] === "projectPath" && inv[1] === "scenePlan", inv);
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

/* ══ 13c. ★ MC-021:claimUse / releaseUse —— 原子领取与退还(派发前领取 → 结算) ══
 *
 * 缺口:执行点从前是「检查(evaluate)→ 派发 → 事后 recordUse」,`maxCount=1` 的两条并发
 * 操作在任何一次记账**之前**都过检查;且记账在业务结果解码之前,业务明确拒绝(没执行)也
 * 被计为已用。`claimUse` 把「检查 + 递增 + 落盘」收进一个同步临界区;`releaseUse` 是确定
 * 没执行时的退还口。这里钉纯逻辑层:额度判据走**同一份** `countBudgetExhausted`、两个
 * mutation 都走同一道 `commit` 落盘口。 */
{
  // ① 领取:未用尽 → 领取成功(计数 +1);用尽 → 抛(调用方据此不执行)。
  const s = new GrantStore({ newId: () => "g-claim" });
  const g = s.issueGrant(decision({ maxCount: 1 }), USER, 1_000);
  const claimed = s.claimUse(g.grantId, 0, 1_100);
  eq("★ MC-021 领取:未用尽 → 领取成功且计数 +1", claimed.usedCount, 1);
  eq("领取后 store 里也是 1", s.get(g.grantId, 1_100)?.usedCount, 1);
  let exhaustedThrew = false;
  try { s.claimUse(g.grantId, 0, 1_150); } catch (e) { exhaustedThrew = e instanceof GrantStoreError && (e as Error).message.includes("次数上限"); }
  eq("★ MC-021 领取:已用尽再领 → 抛 GrantStoreError(次数上限)", exhaustedThrew, true);
  // ② 退还:确定没执行 → 计数退回去,同一额度还能再领(「拒绝不吃额度」)。
  const refunded = s.releaseUse(g.grantId);
  eq("★ MC-021 退还:usedCount 回到 0", refunded.usedCount, 0);
  const reclaimed = s.claimUse(g.grantId, 0, 1_200);
  eq("★ MC-021 退还:退还后还能再领(额度真的还回来了)", reclaimed.usedCount, 1);
  // ③ 退还下限 0:没领过就退 → 不产生负计数。
  const s2 = new GrantStore({ newId: () => "g-refund0" });
  const g2 = s2.issueGrant(decision(), USER, 1_000);
  eq("★ MC-021 退还:未领取时退还 → 钳在 0(不出负计数)", s2.releaseUse(g2.grantId).usedCount, 0);
  // ④ 预算维度:领取也核预算、退还也退预算(对称)。
  const s3 = new GrantStore({ newId: () => "g-claimbud" });
  const g3 = s3.issueGrant(decision({ maxBudget: 10 }), USER, 1_000);
  s3.claimUse(g3.grantId, 8, 1_100);
  eq("★ MC-021 预算:领取 cost 累加进 budgetUsed", s3.get(g3.grantId, 1_100)?.budgetUsed, 8);
  let overBudgetThrew = false;
  try { s3.claimUse(g3.grantId, 5, 1_150); } catch (e) { overBudgetThrew = e instanceof GrantStoreError && (e as Error).message.includes("费用上限"); }
  eq("★ MC-021 预算:超预算领取被拒(与 evaluate 同判据)", overBudgetThrew, true);
  s3.releaseUse(g3.grantId, 8);
  eq("★ MC-021 预算:退还同样退回 budgetUsed(对称)", s3.get(g3.grantId, 1_200)?.budgetUsed, 0);
  // ⑤ 失效授权不能领取(与 recordUse 同一道有效性判据);退还**不查有效性**(账本修正)。
  const s4 = new GrantStore({ newId: () => "g-claimrev" });
  const g4 = s4.issueGrant(decision(), USER, 1_000);
  s4.claimUse(g4.grantId, 0, 1_100);
  s4.revoke(g4.grantId);
  let claimRevokedThrew = false;
  try { s4.claimUse(g4.grantId, 0, 1_150); } catch (e) { claimRevokedThrew = e instanceof GrantStoreError; }
  eq("★ MC-021 领取:撤销后领取被拒", claimRevokedThrew, true);
  // ⚠️ 撤销后 `get` 一律回 null(无效即查不出),故退还结果从返回值看,不从 get 看。
  let releaseAfterRevokeThrew = false;
  let releaseAfterRevokeCount: number | null = null;
  try { releaseAfterRevokeCount = s4.releaseUse(g4.grantId).usedCount ?? -1; } catch { releaseAfterRevokeThrew = true; }
  check("★ MC-021 退还:撤销后仍可退还(账本修正,不查有效性)", releaseAfterRevokeThrew === false && releaseAfterRevokeCount === 0, { threw: releaseAfterRevokeThrew, usedCount: releaseAfterRevokeCount });
  // ⑥ 领取落盘失败 → 抛且内存计数不动(与 MC-017 三个 mutation 同一道 commit 口)。
  const box: { grants: Grant[] | null } = { grants: null };
  let failNext = false;
  const s5 = new GrantStore({ persist: { load: () => box.grants, save: (gs) => { if (failNext) throw new Error("disk error (injected)"); box.grants = gs; } }, newId: () => "g-claimdisk" });
  const g5 = s5.issueGrant(decision({ maxCount: 3 }), USER, 1_000);
  failNext = true;
  let claimDiskThrew = false;
  try { s5.claimUse(g5.grantId, 0, 1_100); } catch (e) { claimDiskThrew = (e as Error).message.includes("disk error"); }
  eq("★ MC-021 领取落盘失败 → 抛错", claimDiskThrew, true);
  eq("★ MC-021 领取落盘失败 → 内存计数不动(仍 0,不分裂)", s5.get(g5.grantId, 1_200)?.usedCount, 0);
  failNext = false;
  s5.claimUse(g5.grantId, 0, 1_300);
  eq("MC-021 领取正控:磁盘正常时领取真的落上", s5.get(g5.grantId, 1_400)?.usedCount, 1);
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

/* ══ 16b. ★ MC-016:授权 id 重启后不重用、撞名不覆盖 ══
 *
 * 旧行为:`seq` 每次构造都从 0 起、载入持久授权只 `Map.set` 不恢复计数器 → 默认生成器
 * `grant-<seq>` 重启后第一批新授权又是 `grant-1`,**覆盖掉**载入的那份(连审批作用域、
 * 撤销状态一起丢)。两道防线各测一遍:① 恢复 seq;② 占用守卫(自定义生成器绕不过)。 */
{
  // 用同一份持久层模拟「重启」:第一次签发 grant-1,重开后再签,必须是 grant-2(不撞)。
  const box: { grants: Grant[] | null } = { grants: null };
  const persist = { load: () => box.grants, save: (gs: Grant[]) => { box.grants = gs; } };
  const s1 = new GrantStore({ persist }); // 默认生成器 grant-<seq>
  const g1 = s1.issueGrant(decision({ allowedActions: ["a"] }), USER, 1_000);
  eq("MC-016:首次签发得到 grant-1", g1.grantId, "grant-1");
  const s2 = new GrantStore({ persist }); // 模拟重启
  const g2 = s2.issueGrant(decision({ allowedActions: ["b"] }), USER, 2_000);
  eq("★ MC-016:重启后再签发不再重用 grant-1(得到 grant-2)", g2.grantId, "grant-2");
  eq("★ MC-016:重启后旧授权仍在、未被覆盖", s2.get(g1.grantId, 1_500)?.allowedActions[0], "a");
  eq("★ MC-016:两份授权同时存在(持久层两条)", box.grants?.length, 2);

  // ② 占用守卫:自定义生成器返回一个已被占用的 id → 拒,不静默覆盖。
  const s3 = new GrantStore({ newId: () => "same" });
  const g3 = s3.issueGrant(decision(), USER, 1_000);
  eq("MC-016 正控:首次用自定义 id 签得出", g3.grantId, "same");
  let collisionThrew = false;
  try {
    s3.issueGrant(decision({ allowedActions: ["z"] }), USER, 1_000);
  } catch (e) {
    collisionThrew = e instanceof GrantStoreError;
  }
  eq("★ MC-016:自定义生成器撞名 → 抛 GrantStoreError(不覆盖)", collisionThrew, true);
  eq("★ MC-016:撞名被拒后原授权一字未动", s3.get("same", 1_500)?.allowedActions[0], "file.write");
}

/* ══ 16b-2. ★ MC-016 验收条件「并发两个实例」:跨实例写入不静默覆盖 ══
 *
 * 16b 的占用守卫只在**同一个 `GrantStore` 实例**里看得见。验收条件点名的另一面是两个
 * 实例(多开 / 两个进程)各自载入同一份 grants.json 后签发 —— 后写的那份会把先写那份
 * **整份盖掉**,而两边都以为成功。修法在 `fileGrantPersist.save`:写前重读磁盘、比较
 * 基线 id 集合;发现第三方写入时,撞名的本次新 id 一律拒写(《碰撞必须拒绝并保留旧记录》),
 * 不撞名则把对方的授权并进候选全量再写(不丢别人的)。 */
{
  // 两个 `fileGrantPersist` 适配器共享同一份 blob = 两个进程共享同一个 grants.json。
  const blob = memBlob();
  const persistA = fileGrantPersist(blob);
  const a = new GrantStore({ persist: persistA, newId: (n) => `a-${n}` });
  a.issueGrant(decision({ allowedActions: ["a"] }), USER, 1_000); // A 写入 a-1

  // B 在 A 之后才载入(拿到 a-1 的基线),再签 b-1 → 写到磁盘上两条都在。
  const persistB = fileGrantPersist(blob);
  const b = new GrantStore({ persist: persistB, newId: (n) => `b-${n}` });
  b.issueGrant(decision({ allowedActions: ["b"] }), USER, 1_000);
  eq("★ MC-016 并发实例:后载入的实例写入时并上先写的授权(不整份覆盖)", parseGrants(blob.peek()).map((g) => g.grantId).sort().join(","), "a-1,b-1");

  // 现在 A 的内存基线还是只有 a-1,B 又写了 b-1 —— A 再签发必须看见 b-1 并保留它。
  a.issueGrant(decision({ allowedActions: ["a"] }), USER, 1_000); // a-2
  eq(
    "★ MC-016 并发实例:旧基线实例再写时也保留对方授权(两个方向都不静默覆盖)",
    parseGrants(blob.peek()).map((g) => g.grantId).sort().join(","),
    "a-1,a-2,b-1",
  );

  // 撞名:第三个实例用**同一个 id 生成器**,在 A 的基线之外拿到 a-1 → 拒写,旧记录一字未动。
  const persistC = fileGrantPersist(blob);
  const c = new GrantStore({ persist: persistC, newId: () => "c-1" });
  // 模拟“另一个实例抢先写了 c-1”。
  const stranger = new GrantStore({
    persist: fileGrantPersist(blob),
    newId: () => "c-1",
  });
  stranger.issueGrant(decision({ allowedActions: ["other"] }), USER, 1_000);
  const before = blob.peek();
  let crossThrew = false;
  try {
    c.issueGrant(decision({ allowedActions: ["mine"] }), USER, 1_000);
  } catch (e) {
    crossThrew = (e as Error).message.includes("授权写入冲突");
  }
  eq("★ MC-016 并发实例:与第三方已写 id 撞名 → 拒写(不覆盖)", crossThrew, true);
  eq("★ MC-016 并发实例:拒写后磁盘逐字未动", blob.peek(), before);
  eq("★ MC-016 并发实例:拒写后另一实例那枚授权的所有者内容仍在", parseGrants(blob.peek()).find((g) => g.grantId === "c-1")?.allowedActions[0], "other");
}

/* ══ 16c. ★ MC-017:落盘失败 → 内存与磁盘不分裂 ══
 *
 * 旧行为:三个 mutation 都「先改内存、后 flush」,`save` 抛错时留下一份「内存里有、磁盘上
 * 没有」的活授权(或撤销/记账的内存态与磁盘态不符)。修法:先 save 候选全量,成功后才发布
 * 成活动快照(唯一提交点 `commit`)。下面逐条注入抛错的 save。 */
{
  const disk = () => { throw new Error("disk error (injected)"); };
  // ① 签发时落盘失败 → 抛错,且内存里**没有**这份授权(不能有活授权却落不了盘)。
  {
    const store = new GrantStore({ newId: () => "g-x", persist: { load: () => null, save: disk } });
    let threw = false;
    try { store.issueGrant(decision(), USER, 1_000); } catch (e) { threw = e instanceof GrantStoreError || (e as Error).message.includes("disk error"); }
    eq("★ MC-017:签发落盘失败 → 抛错", threw, true);
    eq("★ MC-017:签发落盘失败 → 内存里没有那份活授权(不分裂)", store.get("g-x", 1_500), null);
  }
  // ② 撤销时落盘失败 → 抛错,且内存里它**仍是活的**(与磁盘一致,重启不会"权限又回来")。
  {
    const box: { grants: Grant[] | null } = { grants: null };
    let failNext = false;
    const persist = { load: () => box.grants, save: (gs: Grant[]) => { if (failNext) throw new Error("disk error (injected)"); box.grants = gs; } };
    const store = new GrantStore({ persist, newId: () => "g-rev" });
    const g = store.issueGrant(decision(), USER, 1_000);
    failNext = true;
    let threw = false;
    try { store.revoke(g.grantId); } catch (e) { threw = (e as Error).message.includes("disk error"); }
    eq("★ MC-017:撤销落盘失败 → 抛错", threw, true);
    eq("★ MC-017:撤销落盘失败 → 内存里仍是活的(磁盘没改,内存也不改)", store.get(g.grantId, 1_500)?.revoked, false);
  }
  // ③ 记账时落盘失败 → 抛错,且内存计数**不动**(否则 maxCount 又能被无限用)。
  {
    const box: { grants: Grant[] | null } = { grants: null };
    let failNext = false;
    const persist = { load: () => box.grants, save: (gs: Grant[]) => { if (failNext) throw new Error("disk error (injected)"); box.grants = gs; } };
    const store = new GrantStore({ persist, newId: () => "g-use" });
    const g = store.issueGrant(decision({ maxCount: 3 }), USER, 1_000);
    failNext = true;
    let threw = false;
    try { store.recordUse(g.grantId, 0, 1_100); } catch (e) { threw = (e as Error).message.includes("disk error"); }
    eq("★ MC-017:记账落盘失败 → 抛错", threw, true);
    eq("★ MC-017:记账落盘失败 → 内存计数不动(仍 0)", store.get(g.grantId, 1_500)?.usedCount, 0);
  }
  // 正控:落盘正常时三个 mutation 都真的生效(证明上面的"不动"不是"根本没实现")。
  {
    const box: { grants: Grant[] | null } = { grants: null };
    const store = new GrantStore({ persist: { load: () => box.grants, save: (gs: Grant[]) => { box.grants = gs; } }, newId: () => "g-ok" });
    const g = store.issueGrant(decision(), USER, 1_000);
    store.recordUse(g.grantId, 0, 1_100);
    eq("MC-017 正控:落盘正常时账记上了", store.get(g.grantId, 1_500)?.usedCount, 1);
    eq("MC-017 正控:落盘正常时撤销真生效", store.revoke(g.grantId), true);
  }
}

/* ══ 16d. ★ MC-020:可选额度字段的严格形状校验 —— 坏记录隔离且不能绕过额度判定 ══
 *
 * 缺口(台账 MC-020 + 第四轮 E1 红例):`isGrantShape` 只查必需字段 ——
 * `{ maxCount: 1, usedCount: "bad" }` 能通过形状校验进 Map,而 `countBudgetExhausted`
 * 是 `used >= limit` 的**数值比较**:`'bad' >= 1` 为 false → 「已用尽」被误读成
 * 「还有余额」,额度判定整体被绕过。修法:可选字段缺席合法,在场必须是布尔 / 有限非负
 * 整数;坏记录**隔离**(不进 Map、不参与判定)并**显式报告**(console.warn,不静默丢)。
 *
 * 判据立在**可观察行为**上:坏值记录被隔离(parseGrants 不收、重开 store 查不到)
 * 且同一份数据在修复前本会放行的额度判定,现在不再放行。 */
{
  // ── ① 合法边界仍正常参与判定(maxCount=0 / =1 / 用完)──
  {
    // maxCount=0 = 「一次都不许」(0 >= 0 立即用尽)—— 不是「不限」。
    const s0 = new GrantStore({ newId: () => "g-zero" });
    const g0 = s0.issueGrant(decision({ allowedActions: ["project.create"], scopedCore: {}, maxCount: 0 }), USER, 1_000);
    eq("★ MC-020 边界:maxCount=0 立即用尽 → 不放行(不是当成不限)", evaluate(intent("project.create", {}), s0.get(g0.grantId, 1_100), ctx({ now: 1_100 })).verdict !== "allow", true);

    // maxCount=1:用之前放行,记一次之后用尽。
    const s1 = new GrantStore({ newId: () => "g-one" });
    const g1 = s1.issueGrant(decision({ allowedActions: ["project.create"], scopedCore: {}, maxCount: 1 }), USER, 1_000);
    eq("★ MC-020 边界:maxCount=1 未用时仍放行", evaluate(intent("project.create", {}), s1.get(g1.grantId, 1_100), ctx({ now: 1_100 })).verdict, "allow");
    s1.recordUse(g1.grantId, 0, 1_150);
    eq("★ MC-020 边界:maxCount=1 用尽后 → 不放行", evaluate(intent("project.create", {}), s1.get(g1.grantId, 1_200), ctx({ now: 1_200 })).verdict !== "allow", true);

    // 未声明 maxCount = 不限,永不用尽(不误伤)。
    const sN = new GrantStore({ newId: () => "g-none" });
    const gN = sN.issueGrant(decision({ allowedActions: ["project.create"], scopedCore: {} }), USER, 1_000);
    sN.recordUse(gN.grantId, 0, 1_100);
    sN.recordUse(gN.grantId, 0, 1_200);
    eq("★ MC-020 边界:未声明 maxCount → 记多少次仍放行(不限)", evaluate(intent("project.create", {}), sN.get(gN.grantId, 1_300), ctx({ now: 1_300 })).verdict, "allow");
  }

  // ── ② 坏值 → 形状判否(逐值)──
  {
    const bad = (over: Record<string, unknown>): unknown => ({ ...grant(), ...over });
    const cases: Array<[string, unknown]> = [
      ["usedCount='bad'", bad({ usedCount: "bad" })],
      ["usedCount=NaN", bad({ usedCount: Number.NaN })],
      ["usedCount=-1", bad({ usedCount: -1 })],
      ["usedCount=1.5(小数)", bad({ usedCount: 1.5 })],
      ["maxCount='bad'", bad({ maxCount: "bad" })],
      ["maxCount=NaN", bad({ maxCount: Number.NaN })],
      ["maxCount=-1", bad({ maxCount: -1 })],
      ["maxCount=1.5(小数)", bad({ maxCount: 1.5 })],
      ["maxBudget='x'", bad({ maxBudget: "x" })],
      ["budgetUsed='x'", bad({ budgetUsed: "x" })],
      ["budgetUsed=-1", bad({ budgetUsed: -1 })],
      ["revoked='no'", bad({ revoked: "no" })],
      ["revoked=0(数值冒充布尔)", bad({ revoked: 0 })],
    ];
    for (const [name, fixture] of cases) {
      eq(`★ MC-020 坏值判否:${name}`, isGrantShape(fixture), false);
    }
    // 正控:合法可选值仍判对(边界与缺省都不误伤)。
    eq("MC-020 正控:maxCount=0 合法(边界)", isGrantShape(bad({ maxCount: 0 })), true);
    eq("MC-020 正控:usedCount=0 / revoked=false 合法", isGrantShape(bad({ usedCount: 0, revoked: false })), true);
    eq("MC-020 正控:可选字段全缺席仍合法(向后兼容)", isGrantShape(grant()), true);
  }

  // ── ③ ★ 承重:坏记录整体隔离,不能绕过额度判定 ──
  {
    // 根因本身也是可观察事实:`countBudgetExhausted` 是数值比较,坏值 `'bad'` 会被误读。
    // (这条钉的是「为什么必须隔离」—— 比较口不会替我们挡住坏类型。)
    eq("★ MC-020 根因:countBudgetExhausted(1, 'bad') 判「没用尽」(数值比较误读)", countBudgetExhausted(1, "bad" as unknown as number), false);
    // 修复前:`{ maxCount:1, usedCount:'bad' }` 通过形状校验进来;`'bad' >= 1` 为 false
    // → `countBudgetExhausted` 判「没用尽」→ evaluate 放行 —— 额度被绕过。
    // 修复后:该条被隔离(parseGrants 不收、重开 store 查不到)→ 没有可用的 grant
    // → evaluate 不放行。
    const brokenJson = JSON.stringify({
      version: 1,
      grants: [grant({ allowedActions: ["project.create"], scopedCore: {}, maxCount: 1, usedCount: "bad" as unknown as number })],
    });
    const kept = parseGrants(brokenJson);
    eq("★ MC-020:usedCount='bad' 的记录被隔离(parseGrants 不收)", kept.length, 0);

    const blob: BlobIO = { read: () => brokenJson, write: () => {} };
    const store = new GrantStore({ persist: fileGrantPersist(blob) });
    eq("★ MC-020:坏记录重开后 store 里没有它(get 查不到)", store.get("g1", 1_500), null);
    const d = evaluate(intent("project.create", {}), store.findBoundFor(intent("project.create", {}), 1_500), ctx({ now: 1_500 }));
    eq("★ MC-020:额度判定不再被绕过(修复前 'bad'>=1 为 false → 放行;现在不放行)", d.verdict !== "allow", true);

    // 对照:同一份 JSON 把 usedCount 换成合法值 1 → 形状合法、被收、且额度逻辑正确判「已用尽」。
    const goodJson = JSON.stringify({
      version: 1,
      grants: [grant({ allowedActions: ["project.create"], scopedCore: {}, maxCount: 1, usedCount: 1 })],
    });
    const keptGood = parseGrants(goodJson);
    eq("MC-020 对照:合法 usedCount=1 仍被收(不误伤)", keptGood.length, 1);
    const goodStore = new GrantStore({ persist: fileGrantPersist({ read: () => goodJson, write: () => {} }) });
    const dGood = evaluate(intent("project.create", {}), goodStore.get("g1", 1_500), ctx({ now: 1_500 }));
    eq("MC-020 对照:合法已用尽的记录仍参与判定(判不放行)", dGood.verdict !== "allow", true);
  }

  // ── ④ ★ 显式报告:坏记录被隔离这件事必须报出来(不静默丢,硬规矩 3)──
  {
    const captured: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    try {
      parseGrants(JSON.stringify({ version: 1, grants: [grant({ usedCount: "bad" as unknown as number }), grant({ grantId: "g-ok" })] }));
    } finally {
      console.warn = origWarn;
    }
    check("★ MC-020:坏记录被隔离时有显式报告(console.warn,不静默)", captured.some((m) => m.includes("已隔离")), captured);
    check("★ MC-020:报告点名文件与第几条", captured.some((m) => m.includes("grants.json") && m.includes("第 1 条")), captured);
  }
}


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
