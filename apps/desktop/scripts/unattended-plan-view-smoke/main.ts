/**
 * 无人值守任务计划**渲染端**的回归网(MC-001 —— 后端全通、用户入口为零)。
 *
 * 判据全在 `src/renderer/components/settings/unattendedPlanView.ts` 那批**纯函数**上 ——
 * 不碰 DOM / store / api,esbuild 打包后直接 node 跑(与 `scene-deploy-view-smoke` 同款)。
 *
 * ## 钉死的判据(每条对应一个"看着对、其实错"的坑)
 *
 *  1. **本地预判与签发口同一条界**:空计划 / 空操作行 / `maxCount < 条数` / TTL 越界
 *     各自报出来(**一次报全**,不是遇到第一个就停)。
 *  2. **批准入参不含 actor / grantId**:签发主体是治理事实,只能由宿主写死;形状里
 *     出现这两个键就是「调用方能自填身份」的洞。
 *  3. **执行入参只给 grantId**:授权内容(`grant` / `scopedCore` / …)一个字段都不许有。
 *  4. **编辑即作废授权**:改任何计划正文(项目 / 操作行 / TTL / 上限)后 `grant = null` ——
 *     界面必须收回「执行」,不让用户拿一枚绑旧计划的授权去撞 `no_grant`。
 *  5. **至少保留一行操作**:删到最后一行时 reducer 不响应(空计划签不出)。
 *  6. **跨重启视图排序**:可续跑的排前面(有事可做的先看见)。
 *
 * ## 静态 backstop(源码正则)
 *
 *  面板真的**接了**入口(`unattendedPlans.list` 走 useRpc、`unattended.approve` /
 *  `unattended.run` 显式 `await`)、真的挂在 `GovernancePanel` 里、而它挂在 `SettingsPage`
 *  的 `scene-deploy` 一节 —— 三层链条任何一环断掉都红。**只声明不接线** = 台账判过的
 *  「形式上的 IPC 入口 ≠ 用户能点」,这条 backstop 专防它复发。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildUnattendedApproveInput,
  buildUnattendedRunInput,
  canApproveUnattended,
  canRunUnattended,
  initialUnattendedPlanState,
  newOperationRow,
  newUnattendedPlanId,
  sortPendingPlans,
  unattendedPlanReducer,
  validateUnattendedDraft,
  UNATTENDED_DEFAULT_TTL_MS,
  UNATTENDED_MAX_TTL_MS,
  type UnattendedPlanDraft,
} from "../../src/renderer/components/settings/unattendedPlanView.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function section(title: string): void {
  console.log(`\n${title}`);
}

const T = UNATTENDED_MAX_TTL_MS;

console.log("unattended-plan-view-smoke");

/* ── 1. 本地预判:一次报全,与签发口同一条界 ── */
section("1. 本地预判");
{
  const empty: UnattendedPlanDraft = { planId: "p1", projectId: "proj", operations: [], ttlMs: UNATTENDED_DEFAULT_TTL_MS, maxCount: 1 };
  const p1 = validateUnattendedDraft(empty, T);
  check("★ 空计划 → no_operations", p1.some((x) => x.code === "no_operations"), p1);

  const blankRow: UnattendedPlanDraft = {
    planId: "p1", projectId: "proj",
    operations: [{ operationId: "op-1", title: "  ", prompt: "", expectedRevision: "" }],
    ttlMs: UNATTENDED_DEFAULT_TTL_MS, maxCount: 1,
  };
  const p2 = validateUnattendedDraft(blankRow, T);
  check("★ 标题与正文都空的操作 → empty_operation", p2.some((x) => x.code === "empty_operation" && x.operationId === "op-1"), p2);
  // 标题填了就合法(正文可空 = 只建会话)。
  const titleOk: UnattendedPlanDraft = { ...blankRow, operations: [{ operationId: "op-1", title: "干活", prompt: "", expectedRevision: "" }] };
  eq("正控:只填标题合法", validateUnattendedDraft(titleOk, T).length, 0);
  const promptOk: UnattendedPlanDraft = { ...blankRow, operations: [{ operationId: "op-1", title: "", prompt: "开始", expectedRevision: "" }] };
  eq("正控:只填首条消息合法", validateUnattendedDraft(promptOk, T).length, 0);

  // maxCount < 条数:一次报全 —— 这条与空行**同时**出现在 problems 里,不是只报第一个。
  const bothBad: UnattendedPlanDraft = {
    planId: "p1", projectId: "proj",
    operations: [
      { operationId: "op-1", title: "", prompt: "", expectedRevision: "" },
      { operationId: "op-2", title: "ok", prompt: "", expectedRevision: "" },
    ],
    ttlMs: UNATTENDED_DEFAULT_TTL_MS, maxCount: 1,
  };
  const p3 = validateUnattendedDraft(bothBad, T);
  check("★ 一次报全:空行与次数不足同时报出", p3.some((x) => x.code === "empty_operation") && p3.some((x) => x.code === "max_count_below_operations"), p3);
  const maxOk = validateUnattendedDraft({ ...bothBad, maxCount: 2, operations: bothBad.operations.map((o) => ({ ...o, title: "t" })) }, T);
  eq("正控:maxCount = 条数 合法", maxOk.length, 0);

  // TTL 越界两侧。
  check("★ TTL=0 → ttl_out_of_range", validateUnattendedDraft({ ...titleOk, ttlMs: 0 }, T).some((x) => x.code === "ttl_out_of_range"));
  check("★ TTL 超 30 分钟 → ttl_out_of_range", validateUnattendedDraft({ ...titleOk, ttlMs: T + 1 }, T).some((x) => x.code === "ttl_out_of_range"));
  eq("正控:TTL = 上限 合法", validateUnattendedDraft({ ...titleOk, ttlMs: T }, T).length, 0);
}

/* ── 2. 批准入参:不含 actor / grantId ── */
section("2. 批准入参的形状(全过时给出)");
{
  const ok: UnattendedPlanDraft = {
    planId: "p1", projectId: "proj",
    operations: [{ operationId: "op-1", title: " 标题 ", prompt: " 正文 ", expectedRevision: "  rev-1  " }],
    ttlMs: UNATTENDED_DEFAULT_TTL_MS, maxCount: 1,
  };
  const input = buildUnattendedApproveInput(ok, T);
  check("★ 预判全过 → 给出入参", input !== null, input);
  if (input !== null) {
    const keys = Object.keys(input);
    check("★ 入参里没有 actor(签发主体只能由宿主写死)", !keys.includes("actor"), keys);
    check("★ 入参里没有 grantId(授权由宿主签发)", !keys.includes("grantId"), keys);
    eq("★ 操作名去空白后原样带上", input.operations[0]?.title, "标题");
    eq("★ expectedRevision 非空才给(去空白)", input.operations[0]?.expectedRevision, "rev-1");
  }
  // 空 revision 不给那个键。
  const noRev = buildUnattendedApproveInput({ ...ok, operations: [{ operationId: "op-1", title: "t", prompt: "", expectedRevision: "   " }] }, T);
  check("★ 空 expectedRevision 不给那个键(空串会被签发口当「对不上」拒)", noRev !== null && !("expectedRevision" in (noRev.operations[0] ?? {})), noRev?.operations[0]);
  // 预判没过 → null(界面据此不发这条)。
  eq("★ 预判没过 → null", buildUnattendedApproveInput({ ...ok, operations: [] }, T), null);
}

/* ── 3. 执行入参:只给 grantId,不给授权内容 ── */
section("3. 执行入参只给 grantId");
{
  const draft: UnattendedPlanDraft = {
    planId: "p1", projectId: "proj",
    operations: [{ operationId: "op-1", title: "t", prompt: "", expectedRevision: "" }],
    ttlMs: UNATTENDED_DEFAULT_TTL_MS, maxCount: 1,
  };
  const input = buildUnattendedRunInput(draft, "grant-x", T);
  check("★ 给出执行入参", input !== null, input);
  if (input !== null) {
    const keys = Object.keys(input);
    eq("★ grantId 原样带上", input.grantId, "grant-x");
    for (const forbidden of ["grant", "scopedCore", "allowedActions", "actor", "actorId"]) {
      check(`★ 入参里没有授权内容字段 ${forbidden}`, !keys.includes(forbidden), keys);
    }
    check("★ 省略 initiatorSessionId 时不给那个键(宿主按 sender 派生)", !keys.includes("initiatorSessionId"), keys);
  }
  const withInit = buildUnattendedRunInput(draft, "grant-x", T, "sess-1");
  eq("★ 给了坐标就原样带上(它只是坐标,宿主会核实)", withInit?.initiatorSessionId, "sess-1");
  // 入参只给 grantId 还不够 —— 计划正文也要与批准时一字不差(执行端按它逐条派发)。
  eq("★ 执行入参的正文与批准入参同源", JSON.stringify(withInit?.operations), JSON.stringify(buildUnattendedApproveInput(draft, T)?.operations));
}

/* ── 4. 状态机:编辑即作废;至少一行 ── */
section("4. 状态机");
{
  let s = initialUnattendedPlanState(1000);
  eq("初始:一行操作", s.operations.length, 1);
  eq("初始:无授权", s.grant, null);
  s = unattendedPlanReducer(s, { type: "granted", grantId: "g1", expiresAt: 999999 });
  eq("批准后持授权", s.grant?.grantId, "g1");

  // 每种正文编辑都作废授权。
  for (const [name, action] of [
    ["改项目", { type: "setProject", projectId: "p9" }],
    ["改标题", { type: "editRow", operationId: "op-1", field: "title", value: "x" }],
    ["加一行", { type: "addRow" }],
    ["改 TTL", { type: "setTtl", ttlMs: 60000 }],
    ["改上限", { type: "setMaxCount", maxCount: 5 }],
  ] as const) {
    const after = unattendedPlanReducer(s, action as never);
    eq(`★ ${name} → 授权作废(计划变了)`, after.grant, null);
  }
  // 删行(两行时)也作废。
  let two = unattendedPlanReducer(s, { type: "addRow" });
  two = unattendedPlanReducer(two, { type: "granted", grantId: "g2", expiresAt: 999999 });
  const afterRemove = unattendedPlanReducer(two, { type: "removeRow", operationId: "op-1" });
  eq("★ 删一行 → 授权作废", afterRemove.grant, null);
  eq("★ 删一行后剩一行", afterRemove.operations.length, 1);
  // 只剩一行时删不动。
  const lastStand = unattendedPlanReducer(afterRemove, { type: "removeRow", operationId: "op-2" });
  eq("★ 最后一行删不掉(空计划签不出)", lastStand.operations.length, 1);
  eq("★ 删不动时不误清授权之外的字段", lastStand.operations[0]?.operationId, "op-2");

  // reset:新计划 id + 空表单。
  const reset = unattendedPlanReducer(s, { type: "reset", now: 2000 });
  check("★ reset 换一个新计划 id", reset.planId !== s.planId, { before: s.planId, after: reset.planId });
  eq("★ reset 清空授权", reset.grant, null);

  // 拒绝进状态。
  const refused = unattendedPlanReducer(s, { type: "approvalRefused", reason: "no" });
  eq("★ 批准被拒 → 不持授权", refused.grant, null);
  eq("★ 批准被拒 → 记下原因", refused.approvalError, "no");
}

/* ── 5. 门控 ── */
section("5. 门控");
{
  let s = initialUnattendedPlanState(1000);
  eq("★ 没选项目 → 不能批准", canApproveUnattended(s), false);
  s = unattendedPlanReducer(s, { type: "setProject", projectId: "proj" });
  s = unattendedPlanReducer(s, { type: "editRow", operationId: "op-1", field: "title", value: "干活" });
  eq("正控:选了项目 + 一行有内容 → 能批准", canApproveUnattended(s), true);
  eq("★ 还没批准 → 不能执行", canRunUnattended(s, 1000), false);
  s = unattendedPlanReducer(s, { type: "granted", grantId: "g1", expiresAt: 5000 });
  eq("已批准未过期 → 能执行", canRunUnattended(s, 1000), true);
  eq("★ 授权过期 → 不能执行", canRunUnattended(s, 6000), false);
}

/* ── 6. 跨重启视图排序 ── */
section("6. 跨重启视图排序");
{
  const plan = (planId: string, kind: "resumable" | "waiting_approval" | "completed", createdAt: number) => ({
    planId, sceneId: "sc", projectId: "p", grantId: "g", operationCount: 3, completedCount: 1,
    remainingOperationIds: [], kind, expiresAt: null, createdAt, lastStoppedAt: null, lastStopCode: null,
  });
  const sorted = sortPendingPlans([plan("c", "completed", 3), plan("w", "waiting_approval", 2), plan("r", "resumable", 1)]);
  eq("★ 可续跑的排最前(有事可做的先看见)", sorted[0]?.planId, "r");
  eq("★ 等待批准居中", sorted[1]?.planId, "w");
  eq("★ 已完成最后", sorted[2]?.planId, "c");
  const sameKind = sortPendingPlans([plan("old", "resumable", 1), plan("new", "resumable", 2)]);
  eq("★ 同档按创建时间新在前", sameKind[0]?.planId, "new");
}

/* ── 7. id 生成:去重 ── */
section("7. 计划 id");
{
  const a = newUnattendedPlanId(1000);
  const b = newUnattendedPlanId(1000);
  check("★ 同一毫秒两次生成也不同(序号后缀)", a !== b, { a, b });
  check("★ 形如 unattended-…", a.startsWith("unattended-"), a);
}

/* ── 8. 接线不变量(源码正则 backstop) ── */
section("8. 面板真的接上入口 + 挂进设置页(只声明不接线 = 用户点不到)");
{
  const panel = readFileSync(join(process.cwd(), "src/renderer/components/settings/UnattendedPlanPanel.tsx"), "utf8");
  check("★ 面板调 unattendedPlans.list(且经 useRpc —— 读数据走统一读钩子)", panel.includes("api.unattendedPlans.list()") && panel.includes("useRpc("), panel.match(/.*unattendedPlans\.list.*/g)?.slice(0, 2));
  check("★ 面板调 unattended.approve(显式 await,写操作)", /await api\.unattended\.approve\(/.test(panel), panel.match(/.*unattended\.approve\(.*/g)?.slice(0, 2));
  check("★ 面板调 unattended.run(显式 await,写操作)", /await api\.unattended\.run\(/.test(panel), panel.match(/.*unattended\.run\(.*/g)?.slice(0, 2));
  check("★ 面板调 unattendedPlans.resume / abandon(跨重启治理动作)", /await api\.unattendedPlans\.resume\(/.test(panel) && /await api\.unattendedPlans\.abandon\(/.test(panel));
  check("★ 面板用状态机(dispatch + canApproveUnattended/canRunUnattended 门控)", panel.includes("unattendedPlanReducer") && panel.includes("canApproveUnattended(") && panel.includes("canRunUnattended("));
  check("★ 面板用两个 build…Input 构造入参", panel.includes("buildUnattendedApproveInput(") && panel.includes("buildUnattendedRunInput("));
  // 【MC-001 系统性修复第 3 条】与场景部署共用同一个动作栏组件。
  check("★ 无人值守面板用共享 PlanApprovalBar(不另写一份)", /<PlanApprovalBar[\s/>]/.test(panel) && panel.includes("unattended-plan-approval-bar"));
  check("★ 无人值守面板的门控仍由自己给(共享组件只做展示)", panel.includes("canApproveUnattended(state)") && panel.includes("canRunUnattended(state)"));

  const governance = readFileSync(join(process.cwd(), "src/renderer/components/settings/GovernancePanel.tsx"), "utf8");
  // ⚠️ 判据必须落在**渲染调用**上,不是"文件里出现过这个名字" —— 后者在把渲染注释/短路掉
  // 之后仍然命中(变异实测:换成 `: null` 后 includes 照旧为真)。正则要求 JSX 元素真的在。
  check("★ GovernancePanel 真的渲染 UnattendedPlanPanel(中间没有断链)", /<UnattendedPlanPanel\s*\/>/.test(governance), governance.match(/.*UnattendedPlanPanel.*/g)?.slice(0, 2));
  const settingsPage = readFileSync(join(process.cwd(), "src/renderer/components/settings/SettingsPage.tsx"), "utf8");
  check("★ 治理视图真的被渲染(scene-deploy 一节挂上组件)", /active === "scene-deploy"\s*&&\s*<GovernancePanel\s*\/>/.test(settingsPage), settingsPage.match(/.*GovernancePanel.*/g)?.slice(0, 2));

  // 主进程侧:两条写通道真的钉在 blocked(与 scene.approve/apply 同一条纪律)。
  const policy = readFileSync(join(process.cwd(), "src/main/appControl/policy.ts"), "utf8");
  for (const m of ["unattended.approve", "unattended.run", "unattendedPlans.resume", "unattendedPlans.abandon"]) {
    check(`★ policy 钉 ${m} = blocked(agent 够不到)`, new RegExp(`"${m.replace(".", "\\.")}":\\s*"`).test(policy), m);
  }
}

console.log(`\nunattended-plan-view-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
