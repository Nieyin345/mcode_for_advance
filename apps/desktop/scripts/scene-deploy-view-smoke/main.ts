/**
 * 场景部署**渲染端**的回归网(MC-058 残余 —— 之前三层 IPC 打通了,渲染端一个按钮都没有)。
 *
 * 被测:`src/renderer/components/settings/sceneDeployView.ts` —— 「粘贴一份 SceneSpec →
 * 预览 → 批准 → 部署」这条链的**视图模型 + 状态机**,全是纯函数。
 *
 * ## 它钉死的判据(每条都对应一个"看着对、其实错"的坑)
 *
 *  1. **批准绑的是哪一份计划**:`buildSceneApprovalInput` 的 `planDigest` **取自当前预览**,不是
 *     现算。恒等断言不够 —— 用**两份不同的 spec** 造 discriminate:state 里挂 specA 的预览,
 *     却把 specB 递进去;若实现"现算 digest"会得到 B 的,而正确答案是 A 的(用户看过的)。
 *  2. **编辑即作废**:`edit` 清掉 preview / grant / apply —— 界面必须收回「部署」,不让用户拿一枚
 *     绑旧计划的授权去撞 `plan_mismatch`。
 *  3. **新预览作废旧授权**:`previewed` 清掉 grant。
 *  4. **未预览不许批准 / 未批准不许部署**:`granted` 无预览时不生效;`buildSceneApplyInput` 无 grant 时
 *     返回 null。
 *  5. **部署只给 grantId**:`buildSceneApplyInput` 的键里**不得**出现授权内容(`grant` / `scopedCore`…)。
 *  6. **静态预判与主进程 dryRunScene 同判据**:`buildScenePreview` 对 plugin 步判 `willRun=false`
 *     (needsResolution),对依赖的步传递。
 *  7. **两半合并**:`mergePreviewWithPlan` 以 IPC wire 为准取展示字段、以本地预判取 willRun;
 *     digest 不一致时显式标出(不静默)。
 *
 * ## 静态 backstop(源码正则)
 *
 *  面板真的**接了**四条入口(`scene.preflight` 走 useRpc、`scene.approve` / `scene.apply` 显式
 *  `await`)、真的被挂进 `SettingsPage`。只声明不接线 = 台账判过的"形式上的 IPC 入口 ≠ 用户能点"。
 *
 * Run: scripts/scene-deploy-view-smoke/run.sh
 */
import {
  buildSceneApprovalInput,
  buildSceneApplyInput,
  buildScenePreview,
  canApprove,
  canDeploy,
  canPreview,
  canResume,
  INITIAL_SCENE_DEPLOY_STATE,
  mergePreviewWithPlan,
  newDeploymentId,
  parseSceneSpecText,
  SCENE_APPROVAL_TTL_MS,
  sceneDeployReducer,
  sceneDeployStage,
  restoreFromDeployment,
  type SceneDeployState,
} from "../../src/renderer/components/settings/sceneDeployView.js";
import { SCENE_SPEC_SCHEMA_VERSION, type SceneSpec } from "@contracts/sceneSpec";

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
function section(t: string): void {
  console.log(`\n${t}`);
}

/* ───────────────────────── 夹具 ───────────────────────── */

/** 一条合法的 workflow 资源声明正文(真实 WorkflowDoc 形状,过得了载荷投影)。 */
function wfDoc(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, nodes: [], edges: [], builtin: false, updatedAt: 1, ...extra };
}

/** 造一份合法 spec,资源由调用方给。 */
function specWith(
  sceneId: string,
  resources: SceneSpec["resources"],
  expect: string[],
): Record<string, unknown> {
  return {
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId,
    goal: "每天检查代码、执行测试,失败后通知我",
    capabilities: [],
    resources,
    acceptance: { description: "资源都可见", expectResourceIds: expect },
  };
}

/** 一份简单两资源 spec(工作流 + 依赖它的自动化)。 */
function twoResSpec(): Record<string, unknown> {
  return specWith(
    "scene_a",
    [
      { kind: "workflow", id: "wf", spec: wfDoc("wf") },
      { kind: "automation", id: "auto", spec: wfDoc("auto", { trigger: "schedule" }), dependsOn: ["wf"] },
    ],
    ["wf", "auto"],
  );
}

/** 一份含 plugin 资源的 spec —— plugin 无单条确定入口 → 静态判 willRun=false。 */
function pluginSpec(): Record<string, unknown> {
  return specWith(
    "scene_p",
    [{ kind: "plugin", id: "plug", spec: { source: "…" } }],
    ["plug"],
  );
}

/* ───────────────────────── 1. 文本解析 ───────────────────────── */

section("1. parseSceneSpecText:空 / JSON 坏 / 合法");

{
  eq("空文本 → code=empty", (parseSceneSpecText("   \n  ") as { code: string }).code, "empty");
  const bad = parseSceneSpecText("{ not json");
  check("坏 JSON → ok:false, code=parse", bad.ok === false && bad.code === "parse", bad);
  const good = parseSceneSpecText(JSON.stringify(twoResSpec()));
  check("合法 JSON → ok:true", good.ok === true, good);
  if (good.ok) eq("…解析出的是对象", typeof good.spec, "object");
}

/* ───────────────────────── 2. 静态预判(willRun) ───────────────────────── */

section("2. buildScenePreview:哪几步会跑(与主进程 dryRunScene 同判据)");

{
  const r = buildScenePreview(twoResSpec());
  check("合法两资源 spec → ok:true", r.ok === true, r);
  if (r.ok) {
    eq("两步(计划顺序)", r.steps.length, 2);
    eq("第一步是工作流(拓扑序)", r.steps[0]?.actionId, "wf");
    check("两步都会跑(无 needsResolution)", r.steps.every((s) => s.willRun), r.steps);
    eq("工作流步的服务标签是 workflow.save", r.steps[0]?.serviceLabel, "workflow.save");
    check("会跑的步 holdReason 为 null", r.steps[0]?.holdReason === null, r.steps[0]?.holdReason);
  }
}

{
  const r = buildScenePreview(pluginSpec());
  check("plugin spec 仍 ok:true(合法,只是这步不跑)", r.ok === true, r);
  if (r.ok) {
    eq("一步", r.steps.length, 1);
    eq("★ plugin 步静态判定不会跑", r.steps[0]?.willRun, false);
    eq("…原因是 needsResolution", r.steps[0]?.holdReason?.code, "needsResolution");
    eq("…但它在 unresolved 语义里仍是 needsResolution=true", r.steps[0]?.needsResolution, true);
  }
}

{
  const bad = buildScenePreview({ schemaVersion: 99, sceneId: "BAD ID" });
  check("不合法 spec → ok:false", bad.ok === false, bad);
  if (!bad.ok) check("一次报出多个问题(不是报第一个就停)", bad.problems.length >= 2, bad.problems);
}

/* ───────────────────────── 3. 状态机:编辑作废 / 新预览作废授权 ───────────────────────── */

section("3. 状态机:edit 作废预览与授权,previewed 作废 grant");

{
  const previewA = buildScenePreview(twoResSpec());
  let s: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: JSON.stringify(twoResSpec()) };
  s = sceneDeployReducer(s, { type: "previewed", result: previewA });
  eq("预览后有 deploymentId", s.deploymentId !== null, true);
  eq("预览后阶段 = previewed", sceneDeployStage(s), "previewed");

  s = sceneDeployReducer(s, { type: "granted", grantId: "g-1", expiresAt: Date.now() + 60000 });
  eq("批准后阶段 = approved", sceneDeployStage(s), "approved");
  eq("…授权绑的计划摘要 = 预览的 planDigest", s.grant?.planDigest, previewA.ok ? previewA.planDigest : "×");

  // ★ 编辑即作废:预览与授权都清掉,阶段回到 empty。
  const edited = sceneDeployReducer(s, { type: "edit", text: s.specText + " " });
  eq("★ 编辑后预览被清", edited.preview, null);
  eq("★ 编辑后授权被清", edited.grant, null);
  eq("★ 编辑后阶段回到 empty", sceneDeployStage(edited), "empty");
  check("★ 编辑后 canDeploy 为假(按钮收回)", canDeploy(edited) === false);
}

{
  // 新预览作废旧授权(新计划 ≠ 旧计划)。
  const previewA = buildScenePreview(twoResSpec());
  let s: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "x" };
  s = sceneDeployReducer(s, { type: "previewed", result: previewA });
  s = sceneDeployReducer(s, { type: "granted", grantId: "g-1", expiresAt: Date.now() + 60000 });
  eq("先有授权", s.grant !== null, true);
  s = sceneDeployReducer(s, { type: "previewed", result: previewA });
  eq("★ 再预览一次 → 旧授权被清(新计划作废旧授权)", s.grant, null);
}

/* ───────────────────────── 4. 未预览不许批准 / 未批准不许部署 ───────────────────────── */

section("4. 门控:未预览不许批准,未批准不许部署");

{
  const s0 = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "{}" };
  eq("空状态:canPreview 假(空文本)", canPreview({ ...INITIAL_SCENE_DEPLOY_STATE, specText: "  " }), false);
  eq("空状态:canApprove 假", canApprove(s0), false);
  eq("空状态:canDeploy 假", canDeploy(s0), false);

  // ★ granted 在无预览时不生效(状态层兜底)。
  const grantedNoPreview = sceneDeployReducer(s0, { type: "granted", grantId: "g-x", expiresAt: 1 });
  eq("★ 无预览时 granted 不生效(grant 仍为 null)", grantedNoPreview.grant, null);
}

{
  const previewA = buildScenePreview(twoResSpec());
  let s: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "x" };
  s = sceneDeployReducer(s, { type: "previewed", result: previewA });
  eq("预览成功后 canApprove 真", canApprove(s), true);
  eq("★ 预览成功但未批准时 canDeploy 假", canDeploy(s), false);
  s = sceneDeployReducer(s, { type: "granted", grantId: "g-1", expiresAt: Date.now() + 60000 });
  eq("批准后 canDeploy 真", canDeploy(s), true);
}

{
  // 声明不合法时不许批准。
  const badPreview = buildScenePreview({ schemaVersion: 99 });
  let s: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "x" };
  s = sceneDeployReducer(s, { type: "previewed", result: badPreview });
  eq("不合法预览阶段 = invalid", sceneDeployStage(s), "invalid");
  eq("★ 不合法时 canApprove 假(不给骗人的批准按钮)", canApprove(s), false);
}

/* ───────────────────────── 5. 批准入参:planDigest 取自预览(★ discriminate) ───────────────────────── */

section("5. buildSceneApprovalInput:批准绑的是用户看过的那一份计划");

{
  const previewA = buildScenePreview(twoResSpec());
  const previewB = buildScenePreview(pluginSpec());
  check("两份 spec 的计划摘要不同(夹具有效)", previewA.ok && previewB.ok && previewA.planDigest !== previewB.planDigest, {
    a: previewA.ok ? previewA.planDigest : null,
    b: previewB.ok ? previewB.planDigest : null,
  });
  if (previewA.ok && previewB.ok) {
    // state 里挂的是 A 的预览;把 B 的 spec 递进去。
    const s: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "x", deploymentId: "dep-1", preview: previewA };
    const input = buildSceneApprovalInput(pluginSpec() /* = B */, s);
    check("有预览 → 返回入参", input !== null, input);
    // ★ 关键:planDigest 必须是 A 的(用户看过的),不是现算 B 的。
    eq("★★ planDigest 取自预览(A),不是现算递进来的 spec(B)", input?.planDigest, previewA.planDigest);
    check("★★ 且**不**等于 B 的摘要(证明没现算)", input?.planDigest !== previewB.planDigest, {
      got: input?.planDigest,
      bDigest: previewB.planDigest,
    });
    eq("ttlMs 默认 = SCENE_APPROVAL_TTL_MS(10 分钟)", input?.ttlMs, SCENE_APPROVAL_TTL_MS);
    eq("deploymentId 取自 state(同一次部署)", input?.deploymentId, "dep-1");
  }
}

{
  // 无预览 → null(不该发这条)。
  const s: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "x" };
  eq("无预览 → buildSceneApprovalInput 返回 null", buildSceneApprovalInput(twoResSpec(), s), null);
}

/* ───────────────────────── 6. 部署入参:只给 grantId,不给授权内容 ───────────────────────── */

section("6. buildSceneApplyInput:只递 grantId(授权内容由宿主取回)");

{
  const previewA = buildScenePreview(twoResSpec());
  let s: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "x", deploymentId: "dep-1", preview: previewA };
  s = sceneDeployReducer(s, { type: "granted", grantId: "g-42", expiresAt: Date.now() + 60000 });
  const input = buildSceneApplyInput(twoResSpec(), s);
  check("有 grant → 返回入参", input !== null, input);
  eq("★ deploymentId 复用批准时那个(同一次部署)", input?.deploymentId, "dep-1");
  eq("★ grantId 原样带上", input?.grantId, "g-42");
  eq("actorKind = user", input?.actorKind, "user");
  eq("actorId = desktop", input?.actorId, "desktop");
  // ★ schema 里**不得**出现授权内容字段 —— 多带一个 grant 就是绕过授权判定。
  const keys = input === null ? [] : Object.keys(input).sort();
  check(
    "★★ 入参不含任何授权内容字段(grant/scopedCore/allowedActions/approvalSource/expiresAt)",
    ["grant", "scopedCore", "allowedActions", "approvalSource", "expiresAt"].every((k) => !keys.includes(k)),
    keys,
  );
}

{
  // 无 grant → null。
  const previewA = buildScenePreview(twoResSpec());
  const s: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "x", deploymentId: "dep-1", preview: previewA };
  eq("无授权 → buildSceneApplyInput 返回 null(未批准不许部署)", buildSceneApplyInput(twoResSpec(), s), null);
}

/* ───────────────────────── 7. mergePreviewWithPlan ───────────────────────── */

section("7. mergePreviewWithPlan:以 IPC 计划为准取展示字段,以本地预判取 willRun");

{
  const local = buildScenePreview(pluginSpec());
  check("本地预览成功", local.ok === true, local);
  if (local.ok) {
    // 造一份"宿主返回的" wire 计划:形状与本地一致(同 actionId),但多一个 step 来验证"以 IPC 为准"。
    const wire = {
      sceneId: "scene_p",
      specDigest: "sd",
      digest: local.planDigest, // 摘要一致 —— 不触发 mismatch
      steps: [
        { actionId: "plug", resourceId: "plug", kind: "plugin", order: 0, dependsOn: [], compensable: true, verifier: { kind: "exists" as const, resourceId: "plug" } },
      ],
    };
    const merged = mergePreviewWithPlan(local, wire);
    eq("摘要一致 → digestMismatch 假", merged.digestMismatch, false);
    eq("planDigest 取自 wire", merged.planDigest, local.planDigest);
    eq("步骤数取 wire", merged.steps.length, 1);
    eq("★ willRun 取自本地预判(plugin → false)", merged.steps[0]?.willRun, false);
    eq("…holdReason 也来自本地", merged.steps[0]?.holdReason?.code, "needsResolution");

    // 摘要不一致 → 显式标出(不静默)。
    const wire2 = { ...wire, digest: "different" };
    const merged2 = mergePreviewWithPlan(local, wire2);
    eq("★★ 摘要不一致 → digestMismatch 真(不静默)", merged2.digestMismatch, true);
    eq("…planDigest 仍取 wire(以宿主为准)", merged2.planDigest, "different");
  }
}

/* ───────────────────────── 8. deploymentId 生成 / TTL 常量 ───────────────────────── */

section("8. newDeploymentId 唯一 + TTL 常量");

{
  const a = newDeploymentId();
  const b = newDeploymentId();
  check("两次生成不同", a !== b, [a, b]);
  check("前缀 scene-deploy-", a.startsWith("scene-deploy-"), a);
  eq("TTL = 10 分钟", SCENE_APPROVAL_TTL_MS, 600000);
}

/* ───────────────────────── 8b. 【MC-002】重启后从盘上记录恢复声明 ───────────────────────── */

section("8b. restoreFromDeployment + restored:发现 → 选择 → 只还原输入,不还原授权");

{
  const snapshotEntry = {
    deployment: {
      deploymentId: "dep_r1",
      sceneId: "scene_a",
      specDigest: "x",
      planDigest: "y",
      actor: { actorKind: "user" as const, actorId: "desktop" },
      createdAt: 1,
      status: "partial" as const,
      steps: [],
      acceptance: null,
      specSnapshot: { spec: twoResSpec(), specDigest: "x" },
    },
  };
  const restored = restoreFromDeployment(snapshotEntry);
  check("★ 有快照 → 恢复出可解析的声明文本", restored !== null && parseSceneSpecText(restored.specText).ok, restored);
  if (restored !== null) {
    const parsed = parseSceneSpecText(restored.specText);
    eq("…恢复的声明就是当初那份(sceneId 相同)", parsed.ok ? (parsed.spec as { sceneId: string }).sceneId : null, "scene_a");
  }
  eq("没有快照的旧记录 → null(不猜)", restoreFromDeployment({ deployment: { ...snapshotEntry.deployment, specSnapshot: undefined } }), null);
  eq("记录读不回来(deployment=null) → null", restoreFromDeployment({ deployment: null }), null);

  // 状态机:restored 只保留 specText + deploymentId,预览/授权/结局全部为空。
  const after = sceneDeployReducer(INITIAL_SCENE_DEPLOY_STATE, { type: "restored", text: "{}", deploymentId: "dep_r1", resumable: true });
  eq("restored 保留盘上的 deploymentId(续跑必须复用同一次部署)", after.deploymentId, "dep_r1");
  eq("restored 不恢复预览(必须重新预览)", after.preview, null);
  eq("restored 不恢复授权(必须重新批准)", after.grant, null);
  eq("restored 不恢复部署结局", after.apply, null);
  check("restored 之后 canDeploy 为假(没有授权)", !canDeploy(after));
  // 【MC-002 真 Electron 验收】恢复一条**可续跑**记录后,重新预览 + 批准必须让
  // `canResume` 为真 —— 否则「续跑剩余步骤」不出现,用户唯一能点的「部署」会以全
  // pending 重跑已完成的步(真 Electron 套件 `scene-deploy-electron-smoke` 的 ⑧⑩ 钉住)。
  {
    const preview = buildScenePreview(twoResSpec());
    let s: SceneDeployState = { ...after, specText: "x", deploymentId: "dep_r1" };
    s = sceneDeployReducer(s, { type: "previewed", result: preview });
    check("恢复后未批准:canResume 仍为假(恢复不是授权)", !canResume(s));
    s = sceneDeployReducer(s, { type: "granted", grantId: "g-1", expiresAt: Date.now() + 60000 });
    check("恢复 + 重新预览 + 批准后:canResume 为真(续跑按钮才会出现)", canResume(s));
    const plain: SceneDeployState = { ...INITIAL_SCENE_DEPLOY_STATE, specText: "x" };
    let p: SceneDeployState = sceneDeployReducer(plain, { type: "previewed", result: preview });
    p = sceneDeployReducer(p, { type: "granted", grantId: "g-1", expiresAt: Date.now() + 60000 });
    check("对照:从未恢复过的普通新部署,批准后 canResume 仍为假", !canResume(p));
    // `edit` / `reset` 会清掉恢复标记(换了声明就不再是盘上那条记录)。
    eq("编辑后 restoredResumable 清空", sceneDeployReducer(s, { type: "edit", text: "y" }).restoredResumable, false);
    eq("reset 后 restoredResumable 清空", sceneDeployReducer(s, { type: "reset" }).restoredResumable, false);
    // 恢复一条**不可续跑**记录(坏存档行)不会让续跑按钮出现。
    const notResumable = sceneDeployReducer(INITIAL_SCENE_DEPLOY_STATE, { type: "restored", text: "{}", deploymentId: "dep_bad", resumable: false });
    let n: SceneDeployState = sceneDeployReducer({ ...notResumable, specText: "x" }, { type: "previewed", result: preview });
    n = sceneDeployReducer(n, { type: "granted", grantId: "g-2", expiresAt: Date.now() + 60000 });
    check("恢复一条不可续跑记录,批准后 canResume 仍为假", !canResume(n));
  }
}

/* ───────────────────────── 9. 接线不变量(源码正则 backstop) ───────────────────────── */

section("9. 面板真的接上四条入口 + 挂进设置页(只声明不接线 = 用户点不到)");

{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const panel = readFileSync(join(process.cwd(), "src/renderer/components/settings/SceneDeployPanel.tsx"), "utf8");
  check("★ 面板调 scene.preflight(且经 useRpc —— 读数据走统一读钩子)", panel.includes("api.scene.preflight(") && panel.includes("useRpc("), panel.match(/api\.scene\.preflight\([^\n]*/)?.[0]);
  check("★ 面板调 scene.approve(显式 await,写操作)", /await api\.scene\.approve\(/.test(panel), panel.match(/scene\.approve\([^\n]*/)?.[0]);
  check("★ 面板调 scene.apply(显式 await,写操作)", /await api\.scene\.apply\(/.test(panel), panel.match(/scene\.apply\([^\n]*/)?.[0]);
  check("★ 面板用状态机(dispatch + canApprove/canDeploy 门控)", panel.includes("sceneDeployReducer") && panel.includes("canApprove(") && panel.includes("canDeploy("));
  check("★ 面板用 buildSceneApprovalInput / buildSceneApplyInput 构造入参", panel.includes("buildSceneApprovalInput(") && panel.includes("buildSceneApplyInput("));
  // 【MC-002】重启后发现未完成部署:列表读通道真的接上(且是读 → useRpc),恢复动作真的存在。
  check("★ 面板经 useRpc 调 scene.listDeployments(重启后发现入口)", panel.includes("api.scene.listDeployments(") && panel.includes("useRpc("));
  // 【MC-002 第十七轮】崩溃后**从零发现**:面板不能只在"输入框已有 sceneId"时才查 ——
  // 那时用户手里什么都没有。无 sceneId 时必须走跨场景的 resumableOnly 查询。
  check("★ 无 sceneId 时跨场景列出可续跑记录(从零发现)",
    panel.includes("api.scene.listDeployments({ resumableOnly: true })"), panel.match(/resumableOnly[^)]*/)?.[0]);
  check("★ 列表查询不再以 sceneId 为前提(旧实现的 enabled 门控已移除)",
    !panel.includes("enabled: sceneIdForList !== null"));
  // 【MC-002 假绿修复(变异发现)】上面两条只钉了**查询参数**:把整段「未完成的部署」
  // 重新包回 `{sceneIdForList !== null && (...)}` —— 查询照发、区块不渲染,正是真
  // Electron 验收暴露的断点 —— 91/91 依然全绿。渲染点本身必须被钉住:空输入框(崩溃
  // 重启后的真实起点)下这块要么渲染列表、要么渲染空态文案,不能整个消失。
  const panelCode = panel.replace(/\/\*[\s\S]*?\*\//g, "");
  check("★ 「未完成的部署」区块的渲染不以 sceneId 为条件(空输入框的崩溃起点也看得到)",
    panelCode.includes('data-testid="scene-unfinished"')
      && !/\{\s*sceneIdForList\b[^}]*&&\s*\(?\s*<section\b[^>]*data-testid="scene-unfinished"/.test(panelCode),
    panelCode.match(/sceneIdForList[^\n]*/g)?.slice(0, 3));
  check("★ 面板把记录恢复成输入(restoreFromDeployment + restored 动作)", panel.includes("restoreFromDeployment(") && panel.includes('type: "restored"'));
  // 【MC-001 系统性修复第 3 条】场景与无人值守共用**同一个**「预览 → 批准 → 执行」动作栏,
  // 不再各写一份。判据落在 `PlanApprovalBar` 真的被渲染 + 两族面板各自传给它的 testId 上。
  check("★ 场景面板用共享 PlanApprovalBar 渲染批准/执行动作栏(不另写一份)", /<PlanApprovalBar[\s/>]/.test(panel) && panel.includes("scene-deploy-approval-bar"));
  check("★ 场景面板的门控与执行仍由自己给(共享组件只做展示)", panel.includes("canApprove(state)") && panel.includes("canDeploy(state)"));

  const settingsPage = readFileSync(join(process.cwd(), "src/renderer/components/settings/SettingsPage.tsx"), "utf8");
  // 【MC-001】面板自 MC-001 起经 `GovernancePanel`(场景部署 + 无人值守两半的子页签壳)
  // 挂进设置页 —— 声明链变成 SettingsPage → GovernancePanel → SceneDeployPanel,三段都要接上。
  const governance = readFileSync(join(process.cwd(), "src/renderer/components/settings/GovernancePanel.tsx"), "utf8");
  check("★ SettingsPage 声明了 GovernancePanel 的懒加载 loader", /GovernancePanel:\s*\(\)\s*=>\s*import\("\.\/GovernancePanel\.js"\)/.test(settingsPage), settingsPage.match(/.*GovernancePanel.*/g)?.slice(0, 2));
  check(
    "★ 治理视图真的被渲染(scene-deploy 一节挂上组件)",
    /active === "scene-deploy"\s*&&\s*<GovernancePanel\s*\/>/.test(settingsPage),
    settingsPage.match(/.*GovernancePanel.*/g)?.slice(0, 3),
  );
  check("★ GovernancePanel 真的渲染 SceneDeployPanel(没有中间断链)", governance.includes("SceneDeployPanel"), governance.match(/.*SceneDeployPanel.*/g)?.slice(0, 2));
  check("★ 导航里有一项指向它(sceneDeploy.nav)", settingsPage.includes('"sceneDeploy.nav"'), settingsPage.match(/.*sceneDeploy\.nav.*/g)?.slice(0, 2));
}

console.log(`\nscene-deploy-view-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
